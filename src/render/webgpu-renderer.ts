/**
 * WebGPU rendering path: arbitrary-precision reference orbit in a dedicated
 * CPU worker, then a perturbation compute pass whose per-pixel deltas carry
 * their own exponent.
 *
 * Unlike the WebGL path there is no f32 underflow floor, so zoom depth is
 * bounded by the precision profile (limb count) rather than by the renderer.
 */

import Decimal from "decimal.js";
import { compileShader, readBuffer, storageBuffer, type GpuContext } from "../gpu/device";
import { GpuTiming, type TimingSample } from "../gpu/timing";
import compensatedSource from "../arithmetic/compensated.wgsl?raw";
import quadSource from "../arithmetic/quad.wgsl?raw";
import perturbationSource from "./perturbation.wgsl?raw";
import wideSource from "./wide.wgsl?raw";
import reuseSource from "./reuse.wgsl?raw";
import antialiasSource from "./antialias.wgsl?raw";
export const ANTIALIAS_SHADER=antialiasSource;
import { createSampleGridAnchor, planRetainedView, sampleGridRemap, type SampleGridAnchor, type SampleGridRemap } from "./sample-grid";
import { PendingRegions, CoverageRegions, type Demand } from "./regions";
import type { FrameView } from "./reprojection";
import { splitQuad } from "../arithmetic/quad";
import { reprojectionFor } from "./reprojection";
import { ReferenceWorkerClient } from "./reference-worker-client";
import type { ReferenceOrbitInput } from "./reference-orbit";

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
import { hexToRgb, MAX_STOPS, stopPositions, needsEndpoints, type ColorSettings } from "../logic/colorSettings";
import { BASE_STEP, ENTRY_FLOATS, buildBlaAsync } from "./bla";

/** Precision profiles, chosen from the zoom depth. */
const LIMB_PROFILES = [8, 16, 32, 64, 128, 256] as const;
const SUBMIT_BUDGET_MS = 8;

// 64K expensive samples measured >120ms; 16K preserved presentation cadence.
// Grow cheap batches from measured cost, without changing policy on release.
const MIN_BATCH_SAMPLES = 16_384;

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
  /** Input status for callers and diagnostics; geometry governs calculation. */
  interacting?: boolean;
  /** Follow live demand until its exact field is complete. Preview/one-shot
   * callers use the same region queue without following another camera. */
  followView?: boolean;
  betweenBatches?: () => Promise<void>;
  /** Preview callers publish only complete images and matching metadata. */
  publishPartial?: boolean;
  focus?: { x: number; y: number };
  zoom?: number;
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
export function binaryExponent(value: Decimal): number {
  const magnitude = value.abs();
  const decimalExponent = magnitude.e;
  const leading = magnitude
    .div(new Decimal(10).pow(decimalExponent))
    .toSignificantDigits(16)
    .toNumber();
  let exponent = Math.floor(Math.log2(leading) + decimalExponent * Math.LOG2E * Math.LN10);
  let power = new Decimal(2).pow(exponent);
  if (magnitude.lt(power)) {
    exponent--;
    power = power.div(2);
  }
  if (magnitude.gte(power.times(2))) exponent++;
  return exponent;
}
function splitExponent(value: Decimal): { mantissa: number; exponent: number } {
  if (value.isZero()) return { mantissa: 0, exponent: 0 };
  const exponent = binaryExponent(value);
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
  const exponent = binaryExponent(magnitude);
  const divisor = new Decimal(2).pow(exponent);
  return {
    x: Number(x.div(divisor).toFixed(12)),
    y: Number(y.div(divisor).toFixed(12)),
    exponent,
  };
}

interface ReferenceDemand {
  input: ReferenceOrbitInput;
  centerX: Decimal;
  centerY: Decimal;
  followView: boolean;
}

async function readTexturePoints(device:GPUDevice,texture:GPUTexture,size:{width:number;height:number},points:[number,number][]):Promise<number[][]>{
  const {width,height}=size,bytesPerRow=Math.ceil(width*4/256)*256;
  const staging=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});let mapped=false;
  try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:staging,bytesPerRow,rowsPerImage:height},{width,height});device.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);mapped=true;const bytes=new Uint8Array(staging.getMappedRange());return points.map(([x,y])=>{const i=y*bytesPerRow+x*4;return [bytes[i],bytes[i+1],bytes[i+2],bytes[i+3]];});}
  finally{if(mapped)staging.unmap();staging.destroy();}
}

export interface WebGpuRenderer {
  debugReadOrbit(count:number):Promise<Float32Array>;
  debugReadPixels(points:[number,number][]):Promise<number[][]>;
  debugReadAntialiasPixels(points:[number,number][]):Promise<number[][]>;
  debugReadField():Promise<Float32Array>;
}

export class WebGpuRenderer {
  private ctx: GpuContext;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;

  private pipelineWaitMs = 0;
  private renderPipeline: GPUComputePipeline | null = null;
  private directPipeline: GPUComputePipeline | null = null;
  private approxPipeline: GPUComputePipeline | null = null;
  private juliaPipeline: GPUComputePipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;
  private retainPipeline: GPURenderPipeline | null = null;
  private retainFloatPipeline: GPURenderPipeline | null = null;
  private antialiasPipeline: GPURenderPipeline | null = null;
  private antialiasTexture: GPUTexture | null = null;
  private antialiasSize = {width:0,height:0};
  private antialiasFrame: WebGpuRenderer["lastFrame"] = null;

  private target: GPUTexture | null = null;
  private targetSize = { width: 0, height: 0 };
  private sampler: GPUSampler;
  private antialiasSampler: GPUSampler;

