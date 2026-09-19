/**
 * WebGPU rendering path: arbitrary-precision reference orbit on the GPU, then
 * a perturbation compute pass whose per-pixel deltas carry their own exponent.
 *
 * Unlike the WebGL path there is no f32 underflow floor, so zoom depth is
 * bounded by the precision profile (limb count) rather than by the renderer.
 */

import Decimal from "decimal.js";
import { compileShader, readBuffer, storageBuffer, type GpuContext } from "../gpu/device";
import { GpuTiming, type TimingSample } from "../gpu/timing";
import bigfixedSource from "../gpu/shaders/bigfixed.wgsl?raw";
import orbitBindings from "../gpu/shaders/orbit-bindings.wgsl?raw";
import orbitSource from "../gpu/shaders/orbit.wgsl?raw";
import compensatedSource from "../arithmetic/compensated.wgsl?raw";
import quadSource from "../arithmetic/quad.wgsl?raw";
import perturbationSource from "./perturbation.wgsl?raw";
import wideSource from "./wide.wgsl?raw";
import reuseSource from "./reuse.wgsl?raw";
import { createSampleGridAnchor, planSampleGrid, sampleGridRemap, type SampleGridAnchor, type SampleGridRemap } from "./sample-grid";
import type { FrameView } from "./reprojection";
import { fixedToQuad, splitQuad } from "../arithmetic/quad";
import { reprojectionFor } from "./reprojection";

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
import { parseFixed } from "../arithmetic/types";
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
// Measured on the physical GPU: tiny dispatches lost throughput without a
// comparable first-detail benefit. Keep roughly 64K samples per region, then
// allow the wall-time estimate to grow cheap batches. This is an occupancy
// compromise, not a promise that a batch completes within eight milliseconds.
const MIN_BATCH_SAMPLES = 65_536;

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
  computedSamples: number;
  reusedSamples: number;
  sampleWidth: number;
  sampleHeight: number;
  limbs: number;
  decimalDigits: number;
  orbitLength: number;
  orbitEscaped: boolean;
  orbitMs: number;
  /** CPU wall time awaiting an orbit pipeline, including driver compilation. */
  pipelineWaitMs: number;
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
  /** Direct compensated iteration. No reference orbit. */
  Direct = 0,
  /** Compensated perturbation without BLA (historical name retained). */
  Plain = 1,
  /** The same exponent-carrying perturbation, eligible for bounded BLA. */
  Hdr = 2,
}

