/**
 * WebGPU rendering path: arbitrary-precision reference orbit on the GPU, then
 * a perturbation compute pass whose per-pixel deltas carry their own exponent.
 *
 * Unlike the WebGL path there is no f32 underflow floor, so zoom depth is
 * bounded by the precision profile (limb count) rather than by the renderer.
 */

import Decimal from "decimal.js";
import { compileShader, readBuffer, storageBuffer, type GpuContext } from "../gpu/device";
import bigfixedSource from "../gpu/shaders/bigfixed.wgsl?raw";
import orbitBindings from "../gpu/shaders/orbit-bindings.wgsl?raw";
import orbitSource from "../gpu/shaders/orbit.wgsl?raw";
import compensatedSource from "../arithmetic/compensated.wgsl?raw";
import quadSource from "../arithmetic/quad.wgsl?raw";
import perturbationSource from "./perturbation.wgsl?raw";
import juliaSource from "./julia.wgsl?raw";
import { fixedToQuad, splitQuad } from "../arithmetic/quad";
import { reprojectionFor } from "./reprojection";

/**
 * Rows per dispatch, and a ceiling on how many dispatches a frame is split
 * into. Smaller bands abandon sooner but cost more submits. Measured at
 * 720x480 and 1e-25, 7 runs each with the orbit warm:
 *
 *   1 band 215ms, 2 bands 218ms, 4 bands 223ms, 8 bands 254ms
 *
 * Four is the corner: 3.6% to be able to drop three quarters of a frame the
 * user has already zoomed past.
 */
const TILE_ROWS = 64;
const MAX_TILES = 4;

/**
 * Hands control back to the event loop for one turn. setTimeout is clamped to
 * 4ms once nested, which is most of a band's budget, so use a message channel.
 */