  private uniformBuffer: GPUBuffer;
  private stopsBuffer: GPUBuffer;
  private tableMs = 0;
  private tableMaxDelta = 0;
  /** Geometry and density of the retained history image. */
  private lastFrame: {
    proxy?: boolean;
    covered?: {x:number;y:number;width:number;height:number};
    coveredSpacing?: Decimal;
    coveredRegions?: {x:number;y:number;width:number;height:number;spacing:Decimal}[];
    family?: "mandelbrot" | "julia";
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
  private lastPartialAt = 0;
  private fieldComplete = false;
  private reuseMapping: SampleGridRemap | null = null;
  private reusableView: FrameView | null = null;
  private reusableComplete = false;
  private batchMsPerSample = 0;
  private batchCostKey = "";
  private retainedAnchor: SampleGridAnchor | null = null;
  private pending = new PendingRegions();
  private retarget = false;
  private determinedRegion: {x:number;y:number;width:number;height:number} | null = null;
  private determinedSpacing: Decimal | undefined;
  private determined = new CoverageRegions();
  private streamTargets = 0;
  private latestRegion: {x:number;y:number;width:number;height:number} | null = null;
  private exactCompletedSamples=0;
  private exactTotalSamples=0;
  private referencePreparing=false;
  private finalizing=false;
  private calculationSubmissions=0;
  private orbitSubmissions=0;
  private antialiasPasses=0;
  private timing: GpuTiming;
  setProfiling(enabled: boolean) { this.timing.setEnabled(enabled); }
  performance() { return this.timing.snapshot(); }
  debugProgress() {
    const progressCurrent=!!(this.currentView&&this.fieldView&&this.sameView(this.fieldView,this.currentView));
    const complete=!this.referencePreparing&&!!this.currentView&&this.isComplete(this.currentView)&&this.pending.size===0&&!this.incomingFrame&&!this.finalizing;
    const percentage=this.referencePreparing||!progressCurrent?null:complete&&this.exactTotalSamples?100:this.exactTotalSamples?Math.min(99,Math.floor(this.exactCompletedSamples/this.exactTotalSamples*100)):null;
    let fieldHash=2166136261;for(let i=0;i<this.fieldKey.length;i++){fieldHash^=this.fieldKey.charCodeAt(i);fieldHash=Math.imul(fieldHash,16777619);}
    return { epoch: this.publicationEpoch, serial: this.partialSerial, fieldIdentity:(fieldHash>>>0).toString(16).padStart(8,'0'),
      regions: this.partialRegions, firstPublicationAt: this.firstPartialAt, lastPublicationAt: this.lastPartialAt,
      active: !!this.incomingFrame, complete, percentage, exactCompletedSamples:this.exactCompletedSamples, exactTotalSamples:this.exactTotalSamples,
      referencePreparing:this.referencePreparing, finalizing:this.finalizing, calculationSubmissions:this.calculationSubmissions, orbitSubmissions:this.orbitSubmissions, antialiasPasses:this.antialiasPasses,
      referenceWorkerActive:this.referenceWorker.active,
      pending: this.pending.size, targets: this.streamTargets, latestRegion: this.latestRegion,
      width: this.fieldView?.width ?? 0, height: this.fieldView?.height ?? 0 };
  }
  private abortRequested = false;
  private shadePipeline: GPUComputePipeline | null = null;
  private bindLayout: GPUBindGroupLayout | null = null;
  private fieldBuffer: GPUBuffer | null = null;
  private fieldCapacity = 0;
  private endpointBuffer:GPUBuffer|null=null;
  private endpointCapacity=0;
  private retainEndpoints=false;
  private spareField: GPUBuffer | null = null;
  private spareCapacity = 0;
  private fieldView: FrameView | null = null;
  private sampleKey = "";
  private reusePipeline: GPUComputePipeline | null = null;
  private reuseUniform: GPUBuffer | null = null;
  private cachedStats: RenderStats | null = null;
  private cachedRequest = "";

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
  private referenceWorker = new ReferenceWorkerClient();
  private pendingReferenceDemand: ReferenceDemand | null = null;

  /** Cached reference orbit: regenerating it per frame would kill panning. */
  private refX = new Decimal(0);
  private refY = new Decimal(0);
  private refLimbs = 0;
  private refIterations = 0;
  private refLength = 0;
  private refEscaped = false;
  private refValid = false;
  private refSamples: Float32Array | null = null;
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
    this.antialiasSampler=ctx.device.createSampler({magFilter:'linear',minFilter:'linear'});
    this.uniformBuffer = ctx.device.createBuffer({
      size: 368,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.stopsBuffer = storageBuffer(ctx.device, MAX_STOPS * 4, "palette-stops");
    this.statsBuffer = storageBuffer(
      ctx.device,
      12,
      "render-stats",
      GPUBufferUsage.COPY_SRC
    );
    if(import.meta.env.DEV)Object.assign(this,{
      debugReadOrbit:async(count:number)=>{if(!this.orbitBuffer)return new Float32Array(0);const n=Math.min(count,this.orbitCapacity),stride=20,raw=new Float32Array(await readBuffer(this.ctx.device,this.orbitBuffer,n*stride*4)),absolute=new Float32Array(n*6);for(let i=0;i<n;i++){const at=i*stride;absolute.set([raw[at],raw[at+1],raw[at+4],raw[at+5],raw[at+6],raw[at+9]],i*6);}return absolute;},
      debugReadPixels:async(points:[number,number][])=>this.target?readTexturePoints(this.ctx.device,this.target,this.targetSize,points):[],
      debugReadAntialiasPixels:async(points:[number,number][])=>this.antialiasTexture?readTexturePoints(this.ctx.device,this.antialiasTexture,this.antialiasSize,points):[],
      debugReadField:async()=>this.fieldBuffer?new Float32Array(await readBuffer(this.ctx.device,this.fieldBuffer,this.targetSize.width*this.targetSize.height*8)):new Float32Array(),
    });
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
        storage("storage", 8),
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
struct Presentation { front: vec4<f32>, back: vec4<f32>, options: vec4<f32>, fresh: vec4<f32>, freshOptions: vec4<f32>, units: vec4<f32> };
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
    var frontValid = display.options.z > 0.0 && all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
    var backValid = display.options.x > 0.0 && all(oldUV >= vec2<f32>(0.0)) && all(oldUV <= vec2<f32>(1.0));
    // Select an actual determined sample. Never blend the two images, and do
    // not let a smaller new field erase already calculated coverage.
    let front = textureSample(src, smp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)));
    let back = textureSample(coverage, smp, clamp(oldUV, vec2<f32>(0.0), vec2<f32>(1.0)));
    frontValid = frontValid && front.a > 0.0;
    backValid = backValid && back.a > 0.0;
    let frontSpacing=display.units.x / max(front.a, 0.00001);
    let backSpacing=display.units.y / max(back.a, 0.00001);
    let useBack = backValid && (!frontValid || display.options.y > 0.0 ||
        (display.options.y < 0.0 && backSpacing < frontSpacing));
    var spacing=select(frontSpacing,backSpacing,useBack);
    var result = select(front, back, useBack);
    let freshUV = in.uv * display.fresh.xy + display.fresh.zw;
    let fresh = textureSample(incoming, smp, clamp(freshUV, vec2<f32>(0.0), vec2<f32>(1.0)));
    let valid = display.freshOptions.x > 0.0 && fresh.a > 0.0 && all(freshUV >= vec2<f32>(0.0)) && all(freshUV <= vec2<f32>(1.0));
    let freshSpacing=display.units.z / max(fresh.a,0.00001);
    let prefer = (fresh.a > 0.99 && select(display.freshOptions.y, display.freshOptions.z, useBack) > 0.0) || freshSpacing < spacing;
    if (valid && (prefer || (!frontValid && !backValid))) { result = fresh; spacing=freshSpacing; }
    if (!frontValid && !backValid && !valid) {
        // The canvas is opaque: even alpha-zero RGB would be visible there.
        // Extend only an actual defined edge sample, never transparent proxy
        // payload or an unavailable mapping. Keep the fallback's alpha zero.
        result = vec4<f32>(0.0);
        if (display.options.z > 0.0 && front.a > 0.0) { result = front; }
        else if (display.options.x > 0.0 && back.a > 0.0) { result = back; }
        else if (display.freshOptions.x > 0.0 && fresh.a > 0.0) { result = fresh; }
    }
    return vec4<f32>(result.rgb, select(0.0, min(1.0, 1.0 / max(spacing,0.00001)), frontValid || backValid || valid));
}
`,
      "blit"
    );
    const blitDescriptor = (format: GPUTextureFormat): GPURenderPipelineDescriptor => ({
      label: "blit", layout: "auto",
      vertex: { module: blitModule, entryPoint: "vs" },
      fragment: { module: blitModule, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-strip" },
    });
    this.blitPipeline = device.createRenderPipeline(blitDescriptor(this.format));
    this.retainPipeline = device.createRenderPipeline(blitDescriptor("rgba8unorm"));
    this.retainFloatPipeline = device.createRenderPipeline(blitDescriptor("rgba16float"));
    const antialiasModule=await compileShader(device,antialiasSource,'completed-image-antialias');
    this.antialiasPipeline=device.createRenderPipeline({label:'completed-image-antialias',layout:'auto',vertex:{module:antialiasModule,entryPoint:'vs'},fragment:{module:antialiasModule,entryPoint:'fs',targets:[{format:'rgba8unorm-srgb'}]},primitive:{topology:'triangle-strip'}});
  }

  private referenceDemand(request: RenderRequest, limbs: number): ReferenceDemand {
    const family = request.family ?? "mandelbrot";
    return {
      centerX: request.centerX,
      centerY: request.centerY,
      followView: !!request.followView,
      input: {
        family,
        centerX: request.centerX.toFixed(), centerY: request.centerY.toFixed(),
        juliaX: request.juliaX?.toFixed() ?? "0", juliaY: request.juliaY?.toFixed() ?? "0",
        limbs, maxIterations: request.maxIterations,
      },
    };
  }

  private referenceDemandCompatible(demand: ReferenceDemand, request: RenderRequest): boolean {
    const method = request.forceMethod ?? methodForScale(request.unitsPerPixel);
    if (method === Method.Direct) return false;
    const family = request.family ?? "mandelbrot";
    if (family !== demand.input.family || request.maxIterations > demand.input.maxIterations) return false;
    if (family === "julia" &&
        (request.juliaX?.toFixed() !== demand.input.juliaX || request.juliaY?.toFixed() !== demand.input.juliaY)) return false;
    let limbs: number;
    try { limbs = limbsForScale(request.unitsPerPixel, 96); }
    catch { return false; }
    if (limbs !== demand.input.limbs) return false;
    const halfSpan = request.unitsPerPixel.times(Math.min(request.width, request.height) / 2);
    const drift = request.centerX.minus(demand.centerX).abs().plus(request.centerY.minus(demand.centerY).abs());
    return drift.lessThanOrEqualTo(halfSpan.times(0.5));
  }

  private cancelPendingReference(message: string) {
    if (!this.pendingReferenceDemand && !this.referenceWorker.active) return;
    this.pendingReferenceDemand = null;
    this.referenceWorker.cancel(message);
  }

  /** Generates and transfers the packed reference in one persistent worker. */
  private async generateOrbit(
    request: RenderRequest,
    limbs: number
  ): Promise<{ length: number; escaped: boolean; ms: number; samples: Float32Array }> {
    const started = performance.now(), demand = this.referenceDemand(request, limbs);
    const requestedBytes=(request.maxIterations+1)*20*Float32Array.BYTES_PER_ELEMENT;
    if(requestedBytes>Math.min(this.ctx.device.limits.maxStorageBufferBindingSize,this.ctx.device.limits.maxBufferSize)) {
      throw new Error("The reference orbit exceeds this GPU's buffer capacity.");
    }
    this.pendingReferenceDemand = demand;
    this.pipelineWaitMs = 0;
    try {
      const orbit = await this.referenceWorker.generate(demand.input);
      const live = demand.followView ? this.currentView ?? request : request;
      if (this.pendingReferenceDemand !== demand || request.isCurrent && !request.isCurrent() || !this.referenceDemandCompatible(demand, live)) {
        throw new DOMException("Superseded reference", "AbortError");
      }
      const samples = new Float32Array(orbit.buffer);
      if (samples.length !== orbit.length * 20) throw new Error("Reference worker returned an invalid sample buffer");
      let target=this.orbitBuffer,replacement:GPUBuffer|null=null;
      if(!target||this.orbitCapacity<orbit.length){
        replacement=storageBuffer(this.ctx.device,orbit.length*20,"reference-orbit",GPUBufferUsage.COPY_SRC);
        target=replacement;
      }
      try{this.ctx.device.queue.writeBuffer(target,0,samples);}
      catch(error){replacement?.destroy();throw error;}
      if(replacement){const previous=this.orbitBuffer;this.orbitBuffer=replacement;this.orbitCapacity=orbit.length;previous?.destroy();}
      return { length: orbit.length, escaped: orbit.escaped, ms: performance.now() - started, samples };
    } finally {
      if (this.pendingReferenceDemand === demand) this.pendingReferenceDemand = null;
    }
  }

  /**
   * Builds the linear-approximation table from the freshly generated orbit.
   *
   * The transferred CPU orbit remains available for this one table build per
   * reference. The table then lets each pixel jump whole ranges of reference
   * iterations instead of stepping through them.
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

    const samples = this.refSamples;
    if (!samples || samples.length !== this.refLength * 20) {
      throw new Error("The CPU reference orbit is unavailable for approximation");
    }
    const table = await buildBlaAsync(samples, this.refLength, halfDiagonal, async()=>{
      await yieldToEvents();
      if(this.abortRequested||request.isCurrent&&!request.isCurrent())throw new DOMException("Superseded table","AbortError");
    }, { sampleWords: 20 });
    if(table.data.byteLength>Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize))throw Error('The approximation table exceeds this GPU’s buffer capacity.');
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
    const compatible = (frame: WebGpuRenderer["lastFrame"]) => this.samePresentation(frame,request);
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
    const keepFront = this.historyValid && !this.lastFrame?.proxy && compatible(this.lastFrame) &&
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
    if (available && (available.usage & GPUTextureUsage.COPY_DST) && available.width === width && available.height === height) this.history = available;
    else {
      available?.destroy();
      this.history = this.ctx.device.createTexture({
        label: "last-complete-frame",
        size: { width, height },
        format: "rgba8unorm",
        viewFormats: ["rgba8unorm-srgb"],
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
    }
    this.historySize = { width, height };
    this.historyValid = false;
  }

  private ensureAntialias(width:number,height:number){
    if(this.antialiasTexture&&this.antialiasSize.width===width&&this.antialiasSize.height===height)return;
    this.antialiasTexture?.destroy();
    this.antialiasTexture=this.ctx.device.createTexture({label:'completed-image-antialias',size:{width,height},format:'rgba8unorm',viewFormats:['rgba8unorm-srgb'],usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
    this.antialiasSize={width,height};this.antialiasFrame=null;
  }

  private encodeAntialias(encoder:GPUCommandEncoder,source:GPUTexture,width:number,height:number,timingSamples:(TimingSample|undefined)[]){
    this.ensureAntialias(width,height);const sample=this.timing.begin('antialias');
    const pass=encoder.beginRenderPass({label:'completed-image-antialias',timestampWrites:this.timing.writes(sample) as GPURenderPassTimestampWrites|undefined,colorAttachments:[{view:this.antialiasTexture!.createView({format:'rgba8unorm-srgb'}),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});
    pass.setPipeline(this.antialiasPipeline!);pass.setBindGroup(0,this.ctx.device.createBindGroup({layout:this.antialiasPipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:source.createView({format:'rgba8unorm-srgb'})},{binding:1,resource:this.antialiasSampler}]}));pass.draw(4);pass.end();
    this.timing.resolve(encoder,sample);timingSamples.push(sample);this.antialiasPasses++;
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

  private ensureOrbitCapacity(samples: number) {
    if (this.orbitCapacity >= samples && this.orbitBuffer) return;
    if(samples*80>Math.min(this.ctx.device.limits.maxStorageBufferBindingSize,this.ctx.device.limits.maxBufferSize))throw Error('This iteration limit exceeds this GPU’s reference buffer capacity.');
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
    xform: Float32Array,
    destination?: GPUTexture
  ) {
    const { device } = this.ctx;
    if (!this.xformBuffer) {
      this.xformBuffer = device.createBuffer({
        label: "blit-xform",
        size: 96,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    const matchesView = (frame: WebGpuRenderer["lastFrame"]) => !this.currentView || this.samePresentation(frame,this.currentView);
    const coverage = source === this.history && this.coverageFrame && matchesView(this.coverageFrame) && this.currentView
      ? reprojectionFor(this.coverageFrame, this.currentView, true) : null;
    const transforms = new Float32Array(24); transforms.set(xform);
    transforms[10] = source !== this.history || this.historyValid && matchesView(this.lastFrame) ? 1 : 0;
    if (xform[0] === 0 || xform[1] === 0) transforms[10] = 0;
    if (source === this.target && !this.historyValid) transforms[10] = 0;
    if (coverage && this.coverageHistory) {
      transforms.set([coverage.scaleX, coverage.scaleY, coverage.offsetX, coverage.offsetY], 4);
      transforms[8] = 1;
      const front = this.lastFrame!, view = this.currentView!;
      const exactStationary = !front.proxy && front.width === view.width && front.height === view.height &&
        front.centerX.eq(view.centerX) && front.centerY.eq(view.centerY) && front.unitsPerPixel.eq(view.unitsPerPixel);
      transforms[9] = !front.proxy && !exactStationary && this.coverageFrame!.unitsPerPixel.lt(front.unitsPerPixel) ? 1 : 0;
    }
    const fresh = this.incomingFrame, view = this.currentView;
    if (fresh && view && this.target && this.samePresentation(fresh,view)) {
      const m = reprojectionFor(fresh, view);
      if (m) {
        transforms.set([m.scaleX, m.scaleY, m.offsetX, m.offsetY], 12);
        transforms[16] = 1;
        const exact = fresh.width === view.width && fresh.height === view.height &&
          fresh.centerX.eq(view.centerX) && fresh.centerY.eq(view.centerY) && fresh.unitsPerPixel.eq(view.unitsPerPixel);
        transforms[17] = exact ? 1 : 0;
        transforms[18] = exact ? 1 : 0;
      }
    }
    const pixelUnit=this.currentView?.unitsPerPixel;
    transforms[20]=pixelUnit ? (source===this.history ? this.lastFrame?.unitsPerPixel : this.incomingFrame?.unitsPerPixel)?.div(pixelUnit).toNumber()??1 : 1;
    transforms[21]=pixelUnit ? this.coverageFrame?.unitsPerPixel.div(pixelUnit).toNumber()??1 : 1;
    transforms[22]=pixelUnit ? this.incomingFrame?.unitsPerPixel.div(pixelUnit).toNumber()??1 : 1;
    if(this.lastFrame?.proxy) transforms[9]=-1;
    device.queue.writeBuffer(this.xformBuffer, 0, transforms);

    const pipeline=destination ? destination.format === "rgba16float" ? this.retainFloatPipeline! : this.retainPipeline! : this.blitPipeline!;
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
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
          view: (destination ?? this.context.getCurrentTexture()).createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(pipeline);
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
   * than resolving new detail. The pending numerical queue supplies that detail
   * continuously, during motion and after the camera settles.
   */
  /**
   * Asks the render in flight to stop after its current band. Cheap and
   * advisory: a frame that has already finished simply ignores it.
   */
  abort() {
    this.abortRequested = true;
    this.cancelPendingReference("Reference generation aborted");
  }

  reproject(request: RenderRequest): boolean {
    this.currentView = request;
    if (this.pendingReferenceDemand?.followView && !this.referenceDemandCompatible(this.pendingReferenceDemand, request)) {
      this.cancelPendingReference("Reference demand changed");
    }
    const aa=!!(this.historyValid&&request.colors.postAntialias&&this.antialiasFrame&&this.antialiasTexture&&this.sameView(this.antialiasFrame,request)&&JSON.stringify(this.antialiasFrame.colors)===JSON.stringify(request.colors));
    const last = aa ? this.antialiasFrame : this.historyValid ? this.lastFrame : this.incomingFrame;
    const source = aa ? this.antialiasTexture : this.historyValid ? this.history : this.target;
    if (!last || !source || !this.blitPipeline) {
      return false;
    }
    const compatible = (frame: WebGpuRenderer["lastFrame"]) => this.samePresentation(frame,request);
    const incomingAvailable = compatible(this.incomingFrame) && reprojectionFor(this.incomingFrame!, request);
    if (!compatible(last) && !incomingAvailable) return false;

    let mapping = compatible(last) ? reprojectionFor(last, request) : null;
    if (!mapping) {
      if (!incomingAvailable && (!compatible(this.coverageFrame) || !reprojectionFor(this.coverageFrame!, request, true))) return false;
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

  invalidateHistory() {
    this.publicationEpoch++; this.historyValid=false; this.refValid=false; this.refSamples=null;
    this.incomingFrame=null; this.fieldComplete=false; this.lastPartialAt=0; this.pending.reset(0,0);
    this.retainEndpoints=false;
    this.coverageFrame=null; this.coverageHistory?.destroy(); this.coverageHistory=null;
    this.retainedAnchor=null; this.fieldView=null; this.sampleKey=""; this.fieldKey=""; this.cachedRequest="";this.antialiasFrame=null;
    this.exactCompletedSamples=0;this.exactTotalSamples=0;this.referencePreparing=false;this.finalizing=false;
    this.abort();
  }
  private sameView(a: FrameView, b: FrameView) {
    return a.width === b.width && a.height === b.height && a.centerX.eq(b.centerX) &&
      a.centerY.eq(b.centerY) && a.unitsPerPixel.eq(b.unitsPerPixel);
  }

  isComplete(request: RenderRequest) {
    const frame=this.lastFrame;
    return this.fieldComplete && !this.finalizing && this.historyValid && !!frame && !frame.proxy &&
      this.sameView(frame,request) && frame.family===request.family && frame.maxIterations===request.maxIterations &&
      (request.family!=="julia" || !!frame.juliaX?.eq(request.juliaX!) && !!frame.juliaY?.eq(request.juliaY!)) &&
      JSON.stringify(frame.colors)===JSON.stringify(request.colors) && (!request.colors.postAntialias||!!this.antialiasFrame);
  }
  private samePresentation(frame: WebGpuRenderer["lastFrame"], request: RenderRequest | NonNullable<WebGpuRenderer["lastFrame"]>): frame is NonNullable<WebGpuRenderer["lastFrame"]> {
    return !!frame && frame.family === request.family && frame.maxIterations === request.maxIterations &&
      (request.family !== "julia" || !!frame.juliaX?.eq(request.juliaX!) && !!frame.juliaY?.eq(request.juliaY!)) &&
      JSON.stringify(frame.colors) === JSON.stringify(request.colors);
  }

  /** Captures only the completed, current 8-bit presentation image. */
  async capturePixels(request:RenderRequest):Promise<{width:number;height:number;pixels:Uint8ClampedArray}> {
    if(!this.isComplete(request))throw new Error('The current image is not ready to save yet.');
    const texture=request.colors.postAntialias?this.antialiasTexture:this.history;
    if(!texture)throw new Error('The completed image is unavailable.');
    const {device}=this.ctx,{width,height}=request;
    const bytesPerRow=Math.ceil(width*4/256)*256;
    const staging=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    let mapped=false;
    try{
      const encoder=device.createCommandEncoder({label:'png-readback'});
      encoder.copyTextureToBuffer({texture},{buffer:staging,bytesPerRow,rowsPerImage:height},{width,height});
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);mapped=true;
      const packed=new Uint8Array(staging.getMappedRange());
      const pixels=new Uint8ClampedArray(width*height*4);
      for(let y=0;y<height;y++)pixels.set(packed.subarray(y*bytesPerRow,y*bytesPerRow+width*4),y*width*4);
      for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
      return {width,height,pixels};
    }finally{
      if(mapped)staging.unmap();staging.destroy();
    }
  }

  /** Conservative rectangle with useful sample density for priority, not mere
   * display coverage. Magnified old pixels must not suppress refinement demand. */
  private coverageIn(frame: NonNullable<WebGpuRenderer["lastFrame"]>, view: FrameView) {
    const m=reprojectionFor(frame,view,!frame.proxy);
    if (!m) return [];
    const regions=frame.proxy ? frame.coveredRegions??(frame.covered?[{...frame.covered,spacing:frame.coveredSpacing??frame.unitsPerPixel}]:[]) :
      [{x:0,y:0,width:frame.width,height:frame.height,spacing:frame.unitsPerPixel}];
    return regions.map(known=>{
    const spacing=Decimal.max(known.spacing,frame.unitsPerPixel);
    const x=Math.max(0,(known.x/frame.width-m.offsetX)/m.scaleX*view.width);
    const y=Math.max(0,(known.y/frame.height-m.offsetY)/m.scaleY*view.height);
    const right=Math.min(view.width,((known.x+known.width)/frame.width-m.offsetX)/m.scaleX*view.width);
    const bottom=Math.min(view.height,((known.y+known.height)/frame.height-m.offsetY)/m.scaleY*view.height);
    return {x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y),spacing};
    }).filter(r=>r.width>0&&r.height>0);
  }

  private retainPartial() {
    const frame = this.incomingFrame;
    if (!frame || !this.target || !this.partialRegions) return;
    if (this.currentView && !this.samePresentation(frame,this.currentView)) {
      this.incomingFrame=null;this.partialRegions=0;this.determined=new CoverageRegions();
      this.determinedRegion=null;this.determinedSpacing=undefined;
      return;
    }
    const { device } = this.ctx;
    this.retainedAnchor ??= createSampleGridAnchor(this.lastFrame ?? frame);
    const retained={...frame,...planRetainedView(frame,this.retainedAnchor,{overscan:1})};
    const snapshot = device.createTexture({ label: "retained-progress", size: [retained.width,retained.height],
      format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    const candidates=[...this.coverageIn({...frame,proxy:true,coveredRegions:this.determined.rectangles.map(r=>({...r,spacing:frame.unitsPerPixel.times(r.spacing??1)}))},retained),...[this.historyValid?this.lastFrame:null,this.coverageFrame].flatMap(
      old=>this.samePresentation(old,frame) ? this.coverageIn(old!,retained) : [])].filter(r=>r!==null);
    const covered=candidates.sort((a,b)=>b.width*b.height-a.width*a.height)[0];
    const retainedCoverage=new CoverageRegions();
    for(const c of candidates)retainedCoverage.add({...c,spacing:c.spacing.div(retained.unitsPerPixel).toNumber()});
    const live = this.currentView;
    this.currentView = { ...retained };
    const source = this.historyValid ? this.history! : this.target;
    const mapping = this.historyValid && this.lastFrame ? reprojectionFor(this.lastFrame,retained,!this.lastFrame.proxy) : null;
    const encoder = device.createCommandEncoder({label:"retain-progress"});
    this.encodeBlit(encoder,source,mapping ? new Float32Array([mapping.scaleX,mapping.scaleY,mapping.offsetX,mapping.offsetY]) : new Float32Array([0,0,-1,-1]),snapshot);
    device.queue.submit([encoder.finish()]);
    this.currentView = live;
    if (this.historyValid && this.lastFrame && !this.lastFrame.proxy) {
      this.coverageHistory?.destroy(); this.coverageHistory=this.history; this.coverageFrame=this.lastFrame;
    } else this.history?.destroy();
    this.history=snapshot; this.historySize={width:retained.width,height:retained.height};
    this.lastFrame={...retained,proxy:true,covered,coveredSpacing:covered?.spacing,
      coveredRegions:retainedCoverage.rectangles.map(r=>({...r,spacing:retained.unitsPerPixel.times(r.spacing??1)}))}; this.historyValid=true; this.incomingFrame=null;
  }

  private regionDemand(request: RenderRequest): Demand {
    const live = request.followView ? this.currentView ?? request : request;
    const m = reprojectionFor(request,live);
    const focus = live.focus ?? {x:.5,y:.5};
    const covered = [this.historyValid ? this.lastFrame : null,this.coverageFrame].flatMap(frame => {
      if (!this.samePresentation(frame,request)) return [];
      return this.coverageIn(frame,request).map(r=>({...r,spacing:r.spacing.div(request.unitsPerPixel).toNumber()}));
    });
    covered.push(...this.determined.rectangles.map(r=>({...r,spacing:r.spacing??1})));
    const hints=new CoverageRegions();for(const c of covered)hints.add(c);
    return {x:((m?.offsetX??0)+focus.x*(m?.scaleX??1))*request.width,
      y:((m?.offsetY??0)+focus.y*(m?.scaleY??1))*request.height,zoom:live.zoom??0,covered:hints.rectangles};
  }

  async render(request: RenderRequest): Promise<RenderStats> {
    let result: RenderStats;
    do {
      this.retarget=false;
      result=await this.renderTarget(request);
      // Counter readback also yields. Demand arriving during that last fence
      // must be serviced before reporting the stream complete.
      if (request.followView && result.completed && this.currentView && !this.isComplete(this.currentView)) this.retarget=true;
      if (!this.retarget || this.abortRequested || request.isCurrent && !request.isCurrent()) return result;
      this.retainPartial();
      request={...this.currentView!,followView:true,isCurrent:request.isCurrent};
    } while (true);
  }

  private async renderTarget(request: RenderRequest): Promise<RenderStats> {

    const { device } = this.ctx;
    this.referencePreparing=true;this.finalizing=false;
    const epoch = this.publicationEpoch;
    this.abortRequested=false;
    if(!Number.isInteger(request.maxIterations)||request.maxIterations<1||request.maxIterations>1_000_000)throw Error('Unsupported iteration limit (maximum 1000000).');
    const originalCurrent = request.isCurrent;
    request = { ...request, colors: { ...request.colors, stops: [...request.colors.stops] },
      isCurrent: () => epoch === this.publicationEpoch && (!originalCurrent || originalCurrent()) };

    const requestKey = [request.centerX, request.centerY, request.unitsPerPixel, request.width, request.height,
      request.family, request.juliaX, request.juliaY, request.maxIterations, request.forceMethod, request.useApprox,
      JSON.stringify(request.colors)].join("|");
    if (requestKey === this.cachedRequest && this.cachedStats && this.historyValid && request.isCurrent!()) {
      this.referencePreparing=false;this.exactTotalSamples=request.width*request.height;this.exactCompletedSamples=this.exactTotalSamples;
      return { ...this.cachedStats, computed: false, computedSamples: 0,
        reusedSamples: request.width * request.height, orbitMs: 0, pipelineWaitMs: 0, tableMs: 0, renderMs: 0,
        skippedIterations:0,plainIterations:0,approxSteps:0,rebases:0,skipRatio:0 };
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

    // Geometric drift, precision, family and iteration requirements apply
    // equally during motion and rest. Input release is not a rebuild trigger.

    let orbitMs = 0;
    this.pipelineWaitMs = 0;
    this.tableMs = 0;
    if (method !== Method.Direct && stale) {
      try {
        const orbit = await this.generateOrbit(request, limbs);
        if (!request.isCurrent!()) throw new DOMException("Superseded reference", "AbortError");
        // Publish payload identity only after the transferred buffer is
        // accepted and queued for upload. No stale centre can describe old data.
        this.refFamily=family; this.refConstant=constant;
        this.refX = request.centerX; this.refY = request.centerY;
        this.refLimbs = limbs; this.refIterations = request.maxIterations;
        this.refLength = orbit.length; this.refEscaped = orbit.escaped;
        this.refSamples = orbit.samples; this.refValid = true;
        drift = new Decimal(0); orbitMs = orbit.ms;
        this.tableMs = 0; this.laLevels=0; this.tableMaxDelta=-1;
        if (method === Method.Hdr && family === "mandelbrot" && request.useApprox!==false && request.colors.mode===0) await this.buildApproxTable(request);
      } catch (error) {
        this.referencePreparing=false;
        throw error;
      }
    }
    // Reversal/overscan can need a larger delta domain without needing a new
    // orbit. Rebuild the inexpensive table for that domain instead of silently
    // turning acceleration off for the whole expanded field.
    const requiredDelta = request.unitsPerPixel.times(Math.hypot(request.width, request.height) / 2).plus(drift).toNumber();
    if (method === Method.Hdr && family === "mandelbrot" && request.useApprox !== false && request.colors.mode === 0 &&
        requiredDelta > this.tableMaxDelta * (1 + 1e-12)) {
      await this.buildApproxTable(request);
    }

    this.referencePreparing=false;
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
      stopData[i * 4 + 3] = stopPositions(colors)[i];
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

    let previewStride=1;
    if(request.followView && !request.tileRows && colors.mode!==2 && grid===1) {
      while(Math.ceil(request.width/previewStride)*Math.ceil(request.height/previewStride)>MIN_BATCH_SAMPLES) previewStride*=2;
    }

    // Layout must match the Uniforms struct in perturbation.wgsl. vec3 members
    // align to 16 bytes, which is what the gaps below are for.
    const uniforms = new ArrayBuffer(368);
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
    const wantsEndpoints=needsEndpoints(colors)||colors.mode===1;
    if(this.retainEndpoints&&!wantsEndpoints&&this.fieldView&&!this.sameView(this.fieldView,request)){
      this.retainEndpoints=false;this.endpointBuffer?.destroy();this.endpointBuffer=null;this.endpointCapacity=0;
    }
    this.retainEndpoints ||= wantsEndpoints;
    const endpointCount=this.retainEndpoints?request.width*request.height*grid*grid:1;
    if(endpointCount*16>Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize))throw Error('Final-orbit channels exceed this GPU’s buffer capacity. Reduce the viewport or disable the orbit-dependent mode.');
    if(!this.endpointBuffer||this.endpointCapacity<endpointCount){this.endpointBuffer?.destroy();this.endpointBuffer=storageBuffer(device,endpointCount*4,'final-orbits');this.endpointCapacity=endpointCount;}
    u32[84]=colors.formula??0;u32[85]=colors.effect??0;u32[86]=colors.capped??0;u32[87]=colors.repeating===false?0:1;u32[88]=this.retainEndpoints?1:0;
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
    u32[26] = request.height; u32[54]=1; u32[55]=previewStride;
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
    device.queue.writeBuffer(this.statsBuffer, 0, new Uint32Array(12));

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
      this.retainEndpoints,
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
        grid === 1 && colors.mode === 0 && !this.retainEndpoints, grid);
      u32[41] = grid === 1 && colors.mode !== 2 ? 1 : 0;
      device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    }
    this.exactTotalSamples=request.width*request.height;
    this.exactCompletedSamples=fieldStale?0:this.exactTotalSamples;

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
        { binding: 8, resource: { buffer: this.endpointBuffer! } },
      ],
    });

    const frame = {
      family: request.family, juliaX: request.juliaX, juliaY: request.juliaY,
      centerX: request.centerX, centerY: request.centerY,
      unitsPerPixel: request.unitsPerPixel, width: request.width, height: request.height,
      colors: request.colors, maxIterations: request.maxIterations,
    };
    const progressive = colors.mode !== 2 && grid === 1 && request.publishPartial!==false;
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
    const batchCostKey=[family,method,request.maxIterations,limbs,colors.mode,grid].join("|");
    if (this.batchCostKey!==batchCostKey) { this.batchCostKey=batchCostKey; this.batchMsPerSample=0; }
    if (!fieldStale) this.pending.reset(0,0);
    if (fieldStale) { this.pending.reset(request.width,request.height,previewStride,request.followView); this.determined=new CoverageRegions(); this.determinedRegion=null; this.determinedSpacing=undefined; this.streamTargets++; }
    const targetStarted=performance.now();
    while (this.pending.size) {
      const minimum=Math.max(64,Math.floor(MIN_BATCH_SAMPLES*Math.min(1,10000/request.maxIterations)/64)*64);
      const budget = this.batchMsPerSample > 0 ?
        Math.max(minimum,SUBMIT_BUDGET_MS/this.batchMsPerSample) : minimum;
      const region = this.pending.take(budget,this.regionDemand(request),request.tileRows);
      if(!region) break;
      const width=region.width, rows=region.height;
      this.latestRegion=region;
      const m = this.reuseMapping, old = this.reusableView;
      const fullyKnown = this.reusableComplete && m && old && m.denominator === 1 &&
        m.offsetX + region.x * m.step >= 0 && m.offsetY + region.y * m.step >= 0 &&
        m.offsetX + (region.x + width - 1) * m.step < old.width &&
        m.offsetY + (region.y + rows - 1) * m.step < old.height;
      if (fullyKnown) { if(region.stride===1){cpuReused += width * rows;this.exactCompletedSamples=Math.min(this.exactTotalSamples,this.exactCompletedSamples+width*rows);} continue; }
      u32[54]=region.stride; u32[26]=region.y+rows;
      u32[40] = region.y; u32[42] = region.x; u32[43] = region.x + width;
      device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
      const batchStarted = performance.now();
      const encoder = device.createCommandEncoder({ label: "calculate-region" });
      const sample = this.timing.begin("calculate");
      const pass = encoder.beginComputePass({ label: "calculate-region", timestampWrites: this.timing.writes(sample) });
      pass.setPipeline(family === "julia" ? this.juliaPipeline! : method === Method.Direct ? this.directPipeline! :
        approximationLevels > 0 ? this.approxPipeline! : this.renderPipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(width / region.stride / 8), Math.ceil(rows / region.stride / 8)); pass.end();
      this.timing.resolve(encoder, sample); timingSamples.push(sample);
      if (progressive) shade(encoder, width, rows);
      device.queue.submit([encoder.finish()]);this.calculationSubmissions++;
      collectTimings();
      if (progressive && request.isCurrent!()) {
        this.incomingFrame = frame; this.partialSerial++; this.partialRegions++;
        this.determined.add({x:region.x,y:region.y,width,height:rows,spacing:region.stride});
        if (!this.determinedRegion || width*rows >= this.determinedRegion.width*this.determinedRegion.height) {
          this.determinedRegion={x:region.x,y:region.y,width,height:rows};
          this.determinedSpacing=frame.unitsPerPixel.times(region.stride);
        }
        this.lastPartialAt=performance.now(); this.firstPartialAt ||= this.lastPartialAt;
        // A render can also be used outside the application's animation loop.
        // Queue order presents only finished regions, never in-flight writes.
        this.reproject(this.currentView ?? request);
      }
      await device.queue.onSubmittedWorkDone();
      if(region.stride===1)this.exactCompletedSamples=Math.min(this.exactTotalSamples,this.exactCompletedSamples+width*rows);
      const elapsed = performance.now() - batchStarted;
      const cost = elapsed / (Math.ceil(width/region.stride) * Math.ceil(rows/region.stride));
      this.batchMsPerSample = this.batchMsPerSample ? .75 * this.batchMsPerSample + .25 * cost : cost;
      await yieldToEvents();
      await request.betweenBatches?.();
      if (!request.isCurrent!() || this.abortRequested) {
        completed = false; this.aborted = true; break;
      }
      // A geometry change updates demand regardless of input state. Give each
      // target useful bounded work, then follow the live camera. Releasing a
      // button changes neither this condition nor the outstanding queue.
      const live=this.currentView;
      if (request.followView && live && (!this.sameView(request,live) || JSON.stringify(request.colors)!==JSON.stringify(live.colors)) &&
          (performance.now()-targetStarted >= 64 || !this.pending.size)) {
        this.retarget=true; completed=false; break;
      }
    }
    if (!request.isCurrent!()) completed = false;
    this.fieldKey = completed ? fieldKey : "";
    if (request.isCurrent!()) this.fieldComplete = completed;
    if(completed){this.exactCompletedSamples=this.exactTotalSamples;this.finalizing=true;}

    // Only completed fields enter retained history. Streaming already shaded
    // its individual regions; recolours and neighbour-dependent distance
    // lighting shade once here. Unknown partial samples stay out of history.
    if (completed) {
      const encoder = device.createCommandEncoder({ label: "shade" });
      u32[26]=request.height; u32[54]=1;
      u32[40] = 0; u32[42] = 0; u32[43] = request.width;
      device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
      if (!fieldStale || !progressive || colors.mode===1 || (colors.effect??0)>=7&&(colors.effect??0)<=9) shade(encoder, request.width, request.height);
      // Presentation belongs to the current camera, not this possibly older request.
      this.ensureHistory(request);
      encoder.copyTextureToTexture(
        { texture: this.target! },
        { texture: this.history! },
        { width: request.width, height: request.height }
      );
      if(colors.postAntialias)this.encodeAntialias(encoder,this.history!,request.width,request.height,timingSamples);
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
      this.antialiasFrame=colors.postAntialias?this.lastFrame:null;
    }

    // Mapping the counters also fences the final copy; no redundant queue-wide
    // completion round trip before the readback.
    const counters = new Uint32Array(await readBuffer(device, this.statsBuffer, 48));
    this.finalizing=false;
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
    const work = (i:number) => counters[i] + counters[i+8] * 4294967296;
    const skippedIterations = work(0);
    const plainIterations = work(3);
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
      approxSteps: work(1),
      rebases: work(2),
      plainIterations,
      skipRatio: total > 0 ? skippedIterations / total : 0,
      cappedRatio: counters[5] > 0 ? counters[4] / counters[5] : 0,
    };
    if (completed && request.isCurrent!()) {
      this.cachedStats = result; this.cachedRequest = requestKey;

    }
    return result;
  }
}