/**
 * Preserves the qualified method-selection boundary. Both perturbation modes
 * now use compensated exponent-carrying arithmetic; Hdr additionally permits
 * BLA. The historical plain-f32 timing claims no longer describe this shader.
 * The measured 10,000-iteration workload did not justify changing this gate.
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

  private orbitPipelines = new Map<string, Promise<GPUComputePipeline>>();
  private pipelineWaitMs = 0;
  private renderPipeline: GPUComputePipeline | null = null;
  private directPipeline: GPUComputePipeline | null = null;
  private approxPipeline: GPUComputePipeline | null = null;
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
    colors: ColorSettings;
    maxIterations: number;
  } | null = null;
  private xformBuffer: GPUBuffer | null = null;
  private history: GPUTexture | null = null;
  private coverageHistory: GPUTexture | null = null;
  private coverageFrame: WebGpuRenderer["lastFrame"] = null;
  private currentView: RenderRequest | null = null;
  private historySize = { width: 0, height: 0 };
  private historyValid = false;
  private publicationEpoch = 0;
  private incomingFrame: WebGpuRenderer["lastFrame"] = null;
  private partialSerial = 0;
  private partialRegions = 0;
  private firstPartialAt = 0;
  private fieldComplete = false;
  private reuseMapping: SampleGridRemap | null = null;
  private reusableView: FrameView | null = null;
  private reusableComplete = false;
  private batchMsPerSample = 0;
  private timing: GpuTiming;
  setProfiling(enabled: boolean) { this.timing.setEnabled(enabled); }
  performance() { return this.timing.snapshot(); }
  debugProgress() {
    return { epoch: this.publicationEpoch, serial: this.partialSerial,
      regions: this.partialRegions, firstPublicationAt: this.firstPartialAt,
      active: !!this.incomingFrame, complete: this.fieldComplete,
      width: this.fieldView?.width ?? 0, height: this.fieldView?.height ?? 0 };
  }
  private abortRequested = false;
  private shadePipeline: GPUComputePipeline | null = null;
  private bindLayout: GPUBindGroupLayout | null = null;
  private fieldBuffer: GPUBuffer | null = null;
  private fieldCapacity = 0;
  private spareField: GPUBuffer | null = null;
  private spareCapacity = 0;
  private fieldView: FrameView | null = null;
  private sampleKey = "";
  private gridAnchor: SampleGridAnchor | null = null;
  private reusePipeline: GPUComputePipeline | null = null;
  private reuseUniform: GPUBuffer | null = null;
  private cachedStats: RenderStats | null = null;
  private cachedRequest = "";
  private msPerSample = 0;

  /** Measured field cost only; reference generation is tracked separately. */
  calculationScale(width: number, height: number): number {
    if (!this.msPerSample) return 1;
    const fullMs = this.msPerSample * width * height;
    return Math.max(.125, Math.min(1, Math.sqrt(36 / Math.max(fullMs, 1))));
  }
  /**
   * Identifies what is in `fieldBuffer`. Everything that changes the numbers
   * belongs here; everything that only changes how they look must not, or
   * recolouring would recompute the frame it is trying to avoid.
   */
  private fieldKey = "";
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
    this.timing = new GpuTiming(ctx.device);
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
      magFilter: "nearest",
      minFilter: "nearest",
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
    const reuseModule = await compileShader(device, reuseSource, "sample-reuse");
    this.reusePipeline = device.createComputePipeline({ layout: "auto", compute: { module: reuseModule, entryPoint: "remap" } });
    this.reuseUniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const renderModule = await compileShader(device, [compensatedSource, quadSource, perturbationSource, wideSource].join("\n"), "perturbation");

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

    this.directPipeline = device.createComputePipeline({
      label: "direct-compute",
      layout: pipelineLayout,
      compute: { module: renderModule, entryPoint: "compute", constants: { DIRECT: 1 } },
    });
    this.renderPipeline = device.createComputePipeline({
      label: "perturbation-compute",
      layout: pipelineLayout,
      compute: { module: renderModule, entryPoint: "compute" },
    });
    this.approxPipeline = device.createComputePipeline({
      label: "approximation-compute",
      layout: pipelineLayout,
      compute: { module: renderModule, entryPoint: "compute", constants: { APPROX: 1 } },
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
struct Presentation { front: vec4<f32>, back: vec4<f32>, options: vec4<f32>, fresh: vec4<f32>, freshOptions: vec4<f32> };
@group(0) @binding(2) var<uniform> display: Presentation;
@group(0) @binding(3) var coverage: texture_2d<f32>;
@group(0) @binding(4) var incoming: texture_2d<f32>;

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
    let uv = in.uv * display.front.xy + display.front.zw;
    let oldUV = in.uv * display.back.xy + display.back.zw;
    let frontValid = display.options.z > 0.0 && all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
    let backValid = display.options.x > 0.0 && all(oldUV >= vec2<f32>(0.0)) && all(oldUV <= vec2<f32>(1.0));
    // Select an actual determined sample. Never blend the two images, and do
    // not let a smaller new field erase already calculated coverage.
    let front = textureSample(src, smp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)));
    let back = textureSample(coverage, smp, clamp(oldUV, vec2<f32>(0.0), vec2<f32>(1.0)));
    let useBack = backValid && (!frontValid || display.options.y > 0.0);
    var result = select(front, back, useBack);
    let freshUV = in.uv * display.fresh.xy + display.fresh.zw;
    let fresh = textureSample(incoming, smp, clamp(freshUV, vec2<f32>(0.0), vec2<f32>(1.0)));
    let valid = display.freshOptions.x > 0.0 && fresh.a > 0.5 && all(freshUV >= vec2<f32>(0.0)) && all(freshUV <= vec2<f32>(1.0));
    let prefer = select(display.freshOptions.y, display.freshOptions.z, useBack) > 0.0;
    if (valid && (prefer || (!frontValid && !backValid))) { result = fresh; }
    if (display.options.z == 0.0 && !backValid && !valid) { result = vec4<f32>(0.0); }
    return vec4<f32>(result.rgb, 1.0);
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

  private orbitPipeline(limbs: number, sampleWords: number): Promise<GPUComputePipeline> {
    const key = `${limbs}:${sampleWords}`;
    const cached = this.orbitPipelines.get(key);
    if (cached) return cached;
    // The module compiled cleanly during the self-test, so plain creation is
    // safe here; errors would already have surfaced at init.
    const module = this.ctx.device.createShaderModule({
      label: `orbit-${limbs}`,
      code: orbitModule,
    });
    const pipeline = this.ctx.device.createComputePipelineAsync({
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
    const pipelineStarted = performance.now();
    const pipeline = await this.orbitPipeline(limbs, 20);
    this.pipelineWaitMs = performance.now() - pipelineStarted;
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
    device.queue.writeBuffer(this.orbitBuffer!, 0, new Float32Array([
      ...fixedToQuad(initialX, limbs), ...fixedToQuad(initialY, limbs), ...Array(10).fill(0),
    ]));

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
      .plus(request.centerX.minus(this.refX).abs())
      .plus(request.centerY.minus(this.refY).abs())
      .toNumber();

    const samples = new Float32Array(await readBuffer(device, this.orbitBuffer!, this.refLength * 20 * 4));
    const table = buildBla(samples, this.refLength, halfDiagonal, { sampleWords: 20 });
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
   * Retain one useful completed source while preparing the incoming image.
   * Neither source changes geometry without its corresponding pixel copy.
   */
  private ensureHistory(request: RenderRequest) {
    const { width, height } = request;
    const compatible = (frame: WebGpuRenderer["lastFrame"]) => frame &&
      frame.family === request.family && frame.maxIterations === request.maxIterations &&
      (request.family !== "julia" || frame.juliaX?.eq(request.juliaX!) && frame.juliaY?.eq(request.juliaY!)) &&
      JSON.stringify(frame.colors) === JSON.stringify(request.colors);
    const view = this.currentView ?? request;
    const bounds = (frame: FrameView) => {
      const m = reprojectionFor(frame, view);
      return m ? [Math.max(0, -m.offsetX / m.scaleX), Math.max(0, -m.offsetY / m.scaleY),
        Math.min(1, (1 - m.offsetX) / m.scaleX), Math.min(1, (1 - m.offsetY) / m.scaleY)] : [0,0,0,0];
    };
    const incoming = bounds(request);
    const score = (frame: FrameView) => {
      const b = bounds(frame), area = Math.max(0,b[2]-b[0]) * Math.max(0,b[3]-b[1]);
      const overlap = Math.max(0,Math.min(b[2],incoming[2])-Math.max(b[0],incoming[0])) *
        Math.max(0,Math.min(b[3],incoming[3])-Math.max(b[1],incoming[1]));
      const extent = frame.unitsPerPixel.times(frame.height).div(view.unitsPerPixel.times(view.height)).toNumber();
      const detail = Math.max(0, Math.log2(request.unitsPerPixel.div(frame.unitsPerPixel).toNumber()));
      return (area-overlap)*1000 + area + area*Math.min(8,detail)*.1 + (area ? Math.min(64,extent)*.0001 : 0);
    };
    const keepFront = this.historyValid && compatible(this.lastFrame) &&
      (!compatible(this.coverageFrame) || score(this.lastFrame!) > score(this.coverageFrame!));
    let available: GPUTexture | null;
    if (keepFront) {
      available = this.coverageHistory;
      this.coverageHistory = this.history; this.coverageFrame = this.lastFrame;
    } else {
      available = this.history;
      if (!compatible(this.coverageFrame)) {
        this.coverageHistory?.destroy(); this.coverageHistory=null; this.coverageFrame=null;
      }
    }
    if (available && available.width === width && available.height === height) this.history = available;
    else {
      available?.destroy();
      this.history = this.ctx.device.createTexture({
        label: "last-complete-frame",
        size: { width, height },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    this.historySize = { width, height };
    this.historyValid = false;
  }

  /** Reads the reduced orbit samples back, for comparison against an oracle. */
  async debugReadOrbit(count: number): Promise<Float32Array> {
    if (!this.orbitBuffer) return new Float32Array(0);
    const n = Math.min(count,this.orbitCapacity);
    const stride = 20;
    const raw = new Float32Array(await readBuffer(this.ctx.device,this.orbitBuffer,n*stride*4));
    const absolute = new Float32Array(n*6);
    for(let i=0;i<n;i++) {
      const at = i * stride;
      // This legacy diagnostic view exposes the leading pair only.
      absolute.set([raw[at],raw[at+1],raw[at+4],raw[at+5],raw[at+6],raw[at+9]],i*6);
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
  /** Largest sample grid up to `wanted` whose field fits in one binding. */
  private affordableGrid(wanted: number, width: number, height: number): number {
    const limit = this.ctx.device.limits.maxStorageBufferBindingSize;
    for (let grid = wanted; grid > 1; grid--) {
      if (width * height * grid * grid * 8 <= limit) return grid;
    }
    return 1;
  }

  private moveField(request: RenderRequest, samples: number, key: string, reuse: boolean, grid = 1): boolean {
    const previous = this.fieldBuffer, previousCapacity = this.fieldCapacity;
    const mapping = reuse && previous && this.fieldView && this.sampleKey === key
      ? sampleGridRemap(this.fieldView, request) : null;
    this.reuseMapping = mapping; this.reusableView = this.fieldView; this.reusableComplete = this.fieldComplete;
    this.fieldComplete = false;
    if (!this.spareField || this.spareCapacity < samples) {
      this.spareField?.destroy();
      this.spareField = storageBuffer(this.ctx.device, samples * 2, "sample-field", GPUBufferUsage.COPY_SRC);
      this.spareCapacity = samples;
    }
    this.fieldBuffer = this.spareField; this.fieldCapacity = this.spareCapacity;
    this.spareField = previous; this.spareCapacity = previousCapacity;
    {
      const device = this.ctx.device;
      device.queue.writeBuffer(this.reuseUniform!, 0, new Int32Array([
        mapping ? this.fieldView!.width : 0, mapping ? this.fieldView!.height : 0,
        request.width * grid, request.height * grid,
        mapping?.offsetX ?? 0, mapping?.offsetY ?? 0, mapping?.step ?? 1, mapping?.denominator ?? 1,
      ]));
      const encoder = device.createCommandEncoder({ label: "retain-samples" });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.reusePipeline!);
      pass.setBindGroup(0, device.createBindGroup({ layout: this.reusePipeline!.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: previous ?? this.orbitBuffer! } },
        { binding: 1, resource: { buffer: this.fieldBuffer } },
        { binding: 2, resource: { buffer: this.reuseUniform! } },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(request.width * grid / 8), Math.ceil(request.height * grid / 8)); pass.end();
      device.queue.submit([encoder.finish()]);
    }
    this.fieldView = { centerX: request.centerX, centerY: request.centerY,
      unitsPerPixel: request.unitsPerPixel, width: request.width, height: request.height };
    this.sampleKey = key;
    return !!mapping;
  }

  private calculationView(request: RenderRequest): RenderRequest {
    if (!request.interacting || request.colors.supersample !== 1 || request.colors.mode !== 0) return request;
    this.gridAnchor ??= createSampleGridAnchor(this.fieldView ?? request);
    const old = this.fieldView;
    if (old) {
      const mapping = reprojectionFor(old, request);
      const spacing = old.unitsPerPixel.div(request.unitsPerPixel).toNumber();
      if (mapping && spacing <= 1.4 && mapping.offsetX >= 0 && mapping.offsetY >= 0 &&
          mapping.offsetX + mapping.scaleX <= 1 && mapping.offsetY + mapping.scaleY <= 1) {
        return { ...request, ...old };
      }
    }
    let desired = request;
    if (old && old.unitsPerPixel.lt(request.unitsPerPixel)) {
      const physicalSpacing = old.unitsPerPixel.div(request.unitsPerPixel.times(request.height).div(this.canvas.height)).toNumber();
      // Do not replace still-useful fine samples merely because the cost
      // estimate reduced the next request's budget.
      if (physicalSpacing >= .65) {
        const height = Math.ceil(request.unitsPerPixel.times(request.height).div(old.unitsPerPixel).toNumber());
        desired = { ...request, height, width: Math.ceil(height * request.width / request.height), unitsPerPixel: old.unitsPerPixel };
      }
    }
    return { ...request, ...planSampleGrid(desired, this.gridAnchor, { overscan: 1.2 }) };
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
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    const matchesView = (frame: WebGpuRenderer["lastFrame"]) => !this.currentView || frame &&
      frame.family === this.currentView.family && frame.maxIterations === this.currentView.maxIterations &&
      (frame.family !== "julia" || frame.juliaX?.eq(this.currentView.juliaX!) && frame.juliaY?.eq(this.currentView.juliaY!));
    const coverage = source === this.history && this.coverageFrame && matchesView(this.coverageFrame) && this.currentView
      ? reprojectionFor(this.coverageFrame, this.currentView) : null;
    const transforms = new Float32Array(20); transforms.set(xform);
    transforms[10] = source !== this.history || this.historyValid && matchesView(this.lastFrame) ? 1 : 0;
    if (source === this.target && !this.historyValid) transforms[10] = 0;
    if (coverage && this.coverageHistory) {
      transforms.set([coverage.scaleX, coverage.scaleY, coverage.offsetX, coverage.offsetY], 4);
      transforms[8] = 1;
      const front = this.lastFrame!, view = this.currentView!;
      const exactStationary = !view.interacting && front.width === view.width && front.height === view.height &&
        front.centerX.eq(view.centerX) && front.centerY.eq(view.centerY) && front.unitsPerPixel.eq(view.unitsPerPixel);
      transforms[9] = !exactStationary && this.coverageFrame!.unitsPerPixel.lt(front.unitsPerPixel) ? 1 : 0;
    }
    const fresh = this.incomingFrame, view = this.currentView;
    if (fresh && view && this.target && fresh.family === view.family && fresh.maxIterations === view.maxIterations &&
        (view.family !== "julia" || fresh.juliaX?.eq(view.juliaX!) && fresh.juliaY?.eq(view.juliaY!))) {
      const m = reprojectionFor(fresh, view);
      if (m) {
        transforms.set([m.scaleX, m.scaleY, m.offsetX, m.offsetY], 12);
        transforms[16] = 1;
        const exact = !view.interacting && fresh.width === view.width && fresh.height === view.height &&
          fresh.centerX.eq(view.centerX) && fresh.centerY.eq(view.centerY) && fresh.unitsPerPixel.eq(view.unitsPerPixel);
        transforms[17] = exact || !this.lastFrame || fresh.unitsPerPixel.lte(this.lastFrame.unitsPerPixel) ? 1 : 0;
        transforms[18] = exact || !this.coverageFrame || fresh.unitsPerPixel.lte(this.coverageFrame.unitsPerPixel) ? 1 : 0;
      }
    }
    device.queue.writeBuffer(this.xformBuffer, 0, transforms);

    const bind = device.createBindGroup({
      layout: this.blitPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.xformBuffer } },
        { binding: 3, resource: (this.coverageHistory ?? source).createView() },
        { binding: 4, resource: (this.target ?? source).createView() },
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
    this.currentView = request;
    const last = this.historyValid ? this.lastFrame : this.incomingFrame;
    const source = this.historyValid ? this.history : this.target;
    if (!last || !source || !this.blitPipeline) {
      return false;
    }
    const compatible = (frame: WebGpuRenderer["lastFrame"]) => frame && frame.family === request.family &&
      frame.maxIterations === request.maxIterations && (request.family !== "julia" ||
        frame.juliaX?.eq(request.juliaX!) && frame.juliaY?.eq(request.juliaY!));
    const incomingAvailable = compatible(this.incomingFrame) && reprojectionFor(this.incomingFrame!, request);
    if (!compatible(last) && !incomingAvailable) return false;

    let mapping = compatible(last) ? reprojectionFor(last, request) : null;
    if (!mapping) {
      if (!incomingAvailable && (!compatible(this.coverageFrame) || !reprojectionFor(this.coverageFrame!, request))) return false;
      // The narrow front may be outside its useful range while the retained
      // broader source still covers the view. Mark the front as unavailable.
      mapping = { scaleX: 0, scaleY: 0, offsetX: -1, offsetY: -1 };
    }

    const encoder = this.ctx.device.createCommandEncoder({ label: "reproject" });
    this.encodeBlit(
      encoder,
      source,
      new Float32Array([mapping.scaleX, mapping.scaleY, mapping.offsetX, mapping.offsetY])
    );
    this.ctx.device.queue.submit([encoder.finish()]);
    return true;
  }

  async debugReadField(): Promise<Float32Array> {
    if (!this.fieldBuffer) return new Float32Array();
    return new Float32Array(await readBuffer(this.ctx.device,this.fieldBuffer,this.targetSize.width*this.targetSize.height*8));
  }
  invalidateHistory() {
    this.publicationEpoch++; this.historyValid=false; this.refValid=false;
    this.incomingFrame=null; this.fieldComplete=false;
    this.coverageFrame=null; this.coverageHistory?.destroy(); this.coverageHistory=null;
    this.gridAnchor=null; this.fieldView=null; this.sampleKey=""; this.fieldKey=""; this.cachedRequest="";
    this.abort();
  }
  async render(request: RenderRequest): Promise<RenderStats> {
    const { device } = this.ctx;
    const epoch = this.publicationEpoch;
    const originalCurrent = request.isCurrent;
    request = { ...request, colors: { ...request.colors, stops: [...request.colors.stops] },
      isCurrent: () => epoch === this.publicationEpoch && (!originalCurrent || originalCurrent()) };
    request = this.calculationView(request);
    const requestKey = [request.centerX, request.centerY, request.unitsPerPixel, request.width, request.height,
      request.family, request.juliaX, request.juliaY, request.maxIterations, request.forceMethod, request.useApprox,
      JSON.stringify(request.colors)].join("|");
    if (requestKey === this.cachedRequest && this.cachedStats && this.historyValid && request.isCurrent!()) {
      return { ...this.cachedStats, computed: false, computedSamples: 0,
        reusedSamples: request.width * request.height, orbitMs: 0, pipelineWaitMs: 0, tableMs: 0, renderMs: 0 };
    }
    if (!this.renderPipeline || !this.blitPipeline) {
      throw new Error("WebGpuRenderer.init() was not awaited");
    }

    const method = request.forceMethod ?? methodForScale(request.unitsPerPixel);
    const wide = request.family === "julia" || method !== Method.Direct;
    const limbs = limbsForScale(request.unitsPerPixel, wide ? 96 : 48);
    Decimal.set({ precision: Math.max(Decimal.precision,Math.ceil((32 * (limbs - 1)) / 3.32) + 10) });

    // Reuse the reference orbit while the view stays near the point it was
    // built at. Regenerating costs tens of milliseconds, so doing it every
    // frame would make panning unusable at depth.
    const halfSpan = request.unitsPerPixel.times(
      Math.min(request.width, request.height) / 2
    );
    let drift = request.centerX
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
    const canRebuild = !request.interacting || !this.refValid || limbs !== this.refLimbs;

    let orbitMs = 0;
    this.pipelineWaitMs = 0;
    this.tableMs = 0;
    if (method !== Method.Direct && stale && canRebuild) {
      this.refFamily=family; this.refConstant=constant;
      this.refX = request.centerX;
      this.refY = request.centerY;
      const orbit = await this.generateOrbit(request, limbs);
      if (!request.isCurrent!()) { this.refValid=false; throw new DOMException("Superseded reference", "AbortError"); }
      this.refLimbs = limbs;
      this.refIterations = request.maxIterations;
      this.refLength = orbit.length;
      this.refEscaped = orbit.escaped;
      this.refValid = true;
      drift = new Decimal(0);
      orbitMs = orbit.ms;
      this.tableMs = 0;
      this.laLevels=0;
      if (method === Method.Hdr && family === "mandelbrot") await this.buildApproxTable(request);
    }
    // Reversal/overscan can need a larger delta domain without needing a new
    // orbit. Rebuild the inexpensive table for that domain instead of silently
    // turning acceleration off for the whole expanded field.
    const requiredDelta = request.unitsPerPixel.times(Math.hypot(request.width, request.height) / 2).plus(drift).toNumber();
    if (method === Method.Hdr && family === "mandelbrot" && request.useApprox !== false && request.colors.mode === 0 &&
        requiredDelta > this.tableMaxDelta * (1 + 1e-12)) {
      await this.buildApproxTable(request);
    }

    const started = performance.now();
    if (!request.isCurrent!()) throw new DOMException("Superseded render", "AbortError");
    // Every buffer in the bind group must exist even when this method does not
    // read it: the direct path builds neither an orbit nor a skip table.
    this.ensureOrbitCapacity(1);
    if (!this.laBuffer || !this.laIndexBuffer) {
      this.laBuffer = storageBuffer(device, ENTRY_FLOATS, "la-table");
      this.laIndexBuffer = storageBuffer(device, 2, "la-index");
    }
    this.incomingFrame = null;
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
    const deltaBound = requiredDelta;
    const approximationLevels =
      request.useApprox === false || method !== Method.Hdr || family === "julia" || colors.mode === 1 || deltaBound > this.tableMaxDelta * (1 + 1e-12) ? 0 : this.laLevels;
    u32[20] = approximationLevels;
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
    if (family === "julia" || method !== Method.Direct) {
      const offsetPower = new Decimal(2).pow(offset.exponent);
      [request.unitsPerPixel.div(power), request.centerX.minus(this.refX).div(offsetPower),
        request.centerY.minus(this.refY).div(offsetPower), request.centerX, request.centerY,
        request.juliaX ?? new Decimal(0), request.juliaY ?? new Decimal(0)].forEach((value, i) => f32.set(splitQuad(value), 56 + i * 4));
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
    const sampleKey = [family, constant, request.maxIterations, colors.mode, grid, method,
      limbs, this.refLimbs, !!u32[20], request.useApprox].join("|");
    if (fieldStale) {
      this.moveField(request, request.width * request.height * grid * grid, sampleKey,
        grid === 1 && colors.mode === 0, grid);
      u32[41] = grid === 1 && colors.mode === 0 ? 1 : 0;
      device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    }

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

    const frame = {
      family: request.family, juliaX: request.juliaX, juliaY: request.juliaY,
      centerX: request.centerX, centerY: request.centerY,
      unitsPerPixel: request.unitsPerPixel, width: request.width, height: request.height,
      colors: request.colors, maxIterations: request.maxIterations,
    };
    const progressive = colors.mode === 0 && grid === 1;
    let timingSamples: (TimingSample | undefined)[] = [];
    const collectTimings = () => { timingSamples.forEach(s => this.timing.collect(s)); timingSamples = []; };
    const shade = (encoder: GPUCommandEncoder, width: number, height: number) => {
      const sample = this.timing.begin("shade");
      const pass = encoder.beginComputePass({ label: "shade-region", timestampWrites: this.timing.writes(sample) });
      pass.setPipeline(this.shadePipeline!); pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
      this.timing.resolve(encoder, sample); timingSamples.push(sample);
    };
    this.aborted = false; this.abortRequested = false;
    this.partialRegions = 0; this.firstPartialAt = 0;
    let completed = true, cpuReused = 0;
    u32[40] = 0; u32[42] = 0; u32[43] = request.width;
    device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    if (fieldStale) {
      // Initialize once: copied exact samples become visible, unknown positions
      // have zero alpha. A recycled allocation never supplies validity.
      const init = device.createCommandEncoder({ label: "initialize-incoming" });
      shade(init, request.width, request.height);
      device.queue.submit([init.finish()]);
      collectTimings();
      if (progressive && request.isCurrent!()) this.incomingFrame = frame;
    }
    type Region = { x: number; y: number; width: number; height: number };
    const regions: Region[] = [];
    const add = (x: number, y: number, width: number, height: number) => {
      if (width > 0 && height > 0) regions.push({ x, y, width, height });
    };
    // Work visible on screen before the padded margins. All internal boundaries
    // are workgroup aligned, so no invocation can overwrite a neighbouring job.
    const visible = reprojectionFor(request, this.currentView ?? request);
    const left = visible ? Math.max(0, Math.min(request.width, Math.floor(visible.offsetX * request.width / 8) * 8)) : 0;
    const top = visible ? Math.max(0, Math.min(request.height, Math.floor(visible.offsetY * request.height / 8) * 8)) : 0;
    const right = visible ? Math.max(left, Math.min(request.width, Math.ceil((visible.offsetX + visible.scaleX) * request.width / 8) * 8)) : request.width;
    const bottom = visible ? Math.max(top, Math.min(request.height, Math.ceil((visible.offsetY + visible.scaleY) * request.height / 8) * 8)) : request.height;
    if (fieldStale) {
      add(left, top, right-left, bottom-top);
      add(0, 0, request.width, top); add(0, bottom, request.width, request.height-bottom);
      add(0, top, left, bottom-top); add(right, top, request.width-right, bottom-top);
    }
    while (regions.length) {
      const region = regions.shift()!;
      // Fence callback latency is not proportional to sample count. The floor
      // also preserves GPU throughput on expensive fields with cheap rows.
      const budget = this.batchMsPerSample > 0 ? Math.max(MIN_BATCH_SAMPLES, SUBMIT_BUDGET_MS / this.batchMsPerSample) : MIN_BATCH_SAMPLES;
      const width = region.width;
      const rows = Math.min(region.height, Math.max(8, Math.ceil((request.tileRows ?? budget / width) / 8) * 8));
      // Finish the selected visible rectangle before its overscan siblings.
      if (region.height > rows) regions.unshift({ ...region, y: region.y + rows, height: region.height - rows });
      if (region.width > width) regions.unshift({ x: region.x + width, y: region.y, width: region.width - width, height: rows });
      const m = this.reuseMapping, old = this.reusableView;
      const fullyKnown = this.reusableComplete && m && old && m.denominator === 1 &&
        m.offsetX + region.x * m.step >= 0 && m.offsetY + region.y * m.step >= 0 &&
        m.offsetX + (region.x + width - 1) * m.step < old.width &&
        m.offsetY + (region.y + rows - 1) * m.step < old.height;
      if (fullyKnown) { cpuReused += width * rows; continue; }
      u32[40] = region.y; u32[42] = region.x; u32[43] = region.x + width;
      device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
      const batchStarted = performance.now();
      const encoder = device.createCommandEncoder({ label: "calculate-region" });
      const sample = this.timing.begin("calculate");
      const pass = encoder.beginComputePass({ label: "calculate-region", timestampWrites: this.timing.writes(sample) });
      pass.setPipeline(family === "julia" ? this.juliaPipeline! : method === Method.Direct ? this.directPipeline! :
        approximationLevels > 0 ? this.approxPipeline! : this.renderPipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(rows / 8)); pass.end();
      this.timing.resolve(encoder, sample); timingSamples.push(sample);
      if (progressive) shade(encoder, width, rows);
      device.queue.submit([encoder.finish()]);
      collectTimings();
      if (progressive && request.isCurrent!()) {
        this.incomingFrame = frame; this.partialSerial++; this.partialRegions++;
        this.firstPartialAt ||= performance.now();
        // A render can also be used outside the application's animation loop.
        // Queue order presents only finished regions, never in-flight writes.
        this.reproject(this.currentView ?? request);
      }
      await device.queue.onSubmittedWorkDone();
      const elapsed = performance.now() - batchStarted;
      const cost = elapsed / (width * rows);
      this.batchMsPerSample = this.batchMsPerSample ? .75 * this.batchMsPerSample + .25 * cost : cost;
      await yieldToEvents();
      const settledDuringMotion = request.interacting && this.currentView && !this.currentView.interacting;
      if (!request.isCurrent!() || this.abortRequested || settledDuringMotion) {
        completed = false; this.aborted = true; break;
      }
    }
    if (!request.isCurrent!()) completed = false;
    this.fieldKey = completed ? fieldKey : "";
    if (request.isCurrent!()) this.fieldComplete = completed;

    // Only completed fields enter retained history. Streaming already shaded
    // its individual regions; recolours and neighbour-dependent distance
    // lighting shade once here. Unknown partial samples stay out of history.
    if (completed) {
      const encoder = device.createCommandEncoder({ label: "shade" });
      u32[40] = 0; u32[42] = 0; u32[43] = request.width;
      device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
      if (!fieldStale || !progressive) shade(encoder, request.width, request.height);
      // Presentation belongs to the current camera, not this possibly older request.
      this.ensureHistory(request);
      encoder.copyTextureToTexture(
        { texture: this.target! },
        { texture: this.history! },
        { width: request.width, height: request.height }
      );
      device.queue.submit([encoder.finish()]);
      collectTimings();
      // Queue order makes subsequent blits see these pixels. Publish their
      // description in the same JS turn, before any fence/readback can yield.
      this.lastFrame = {
        family: request.family, juliaX: request.juliaX, juliaY: request.juliaY,
        centerX: request.centerX, centerY: request.centerY,
        unitsPerPixel: request.unitsPerPixel, width: request.width, height: request.height,
        colors: request.colors, maxIterations: request.maxIterations,
      };
      this.historyValid = true; this.incomingFrame = null;
    }

    // Mapping the counters also fences the final copy; no redundant queue-wide
    // completion round trip before the readback.
    const counters = new Uint32Array(await readBuffer(device, this.statsBuffer, 32));
    const renderMs = performance.now() - started;
    // Invalidation owns visibility. An older asynchronous completion must not
    // clear or replace a publication belonging to a newer epoch.
    if(request.isCurrent && !request.isCurrent()) completed=false;
    if (!completed) {
      this.cachedRequest = "";
      // The invalidator already cleared incompatible geometry. A compatible
      // interrupted field retains its exact samples and unknown sentinels.
      if (epoch !== this.publicationEpoch) this.incomingFrame = null;
    }
    const skippedIterations = counters[0];
    const plainIterations = counters[3];
    const total = skippedIterations + plainIterations;

    const result: RenderStats = {
      completed, computed: fieldStale,
      computedSamples: counters[5], reusedSamples: counters[6] + cpuReused,
      sampleWidth: request.width, sampleHeight: request.height,
      limbs,
      decimalDigits: Math.floor((32 * (limbs - 1)) / 3.32),
      orbitLength: this.refLength,
      orbitEscaped: this.refEscaped,
      orbitMs,
      pipelineWaitMs: this.pipelineWaitMs,
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
    if (completed && request.isCurrent!()) {
      this.cachedStats = result; this.cachedRequest = requestKey;
      // Small exposed strips are dominated by dispatch overhead; learn cost
      // from substantial numerical work instead of inflating the next budget.
      if (counters[5] > request.width * request.height * .2) {
        const cost = renderMs / counters[5];
        this.msPerSample = this.msPerSample ? .75 * this.msPerSample + .25 * cost : cost;
      }
      if (!request.interacting) this.gridAnchor = createSampleGridAnchor(request);
    }
    return result;
  }
}