const yieldChannel = new MessageChannel();
const yieldWaiters: Array<() => void> = [];
yieldChannel.port1.onmessage = () => yieldWaiters.shift()?.();
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => {
    yieldWaiters.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

/** No scaling, no offset: show the frame exactly as rendered. */
const IDENTITY_XFORM = new Float32Array([1, 1, 0, 0]);
import { hexToRgb, MAX_STOPS, type ColorSettings } from "../logic/colorSettings";
import { parseFixed, fixedToHdr } from "../arithmetic/types";
import { BASE_STEP, ENTRY_FLOATS, buildBla } from "./bla";

const orbitModule = [orbitBindings, bigfixedSource, orbitSource].join("\n");

/** Precision profiles, chosen from the zoom depth. */
const LIMB_PROFILES = [8, 16, 32, 64, 128, 256] as const;

/**
 * Reference-orbit iterations per dispatch. Each batch costs one small status
 * readback, so larger batches mean fewer CPU round trips; keep it bounded so a
 * single submission stays responsive.
 */
const ORBIT_BATCH = 128;

/**
 * Dispatches encoded into one submission. Bounded so a single submission stays
 * short enough not to trip a device watchdog on a slow GPU.
 */
const DISPATCHES_PER_SUBMIT = 4;

/**
 * How long one submission should aim to take.
 *
 * A GPU command that runs too long is killed by the driver's watchdog, which
 * takes the WebGPU device and the tab with it. The work per submission is not
 * predictable in advance -- it scales with the limb count, the iteration
 * count and the hardware -- so both loops below measure what they just did
 * and size the next piece from it.
 */
const SUBMIT_BUDGET_MS = 8;

export interface RenderRequest {
  centerX: Decimal;
  centerY: Decimal;
  family?: "mandelbrot" | "julia";
  juliaX?: Decimal;
  juliaY?: Decimal;
  isCurrent?: () => boolean;
  /** Complex units per device pixel. */
  unitsPerPixel: Decimal;
  width: number;
  height: number;
  maxIterations: number;
  colors: ColorSettings;
  /** Set false to bypass linear approximation, for A/B comparison. */
  useApprox?: boolean;
  /** Forces an iteration method instead of picking one from the zoom. */
  forceMethod?: Method;
  /** Overrides the band height, for measuring the cost of splitting a frame. */
  tileRows?: number;
  /** True while panning or zooming: reuse the reference orbit rather than
   * rebuilding it, which is the main source of stutter during a gesture. */
  interacting?: boolean;
}

export interface RenderStats {
  completed: boolean;
  computed: boolean;
  limbs: number;
  decimalDigits: number;
  orbitLength: number;
  orbitEscaped: boolean;
  orbitMs: number;
  /** Time spent building the skip table on the CPU. */
  tableMs: number;
  /** Which per-pixel iteration ran. */
  method: Method;
  renderMs: number;
  /** Reference iterations skipped by linear approximation, per frame. */
  skippedIterations: number;
  /** Linear-approximation steps taken. */
  approxSteps: number;
  /** Reference rebases — the glitch-avoidance path. */
  rebases: number;
  /** Iterations that ran the full perturbation step. */
  plainIterations: number;
  /** Fraction of iterations avoided by approximation, 0..1. */
  skipRatio: number;
  /**
   * Fraction of samples that used the whole iteration budget, 0..1. Includes
   * genuine interior, so it is only meaningful compared against the same view
   * rendered at a different budget.
   */
  cappedRatio: number;
}

/** Which per-pixel iteration the shader should run. Must match perturbation.wgsl. */
export const enum Method {
  /** Plain f32 z <- z^2 + c. No reference orbit. */
  Direct = 0,
  /** Perturbation with a plain f32 delta. */
  Plain = 1,
  /** Perturbation with an explicit exponent on the delta. */
  Hdr = 2,
}

/**
 * Picks the cheapest iteration that is still exact at this zoom.
 *
 * f32 resolves about 6e-8 near |c| ~ 1, so direct iteration holds while the
 * pixel spacing stays a few hundred times coarser than that. Below it the
 * delta needs a reference orbit, but it still fits in a plain f32 until it
 * approaches the smallest normal at 1.2e-38; only past that does it need its
 * own exponent.
 *
 * Measured at 720x480 on an M-series GPU, render time only:
 *
 *   units/pixel   direct   plain   hdr+approx
 *   4e-3            15ms    ---      39ms + 37ms orbit
 *   1e-11           ---   25ms      90ms
 *   2e-21           ---  132ms     193ms
 *   1e-28           ---  253ms     228ms
 *
 * So the plain delta wins by 1.5-3.7x over most of the useful range and only
 * loses once the skip table starts carrying the frame. The handover at 1e-25
 * is both where that happens and a safe distance above the f32 floor.
 */
export function methodForScale(unitsPerPixel: Decimal): Method {
  const upp = unitsPerPixel.toNumber();
  if (upp > 1e-5) return Method.Direct;
  if (upp > 1e-25) return Method.Plain;
  return Method.Hdr;
}

/**
 * Picks a limb count with enough fractional bits to resolve one pixel, plus a
 * safety margin. `unitsPerPixel` of 1e-40 needs ~133 bits before margin.
 */
export function limbsForScale(unitsPerPixel: Decimal, mantissaBits = 48): number {
  const decimals = Math.max(0, -unitsPerPixel.e);
  // Resolve the pixel displacement plus its mantissa and the existing guard.
  const bitsNeeded = decimals * Math.LOG2E * Math.LN10 + mantissaBits + 16;
  for (const limbs of LIMB_PROFILES) {
    if (32 * (limbs - 1) >= bitsNeeded) return limbs;
  }
  throw new Error("This view exceeds the current GPU precision profiles.");
}

/** Splits a Decimal into an f32 mantissa and a binary exponent. */
function splitExponent(value: Decimal): { mantissa: number; exponent: number } {
  if (value.isZero()) return { mantissa: 0, exponent: 0 };
  const exponent = Math.floor(Number(value.abs().log(2).toFixed(6)));
  const mantissa = Number(value.div(new Decimal(2).pow(exponent)).toFixed(12));
  return { mantissa, exponent };
}

/**
 * Splits a complex offset into two mantissas sharing one exponent, which is
 * what the shader's Hdr type expects.
 */
function splitComplex(x: Decimal, y: Decimal) {
  const magnitude = Decimal.max(x.abs(), y.abs());
  if (magnitude.isZero()) return { x: 0, y: 0, exponent: 0 };
  const exponent = Math.floor(Number(magnitude.log(2).toFixed(6)));
  const divisor = new Decimal(2).pow(exponent);
  return {
    x: Number(x.div(divisor).toFixed(12)),
    y: Number(y.div(divisor).toFixed(12)),
    exponent,
  };
}

function scratchWords(limbs: number): number {
  return 7 * limbs + 2 * limbs * 3;
}

export class WebGpuRenderer {
  private ctx: GpuContext;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;

  private orbitPipelines = new Map<string, GPUComputePipeline>();
  private renderPipeline: GPUComputePipeline | null = null;
  private juliaPipeline: GPUComputePipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;

  private target: GPUTexture | null = null;
  private targetSize = { width: 0, height: 0 };
  private sampler: GPUSampler;

  private uniformBuffer: GPUBuffer;
  private stopsBuffer: GPUBuffer;
  private tableMs = 0;
  private tableMaxDelta = 0;
  /** The view `target` currently holds, or null when it holds nothing. */
  private lastFrame: {
    family?: string;
    juliaX?: Decimal;
    juliaY?: Decimal;
    centerX: Decimal;
    centerY: Decimal;
    unitsPerPixel: Decimal;
    width: number;
    height: number;
  } | null = null;
  private xformBuffer: GPUBuffer | null = null;
  private history: GPUTexture | null = null;
  private historySize = { width: 0, height: 0 };
  private historyValid = false;
  private abortRequested = false;
  private shadePipeline: GPUComputePipeline | null = null;
  private bindLayout: GPUBindGroupLayout | null = null;
  private fieldBuffer: GPUBuffer | null = null;
  private fieldCapacity = 0;
  /**
   * Identifies what is in `fieldBuffer`. Everything that changes the numbers
   * belongs here; everything that only changes how they look must not, or
   * recolouring would recompute the frame it is trying to avoid.
   */
  private fieldKey = "";
  /** Rolling cost of one screen row, used to size the next frame's bands. */
  private msPerRow = 0;
  /** True when the last render stopped early. */
  private aborted = false;
  private laBuffer: GPUBuffer | null = null;
  private laIndexBuffer: GPUBuffer | null = null;
  private laLevels = 0;
  private statsBuffer: GPUBuffer;
  private orbitBuffer: GPUBuffer | null = null;
  private orbitCapacity = 0;

  /** Cached reference orbit: regenerating it per frame would kill panning. */
  private refX = new Decimal(0);
  private refY = new Decimal(0);
  private refLimbs = 0;
  private refIterations = 0;
  private refLength = 0;
  private refEscaped = false;
  private refValid = false;
  private refFamily = "";
  private refConstant = "";

  constructor(ctx: GpuContext, canvas: HTMLCanvasElement) {
    this.ctx = ctx;
    this.canvas = canvas;

    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Could not get a webgpu canvas context");
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device: ctx.device,
      format: this.format,
      alphaMode: "opaque",
    });

    this.sampler = ctx.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    this.uniformBuffer = ctx.device.createBuffer({
      size: 336,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.stopsBuffer = storageBuffer(ctx.device, MAX_STOPS * 4, "palette-stops");
    this.statsBuffer = storageBuffer(
      ctx.device,
      8,
      "render-stats",
      GPUBufferUsage.COPY_SRC
    );
  }

  async init() {
    const { device } = this.ctx;

    const renderModule = await compileShader(device, [compensatedSource, quadSource, perturbationSource, juliaSource].join("\n"), "perturbation");

    // Explicit rather than "auto": the two entry points touch different
    // subsets of the bindings, and an auto layout would derive a different
    // layout for each, so one bind group could not serve both.
    const storage = (type: GPUBufferBindingType, binding: number) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    });
    const bindLayout = device.createBindGroupLayout({
      label: "perturbation",
      entries: [
        storage("read-only-storage", 0),
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba8unorm" },
        },
        storage("read-only-storage", 3),
        storage("read-only-storage", 4),
        storage("read-only-storage", 5),
        storage("storage", 6),
        storage("storage", 7),
      ],
    });
    this.bindLayout = bindLayout;
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindLayout],
    });

    this.renderPipeline = device.createComputePipeline({
      label: "perturbation-compute",
      layout: pipelineLayout,
      compute: { module: renderModule, entryPoint: "compute" },
    });
    this.juliaPipeline = device.createComputePipeline({
      label: "julia-compute",
      layout: pipelineLayout,
      compute: { module: renderModule, entryPoint: "compute", constants: { JULIA: 1 } },
    });
    this.shadePipeline = device.createComputePipeline({
      label: "perturbation-shade",
      layout: pipelineLayout,
      compute: { module: renderModule, entryPoint: "shadePass" },
    });

    const blitModule = await compileShader(
      device,
      `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
/** uv' = uv * xform.xy + xform.zw. Identity is (1, 1, 0, 0). */
@group(0) @binding(2) var<uniform> xform: vec4<f32>;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    var p = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0)
    );
    var out: VsOut;
    out.pos = vec4<f32>(p[i], 0.0, 1.0);
    out.uv = vec2<f32>((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let uv = in.uv * xform.xy + xform.zw;
    // Off the edge of the reused frame there is nothing to show. Dimming it
    // reads as "not computed yet" rather than as a smear of stretched pixels.
    let outside = any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0));
    let texel = textureSample(src, smp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)));
    return select(texel, texel * 0.35, outside);
}
`,
      "blit"
    );
    this.blitPipeline = device.createRenderPipeline({
      label: "blit",
      layout: "auto",
      vertex: { module: blitModule, entryPoint: "vs" },
      fragment: {
        module: blitModule,
        entryPoint: "fs",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-strip" },
    });
  }

  private orbitPipeline(limbs: number, sampleWords: number): GPUComputePipeline {
    const key = `${limbs}:${sampleWords}`;
    const cached = this.orbitPipelines.get(key);
    if (cached) return cached;
    // The module compiled cleanly during the self-test, so plain creation is
    // safe here; errors would already have surfaced at init.
    const module = this.ctx.device.createShaderModule({
      label: `orbit-${limbs}`,
      code: orbitModule,
    });
    const pipeline = this.ctx.device.createComputePipeline({
      label: `orbit-${limbs}`,
      layout: "auto",
      compute: { module, entryPoint: "advanceOrbit", constants: { LIMBS: limbs, SAMPLE_WORDS: sampleWords } },
    });
    this.orbitPipelines.set(key, pipeline);
    return pipeline;
  }

  /** Generates the reference orbit at the view centre, entirely on the GPU. */
  private async generateOrbit(
    request: RenderRequest,
    limbs: number
  ): Promise<{ length: number; escaped: boolean; ms: number }> {
    const { device } = this.ctx;
    const started = performance.now();
    const maxSamples = request.maxIterations + 1;

    this.ensureOrbitCapacity(maxSamples);

    const julia = request.family === "julia";
    const pipeline = this.orbitPipeline(limbs, julia ? 20 : 12);
    const state = storageBuffer(device, limbs * 2, "orbit-state");
    const seed = storageBuffer(device, limbs * 4, "orbit-seed");
    const scratch = storageBuffer(device, scratchWords(limbs), "orbit-scratch");
    const status = storageBuffer(device, 4, "orbit-status", GPUBufferUsage.COPY_SRC);
    const params = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const initialX = parseFixed(julia ? request.centerX.toFixed() : "0",limbs);
    const initialY = parseFixed(julia ? request.centerY.toFixed() : "0",limbs);
    const seedData = new Uint32Array(limbs*4);
    seedData.set(parseFixed((julia ? request.juliaX! : request.centerX).toFixed(),limbs));
    seedData.set(parseFixed((julia ? request.juliaY! : request.centerY).toFixed(),limbs),limbs);
    seedData.set(initialX,limbs*2); seedData.set(initialY,limbs*3);
    device.queue.writeBuffer(seed,0,seedData);
    const initial = new Uint32Array(limbs*2);initial.set(initialX);initial.set(initialY,limbs);
    device.queue.writeBuffer(state,0,initial);
    if (julia) {
      device.queue.writeBuffer(this.orbitBuffer!, 0, new Float32Array([
        ...fixedToQuad(initialX, limbs), ...fixedToQuad(initialY, limbs), ...Array(10).fill(0),
      ]));
    } else {
      const sx=fixedToHdr(initialX,limbs),sy=fixedToHdr(initialY,limbs);
      device.queue.writeBuffer(this.orbitBuffer!,0,new Float32Array([sx.mantissaHi,sx.mantissaLo,sx.exponent,sy.mantissaHi,sy.mantissaLo,sy.exponent,0,0,0,0,0,0]));
    }

    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: state } },
        { binding: 1, resource: { buffer: seed } },
        { binding: 2, resource: { buffer: scratch } },
        { binding: 3, resource: { buffer: this.orbitBuffer! } },
        { binding: 4, resource: { buffer: status } },
        { binding: 5, resource: { buffer: params } },
      ],
    });

    // `sampleCount` counts written samples; sample 0 comes from the CPU.
    // The shader emits at `startIndex + iter + 1`, so startIndex must be the
    // index of the last sample already written, i.e. sampleCount - 1. Passing
    // the count itself skips one sample per batch and shifts all the rest.
    // Sample 0 is zero for Mandelbrot and the view centre for Julia.
    device.queue.writeBuffer(status, 0, new Uint32Array([1, 0, 0, 0]));
    device.queue.writeBuffer(
      params,
      0,
      new Uint32Array([ORBIT_BATCH, 0, maxSamples, 0])
    );

    let sampleCount = 1;
    let escaped = false;
    let batchLimit = DISPATCHES_PER_SUBMIT;

    while (sampleCount - 1 < request.maxIterations) {
      if (request.isCurrent && !request.isCurrent()) {
        [state,seed,scratch,status,params].forEach(b=>b.destroy());
        throw new DOMException("Superseded", "AbortError");
      }
      const remaining = request.maxIterations - (sampleCount - 1);
      const dispatches = Math.min(
        batchLimit,
        Math.max(1, Math.ceil(remaining / ORBIT_BATCH))
      );
      const batchStarted = performance.now();

      // Many dispatches per submission. Each readback is a full pipeline
      // flush, and one per 512 iterations meant hundreds of stalls on a deep
      // view — that is what made the page freeze. The shader resumes from the
      // status buffer, so a whole run can be encoded at once.
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      for (let i = 0; i < dispatches; i++) pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);

      // Only the 4-word status comes back; the big state never leaves the GPU.
      const raw = new Uint32Array(await readBuffer(device, status, 16));

      // Aim the next submission at the budget. A deep view at a high limb
      // count can take milliseconds per dispatch, and 24 of those in one
      // command is long enough for the driver to give up on the device.
      const elapsed = performance.now() - batchStarted;
      if (elapsed > SUBMIT_BUDGET_MS * 1.5) {
        batchLimit = Math.max(1, Math.floor(batchLimit / 2));
      } else if (elapsed < SUBMIT_BUDGET_MS * 0.5) {
        batchLimit = Math.min(DISPATCHES_PER_SUBMIT, batchLimit * 2);
      }
      if (raw[0] <= sampleCount) break; // no progress: escaped or done
      sampleCount = Math.min(raw[0], maxSamples);
      if (raw[1] === 1) {
        escaped = true;
        break;
      }
    }

    [state, seed, scratch, status, params].forEach((b) => b.destroy());
    return {
      length: Math.max(2, sampleCount),
      escaped,
      ms: performance.now() - started,
    };
  }

  /**
   * Builds the linear-approximation table from the freshly generated orbit.
   *
   * This is the one place the reduced orbit comes back to the CPU — once per
   * orbit, not per frame. The table then lets each pixel jump whole ranges of
   * reference iterations instead of stepping through them.
   */
  private async buildApproxTable(request: RenderRequest) {
    const { device } = this.ctx;
    const started = performance.now();

    // Largest |delta| any pixel can have: the half-diagonal of the view.
    const halfDiagonal = request.unitsPerPixel
      .times(Math.hypot(request.width, request.height) / 2)
      .toNumber();

    const samples = await this.debugReadOrbit(this.refLength);
    const table = buildBla(samples, this.refLength, halfDiagonal);
    this.tableMaxDelta = halfDiagonal;

    this.laLevels = table.levels;
    if (table.entryCount === 0) {
      this.laLevels = 0;
    }
    this.tableMs = performance.now() - started;

    this.laBuffer?.destroy();
    this.laBuffer = storageBuffer(
      device,
      Math.max(8, table.data.length),
      "la-table"
    );
    // Copied into a fresh array so its buffer type is concrete for writeBuffer;
    // this runs once per orbit, not per frame.
    device.queue.writeBuffer(this.laBuffer, 0, new Float32Array(table.data));

    const index = new Uint32Array(Math.max(2, table.levels * 2));
    for (let level = 0; level < table.levels; level++) {
      index[level] = table.levelOffsets[level];
      index[table.levels + level] = table.levelCounts[level];
    }
    this.laIndexBuffer?.destroy();
    this.laIndexBuffer = storageBuffer(device, index.length, "la-index");
    device.queue.writeBuffer(this.laIndexBuffer, 0, index);
  }

  private ensureTarget(width: number, height: number) {
    if (this.target && this.targetSize.width === width && this.targetSize.height === height) {
      return;
    }
    this.target?.destroy();
    this.target = this.ctx.device.createTexture({
      label: "render-target",
      size: { width, height },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this.targetSize = { width, height };
  }

  /**
   * Keeps the history texture at its own size, independent of the render
   * target.
   *
   * It used to live in ensureTarget, which meant the interactive resolution
   * switch destroyed it at the start of every gesture and again at the end.
   * Reprojection went dead exactly at those two moments, so each zoom began
   * and ended with a visible jump -- the bounce. The transform is in
   * normalised texture coordinates and does not care about pixel dimensions,
   * so there is no reason to throw the frame away.
   */
  private ensureHistory(width: number, height: number) {
    if (
      this.history &&
      this.historySize.width === width &&
      this.historySize.height === height
    ) {
      return;
    }
    this.history?.destroy();
    this.history = this.ctx.device.createTexture({
      label: "last-complete-frame",
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.historySize = { width, height };
    this.historyValid = false;
  }

  /** Reads the reduced orbit samples back, for comparison against an oracle. */
  async debugReadOrbit(count: number): Promise<Float32Array> {
    if (!this.orbitBuffer) return new Float32Array(0);
    const n = Math.min(count,this.orbitCapacity);
    const stride = this.refFamily === "julia" ? 20 : 12;
    const raw = new Float32Array(await readBuffer(this.ctx.device,this.orbitBuffer,n*stride*4));
    const absolute = new Float32Array(n*6);
    for(let i=0;i<n;i++) {
      const at = i * stride;
      // This legacy diagnostic/BLA view exposes the leading pair only.
      absolute.set(stride === 12 ? raw.subarray(at,at+6) :
        [raw[at],raw[at+1],raw[at+4],raw[at+5],raw[at+6],raw[at+9]],i*6);
    }
    return absolute;
  }

  /** Reads pixels back from the render target (rgba8unorm). */
  async debugReadPixels(points: [number, number][]): Promise<number[][]> {
    if (!this.target) return [];
    const { device } = this.ctx;
    const { width, height } = this.targetSize;
    // copyTextureToBuffer requires bytesPerRow to be a multiple of 256.
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

    const staging = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.target },
      { buffer: staging, bytesPerRow, rowsPerImage: height },
      { width, height }
    );
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    return points.map(([x, y]) => {
      const i = y * bytesPerRow + x * 4;
      return [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
    });
  }

  /**
   * The orbit buffer is bound on every render, so it has to exist even when the
   * direct method never reads it.
   */
  /**
   * Rows per dispatch: four bands normally, fewer rows when the last frame
   * showed this view is slow enough to risk the watchdog.
   */
  private bandHeightFor(width: number, height: number): number {
    const even = Math.max(TILE_ROWS, Math.ceil(height / MAX_TILES));
    if (this.msPerRow <= 0) return even;
    const affordable = Math.floor(SUBMIT_BUDGET_MS / this.msPerRow);
    return Math.max(8, Math.min(even, affordable));
  }

  /** Largest sample grid up to `wanted` whose field fits in one binding. */
  private affordableGrid(wanted: number, width: number, height: number): number {
    const limit = this.ctx.device.limits.maxStorageBufferBindingSize;
    for (let grid = wanted; grid > 1; grid--) {
      if (width * height * grid * grid * 8 <= limit) return grid;
    }
    return 1;
  }

  private ensureFieldCapacity(samples: number) {
    if (this.fieldCapacity >= samples && this.fieldBuffer) return;
    this.fieldBuffer?.destroy();
    // Two floats per sub-sample.
    this.fieldBuffer = storageBuffer(this.ctx.device, samples * 2, "sample-field", GPUBufferUsage.COPY_SRC);
    this.fieldCapacity = samples;
    this.fieldKey = "";
  }

  private ensureOrbitCapacity(samples: number) {
    if (this.orbitCapacity >= samples && this.orbitBuffer) return;
    this.orbitBuffer?.destroy();
    this.orbitBuffer = storageBuffer(
      this.ctx.device,
      samples * 20,
      "orbit-samples",
      GPUBufferUsage.COPY_SRC
    );
    this.orbitCapacity = samples;
  }

  /**
   * Draws `source` to the swap chain with `xform` applied to its texture
   * coordinates. Both the real frame and a reprojection go through here, so
   * they cannot drift apart.
   */
  private encodeBlit(
    encoder: GPUCommandEncoder,
    source: GPUTexture,
    xform: Float32Array
  ) {
    const { device } = this.ctx;
    if (!this.xformBuffer) {
      this.xformBuffer = device.createBuffer({
        label: "blit-xform",
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.xformBuffer, 0, xform.buffer as ArrayBuffer);

    const bind = device.createBindGroup({
      layout: this.blitPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.xformBuffer } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.blitPipeline!);
    pass.setBindGroup(0, bind);
    pass.draw(4);
    pass.end();
  }

  /**
   * Re-presents the last completed frame under `request`'s view.
   *
   * A pixel's colour depends only on the complex point under it, so moving the
   * view is a coordinate change on a picture we already have. Mapping the new
   * view's texture coordinates back into the old frame costs one full-screen
   * triangle -- microseconds against the tens or hundreds of milliseconds a
   * real frame takes at depth -- and it is exact wherever the two views
   * overlap and the scale has not changed.
   *
   * It is only ever a stand-in: zooming in magnifies the old pixels rather
   * than resolving new detail, so the caller still has to draw properly once
   * the gesture settles.
   */
  /**
   * Asks the render in flight to stop after its current band. Cheap and
   * advisory: a frame that has already finished simply ignores it.
   */
  abort() {
    this.abortRequested = true;
  }

  reproject(request: RenderRequest): boolean {
    const last = this.lastFrame;
    if (!last || !this.history || !this.historyValid || !this.blitPipeline) {
      return false;
    }
    if (last.family !== request.family || (request.family === "julia" &&
        (!last.juliaX?.eq(request.juliaX!) || !last.juliaY?.eq(request.juliaY!)))) return false;

    const mapping = reprojectionFor(last, request);
    if (!mapping) return false;

    const encoder = this.ctx.device.createCommandEncoder({ label: "reproject" });
    this.encodeBlit(
      encoder,
      this.history,
      new Float32Array([mapping.scale, mapping.scale, mapping.offsetX, mapping.offsetY])
    );
    this.ctx.device.queue.submit([encoder.finish()]);
    return true;
  }

  async debugReadField(): Promise<Float32Array> {
    if (!this.fieldBuffer) return new Float32Array();
    return new Float32Array(await readBuffer(this.ctx.device,this.fieldBuffer,this.targetSize.width*this.targetSize.height*8));
  }
  invalidateHistory() { this.historyValid=false; this.refValid=false; this.abort(); }
  async render(request: RenderRequest): Promise<RenderStats> {
    const { device } = this.ctx;
    if (!this.renderPipeline || !this.blitPipeline) {
      throw new Error("WebGpuRenderer.init() was not awaited");
    }

    const method = request.forceMethod ?? methodForScale(request.unitsPerPixel);
    const limbs = limbsForScale(request.unitsPerPixel, request.family === "julia" ? 96 : 48);
    Decimal.set({ precision: Math.max(Decimal.precision,Math.ceil((32 * (limbs - 1)) / 3.32) + 10) });

    // Reuse the reference orbit while the view stays near the point it was
    // built at. Regenerating costs tens of milliseconds, so doing it every
    // frame would make panning unusable at depth.
    const halfSpan = request.unitsPerPixel.times(
      Math.min(request.width, request.height) / 2
    );
    const drift = request.centerX
      .minus(this.refX)
      .abs()
      .plus(request.centerY.minus(this.refY).abs());
    const family = request.family ?? "mandelbrot";
    const constant = family === "julia" ? `${request.juliaX},${request.juliaY}` : "";
    const stale =
      family !== this.refFamily || constant !== this.refConstant ||
      !this.refValid ||
      limbs !== this.refLimbs ||
      request.maxIterations > this.refIterations ||
      drift.greaterThan(halfSpan.times(0.5));

    // Mid-gesture, keep whatever reference we have. Perturbation stays exact
    // with a stale reference — it just rebases more — and rebuilding costs tens
    // to hundreds of milliseconds, which is exactly the zoom stutter.
    const canRebuild = !request.interacting || !this.refValid;

    let orbitMs = 0;
    if (method !== Method.Direct && stale && canRebuild) {
      this.refFamily=family; this.refConstant=constant;
      this.refX = request.centerX;
      this.refY = request.centerY;
      const orbit = await this.generateOrbit(request, limbs);
      this.refLimbs = limbs;
      this.refIterations = request.maxIterations;
      this.refLength = orbit.length;
      this.refEscaped = orbit.escaped;
      this.refValid = true;
      orbitMs = orbit.ms;
      this.tableMs = 0;
      this.laLevels=0;
      if (method === Method.Hdr && family === "mandelbrot") await this.buildApproxTable(request);
    }

    const started = performance.now();
    // Every buffer in the bind group must exist even when this method does not
    // read it: the direct path builds neither an orbit nor a skip table.
    this.ensureOrbitCapacity(1);
    if (!this.laBuffer || !this.laIndexBuffer) {
      this.laBuffer = storageBuffer(device, ENTRY_FLOATS, "la-table");
      this.laIndexBuffer = storageBuffer(device, 2, "la-index");
    }
    this.ensureTarget(request.width, request.height);

    const scale = splitExponent(request.unitsPerPixel);
    const offset = splitComplex(
      request.centerX.minus(this.refX),
      request.centerY.minus(this.refY)
    );

    const colors = request.colors;
    const stopData = new Float32Array(MAX_STOPS * 4);
    colors.stops.slice(0, MAX_STOPS).forEach((stop, i) => {
      stopData.set(hexToRgb(stop), i * 4);
      stopData[i * 4 + 3] = 1;
    });
    device.queue.writeBuffer(this.stopsBuffer, 0, stopData);

    // The field is two floats per sub-sample, so it grows with the square of
    // the sample grid: 3x3 at 4K would be a gigabyte and the allocation simply
    // fails. Drop sample counts that will not fit rather than die trying.
    const grid = this.affordableGrid(
      Math.max(1, Math.min(3, colors.supersample)),
      request.width,
      request.height
    );

    // Layout must match the Uniforms struct in perturbation.wgsl. vec3 members
    // align to 16 bytes, which is what the gaps below are for.
    const uniforms = new ArrayBuffer(336);
    const f32 = new Float32Array(uniforms);
    const i32 = new Int32Array(uniforms);
    const u32 = new Uint32Array(uniforms);
    f32[0] = request.width;
    f32[1] = request.height;
    f32[2] = scale.mantissa;
    i32[3] = scale.exponent;
    f32[4] = offset.x;
    f32[5] = offset.y;
    i32[6] = offset.exponent;
    u32[7] = request.maxIterations;
    u32[8] = this.refLength;
    u32[9] = colors.palette;
    f32[10] = Math.max(1, colors.cycle);
    f32[11] = colors.offset;
    u32[12] = colors.mapping;
    u32[13] = colors.mirror ? 1 : 0;
    u32[14] = colors.smooth ? 1 : 0;
    // interior: vec3<f32> aligns to 16 bytes -> offset 64.
    const interior = hexToRgb(colors.interior);
    f32[16] = interior[0];
    f32[17] = interior[1];
    f32[18] = interior[2];
    u32[19] = Math.max(1, Math.min(MAX_STOPS, colors.stops.length));
    const deltaBound = request.unitsPerPixel.times(Math.hypot(request.width,request.height)/2).plus(drift).toNumber();
    u32[20] =
      request.useApprox === false || method !== Method.Hdr || family === "julia" || colors.mode === 1 || deltaBound > this.tableMaxDelta * (1 + 1e-12) ? 0 : this.laLevels;
    u32[21] = BASE_STEP;
    u32[22] = colors.mode;
    f32[23] = colors.colorDensity;
    f32[24] = colors.colorPhase;
    f32[25] = colors.slopeDepth;
    // lightDir: vec3<f32> aligns to 16 bytes -> offset 112.
    const azimuth = (colors.lightAngle * Math.PI) / 180;
    const elevation = (colors.lightElevation * Math.PI) / 180;
    f32[28] = Math.cos(azimuth) * Math.cos(elevation);
    f32[29] = Math.sin(azimuth) * Math.cos(elevation);
    f32[30] = Math.sin(elevation);
    f32[31] = colors.ambientLight;
    f32[32] = colors.diffuseStrength;
    f32[33] = colors.specularStrength;
    u32[34] = colors.slopeLighting ? 1 : 0;
    u32[35] = grid;
    f32[36] = 1 / Math.max(1, colors.gamma);
    u32[37] = method;
    f32[38] = request.centerX.toNumber();
    f32[39] = request.centerY.toNumber();
    const power = new Decimal(2).pow(scale.exponent);
    f32[44] = request.centerX.minus(this.refX).div(new Decimal(2).pow(offset.exponent)).minus(f32[4]).toNumber();
    f32[45] = request.centerY.minus(this.refY).div(new Decimal(2).pow(offset.exponent)).minus(f32[5]).toNumber();
    f32[46] = request.unitsPerPixel.div(power).minus(f32[2]).toNumber();
    u32[47] = family === "julia" ? 1 : 0;
    f32[48] = request.juliaX?.toNumber() ?? 0; f32[49] = request.juliaY?.toNumber() ?? 0;
    f32[50] = request.juliaX?.minus(f32[48]).toNumber() ?? 0; f32[51] = request.juliaY?.minus(f32[49]).toNumber() ?? 0;
    f32[52] = request.centerX.minus(f32[38]).toNumber(); f32[53] = request.centerY.minus(f32[39]).toNumber();
    if (family === "julia") {
      const offsetPower = new Decimal(2).pow(offset.exponent);
      [request.unitsPerPixel.div(power), request.centerX.minus(this.refX).div(offsetPower),
        request.centerY.minus(this.refY).div(offsetPower), request.centerX, request.centerY,
        request.juliaX!, request.juliaY!].forEach((value, i) => f32.set(splitQuad(value), 56 + i * 4));
    }
    device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    device.queue.writeBuffer(this.statsBuffer, 0, new Uint32Array(8));

    // What the field holds is a function of the geometry and the iteration,
    // not of the palette. Rebuilding it is the whole cost of a frame, so it is
    // only rebuilt when one of these changes.
    const fieldKey = [
      family,constant,
      request.centerX.toString(),
      request.centerY.toString(),
      request.unitsPerPixel.toString(),
      request.width,
      request.height,
      request.maxIterations,
      colors.mode,
      grid,
      method,
      this.refLength,
      u32[20],
    ].join("|");
    const fieldStale = fieldKey !== this.fieldKey || this.aborted;
    this.ensureFieldCapacity(request.width * request.height * grid * grid);

    const bind = device.createBindGroup({
      layout: this.bindLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.orbitBuffer! } },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
        { binding: 2, resource: this.target!.createView() },
        { binding: 3, resource: { buffer: this.stopsBuffer } },
        { binding: 4, resource: { buffer: this.laBuffer! } },
        { binding: 5, resource: { buffer: this.laIndexBuffer! } },
        { binding: 6, resource: { buffer: this.statsBuffer } },
        { binding: 7, resource: { buffer: this.fieldBuffer! } },
      ],
    });

    // Render in horizontal bands rather than one dispatch. Deep frames take
    // hundreds of milliseconds, and until now a gesture arriving at the start
    // of one had to wait for all of it -- the work was already committed. A
    // band is short enough to abandon, so a stale frame costs one band, not a
    // whole screen.
    this.aborted = false;
    // Clear the request here, not after the loop. An abort() arriving between
    // frames used to persist into the next one and kill it at its first band
    // boundary -- and since an abandoned frame presents nothing, the caller's
    // retry was abandoned too, and the canvas stayed black for good.
    this.abortRequested = false;
    const bandRows = Math.max(8, Math.floor(
      (request.tileRows ?? this.bandHeightFor(request.width, request.height)) / 8
    ) * 8);
    let completed = true;

    for (let top = 0; fieldStale && top < request.height; top += bandRows) {
      const rows = Math.min(bandRows, request.height - top);
      u32[40] = top;
      device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(family === "julia" ? this.juliaPipeline! : this.renderPipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(request.width / 8), Math.ceil(rows / 8));
      pass.end();

      device.queue.submit([encoder.finish()]);

      if (top + rows >= request.height) break;
      // Bound the queue to one numerical band, leaving room for presentation.
      // The event-loop yield also lets pending input supersede the request.
      await device.queue.onSubmittedWorkDone();
      await yieldToEvents();
      // Only give up when there is a finished frame to show instead. Without
      // one -- the first frame after a load or a resize -- abandoning means
      // presenting nothing at all, and a blank canvas is worse than a frame
      // that arrives a moment late.
      if ((request.isCurrent && !request.isCurrent()) || (this.abortRequested && this.historyValid)) {
        completed = false;
        this.aborted = true;
        break;
      }
    }
    if (request.isCurrent && !request.isCurrent()) completed = false;
    if (fieldStale && completed) {
      // Smoothed, because one frame's timing is noisy and a band size that
      // swings every frame is worse than one that is slightly wrong.
      const measured = (performance.now() - started) / Math.max(request.height, 1);
      this.msPerRow = this.msPerRow > 0 ? this.msPerRow * 0.5 + measured * 0.5 : measured;
    }
    this.fieldKey = completed ? fieldKey : "";

    // Shading is cheap enough to do in one go, and it has to run even when the
    // field was reused -- that is the entire point of keeping it. An abandoned
    // frame is the exception: its field is half one view and half another, and
    // shading that would draw the seam. Show the last whole frame instead.
    if (completed) {
      const encoder = device.createCommandEncoder({ label: "shade" });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.shadePipeline!);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(
        Math.ceil(request.width / 8),
        Math.ceil(request.height / 8)
      );
      pass.end();
      // Presentation belongs to the current camera, not this possibly older request.
      this.ensureHistory(request.width, request.height);
      encoder.copyTextureToTexture(
        { texture: this.target! },
        { texture: this.history! },
        { width: request.width, height: request.height }
      );
      device.queue.submit([encoder.finish()]);
      this.historyValid = true;
    }

    await device.queue.onSubmittedWorkDone();
    const renderMs = performance.now() - started;
    if(request.isCurrent && !request.isCurrent()){completed=false;this.historyValid=false;this.fieldKey="";}

    // Only a finished frame updates this. An abandoned one leaves both the
    // history texture and this description alone, so reprojection keeps
    // working off the last whole frame for the rest of the gesture.
    if (completed) {
      this.lastFrame = {
        family: request.family, juliaX: request.juliaX, juliaY: request.juliaY,
        centerX: request.centerX,
        centerY: request.centerY,
        unitsPerPixel: request.unitsPerPixel,
        width: request.width,
        height: request.height,
      };
    }

    const counters = new Uint32Array(await readBuffer(device, this.statsBuffer, 32));
    const skippedIterations = counters[0];
    const plainIterations = counters[3];
    const total = skippedIterations + plainIterations;

    return {
      completed, computed: fieldStale && completed,
      limbs,
      decimalDigits: Math.floor((32 * (limbs - 1)) / 3.32),
      orbitLength: this.refLength,
      orbitEscaped: this.refEscaped,
      orbitMs,
      tableMs: this.tableMs,
      method,
      renderMs,
      skippedIterations,
      approxSteps: counters[1],
      rebases: counters[2],
      plainIterations,
      skipRatio: total > 0 ? skippedIterations / total : 0,
      cappedRatio: counters[5] > 0 ? counters[4] / counters[5] : 0,
    };
  }
}
