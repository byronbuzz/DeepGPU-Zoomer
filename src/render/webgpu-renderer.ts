import { ReferenceOrbitCache } from './reference-cache';
import { BlaTableCache } from './bla-cache';
import {motionBatchBudget} from './motion-sizing';
import {deliveryWorkgroup} from './delivery-workgroup';
// Ordinary variants use these workgroup dimensions.
const ORDINARY_WORKGROUP_X = 16;
const ORDINARY_WORKGROUP_Y = 4;
import {MIN_BATCH_SAMPLES,ordinaryStripeRows,learnOrdinaryStripeCost} from './ordinary-stripes';
/**
 * WebGPU rendering path: arbitrary-precision reference orbit in a dedicated
 * CPU worker, then a perturbation compute pass whose per-pixel deltas carry
 * their own exponent.
 *
 * Scaled arithmetic avoids an f32 underflow floor, so zoom depth is
 * bounded by the precision profile (limb count) rather than by the renderer.
 */

import Decimal from "decimal.js";
import { assertCoordinatePreparation, coordinateToFixed } from "../coordinate";
import { checkedGpu, validateRenderSize, compileShader, readBuffer, storageBuffer, type GpuContext } from "../gpu/device";
import { GpuTiming } from "../gpu/timing";
import compensatedSource from "../arithmetic/compensated.wgsl?raw";
import quadSource from "../arithmetic/quad.wgsl?raw";
import quadFastSource from "../arithmetic/quad-fast.wgsl?raw";
import perturbationSource from "./perturbation.wgsl?raw";
import wideSource from "./wide.wgsl?raw";
import continuationSource from "./continuation.wgsl?raw";
import { MANDATORY_CONTINUATION_ITERATIONS, continuationRegion, continuationOperations, resumedContinuationOperations, continuationLaneLimit, coldCohortOperations, measuredContinuationBudget, COLD_CONTINUATION_OPERATIONS, CONTINUATION_HEADER_BYTES, CONTINUATION_STATE_BYTES } from "./continuation";
import { PendingContinuationSlot, translatedContinuationRegion, type ContinuationIdentity, type PendingContinuation } from './pending-continuation';
import { SurvivorCohort, SURVIVOR_CAPACITY } from './survivor-cohort';
import reuseSource from "./reuse.wgsl?raw";
import capValidationSource from "./cap-validation.wgsl?raw";
import { capRegionResolved, type CapCertificate } from './cap-certificate';
import qualityResolveSource from "./quality-resolve.wgsl?raw";
import { oversampledView } from "./quality";
import { boundedRetainedView, createSampleGridAnchor, planRetainedView, sourceAlignedRetainedView, sampleGridRemap, knownRemappedRegion, type SampleGridAnchor, type SampleGridRemap } from "./sample-grid";
import { planNumericalView, containsNumericalView, learnOutwardDelay, outwardHorizonMs, outwardPadding } from './numerical-grid';
import { PendingRegions, CoverageRegions, type Demand } from "./regions";
import type { FrameView } from "./reprojection";
import { splitQuad } from "../arithmetic/quad";
import { mapUv, reprojectionFor, type Reprojection } from "./reprojection";
import { rotationBasis } from "../rotation";
import { ReferenceWorkerClient } from "./reference-worker-client";
import { MAX_REFERENCE_ITERATIONS, REFERENCE_CHUNK_ITERATIONS, REFERENCE_FORMAT_VERSION, referenceIdentity,
  type ReferenceOrbitInput, type ReferenceResumeState, type ReferenceSampleWords } from "./reference-orbit";
import { prepareReference, referenceDecodeDispatch, REFERENCE_TRANSFER_FLOATS } from './reference-preparation';

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
import { hexToRgb, MAX_STOPS, stopPositions, needsEndpoints, type ColorSettings } from "../logic/colorSettings";
import { BASE_STEP, ENTRY_FLOATS, buildBlaAsync } from "./bla";
import { DEFAULT_TUNING, mandelbrotBlaEpsilon, startingBatchVisits, navigationBatchMinimum, perturbationAllowanceMs, type TuningSettings } from "../tuning";
import { automaticCapRemap, type AdmittedSamples } from './cap-reuse';
import { BatchFeedback } from './batch-feedback';

/** Precision profiles, chosen from the zoom depth. */
const LIMB_PROFILES = [8, 16, 32, 64, 128, 256] as const;
class LiveDemandChanged extends Error {}

/** A local export tile (including its clipped halo) within the full image. */
export interface ExportDomain { width: number; height: number; x: number; y: number }
type DomainView = FrameView & { exportDomain?: ExportDomain; stationaryOversampling?: boolean };

export function renderDomain(view: Pick<RenderRequest, "width" | "height" | "exportDomain">): ExportDomain {
  return view.exportDomain ?? { width: view.width, height: view.height, x: 0, y: 0 };
}

function exportIdentity(view: { exportDomain?: ExportDomain }): string {
  const d = view.exportDomain;
  return d ? `export:${d.width},${d.height},${d.x},${d.y}` : "";
}

export function validateExportDomain(request: Pick<RenderRequest, "width" | "height" | "exportDomain" | "followView">): void {
  const d = request.exportDomain;
  if (!d) return;
  // Half-pixel centres must remain representable in the f32 coordinate path.
  if (![d.width,d.height,d.x,d.y,request.width,request.height].every(Number.isSafeInteger) ||
      d.width < 1 || d.height < 1 || d.width >= 2 ** 23 || d.height >= 2 ** 23 ||
      d.x < 0 || d.y < 0 || request.width < 1 || request.height < 1 ||
      d.x + request.width > d.width || d.y + request.height > d.height || request.followView) {
    throw new Error('Invalid export tile or full-image dimensions.');
  }
}

// The pending device-loss promise retains only this detachable slot. In
// particular its callback must not close over a disposed renderer instance.
function observeDeviceLoss(lost: GpuContext["lost"], hook: { notify: (() => void) | null }) {
  void lost.then(() => hook.notify?.());
}

export interface RenderRequest {
  centerX: Decimal;
  centerY: Decimal;
  angle?: number;
  family?: "mandelbrot" | "julia";
  juliaX?: Decimal;
  juliaY?: Decimal;
  isCurrent?: () => boolean;
  /** Allows a numerically compatible request to finish after its presentation
   * has been superseded. Publication remains owned by `isCurrent`. */
  isCalculationCurrent?: () => boolean;
  /** Complex units per device pixel. */
  unitsPerPixel: Decimal;
  width: number;
  height: number;
  /** Full-output geometry; width/height above remain local storage dimensions. */
  exportDomain?: ExportDomain;
  /** Live quality target, enabled by the caller only while stationary. */
  stationaryOversampling?: boolean;
  maxIterations: number;
  colors: ColorSettings;
  /** Enables standard linear BLA wherever the selected method supports it. */
  useApprox?: boolean;
  /** Input status; geometry governs calculation. */
  interacting?: boolean;
  /** Continuous held inward input; wheel impulses do not predict future input. */
  heldInwardZoom?: boolean;
  /** Follow live demand until its exact field is complete. Preview/one-shot
   * callers use the same region queue without following another camera. */
  followView?: boolean;
  /** Local navigation settings; omitted requests use the defaults. */
  tuning?: Readonly<TuningSettings>;
  betweenBatches?: () => Promise<void>;
  /** Preview callers publish only complete images and matching metadata. */
  publishPartial?: boolean;
  /** The app animation loop presents published regions; other callers present immediately. */
  presentationOwner?: 'animation';
  focus?: { x: number; y: number };
  zoom?: number;
  /** Logarithmic span growth per second for outward coverage prediction. */
  zoomRate?: number;
  /** Requested symmetric numerical padding in backing pixels; presentation stays visible-sized. */
  overscanPixels?: {x:number;y:number};
  /** Reserve a geometric reference tier while Dynamic can raise the pixel limit. */
  dynamicIterations?: boolean;
  /** Presentation only: keep prior-cap imagery during an automatic navigation upgrade. */
  provisionalNavigationCap?: boolean;
  /** Synchronous live Dynamic update, called only at an independently required
   * reference/BLA preparation boundary. Its result is never queued. */
  beforePreparation?: () => number | null;
  /** Internal numerical view, already expanded from the visible camera. */
  workView?: boolean;
}

export interface RenderStats {
  completed: boolean;
  computed: boolean;
  /** Existing ordinary field refined from a lower Dynamic iteration cap. */
  capUpgrade?: boolean;
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
   * Fraction of samples classified as capped/non-escaped, 0..1. This includes
   * analytically determined interiors that execute no recurrence iterations,
   * so it is only meaningful compared against the same view and policy.
   */
  cappedRatio: number;
  /** Newly computed samples that exhausted the limit without escaping. */
  limitHitRatio: number;
  /** Finite-machine periodic exits; provisional numerical results, not proven interiors. */
  numericalPeriodicRatio: number;
}

/** Direct versus perturbation route; nonzero labels share the Wide shader. */
export const enum Method {
  /** Direct compensated iteration. No reference orbit. */
  Direct = 0,
  /** Perturbation with an optional BLA table. */
  Hdr = 2,
}

export function methodForScale(unitsPerPixel: Decimal, tuning: Pick<TuningSettings,'directExponent'> = DEFAULT_TUNING): Method {
  const upp = unitsPerPixel.toNumber();
  if (upp > 10 ** -tuning.directExponent) return Method.Direct;
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

/** Exact far-corner distance from the retained reference to this viewport. */
export function referenceViewportRadius(
  request: Pick<RenderRequest, "centerX" | "centerY" | "unitsPerPixel" | "width" | "height" | "angle" | "exportDomain">,
  refX: Decimal,
  refY: Decimal,
): Decimal {
  const domain = renderDomain(request);
  if(request.angle){
    const {c,s}=rotationBasis(request.angle),halfX=request.unitsPerPixel.times(domain.width/2),halfY=request.unitsPerPixel.times(domain.height/2);
    const dx=request.centerX.minus(refX),dy=request.centerY.minus(refY);
    return Decimal.max(...[-1,1].flatMap(x=>[-1,1].map(y=>Decimal.hypot(
      dx.plus(halfX.times(x*c)).minus(halfY.times(y*s)),
      dy.plus(halfX.times(x*s)).plus(halfY.times(y*c))))));
  }
  const x = request.unitsPerPixel.times(domain.width / 2).plus(request.centerX.minus(refX).abs());
  const y = request.unitsPerPixel.times(domain.height / 2).plus(request.centerY.minus(refY).abs());
  return Decimal.hypot(x, y);
}

export function approximationDeltaBound(family: "mandelbrot" | "julia", request: Pick<RenderRequest, "centerX" | "centerY" | "unitsPerPixel" | "width" | "height" | "angle" | "exportDomain">, refX: Decimal, refY: Decimal): Decimal {
  return family === "julia" ? new Decimal(0) : referenceViewportRadius(request, refX, refY);
}
export function approximationEligible(family: "mandelbrot" | "julia", mode: number): boolean {
  return family === "julia" ? mode === 0 : mode !== 2;
}

/** The editable tolerance belongs only to the Mandelbrot linear table. */
type BlaPrecisionPolicy = Pick<RenderRequest,'tuning'>;
export function effectiveBlaEpsilon(request:BlaPrecisionPolicy):number {
  return mandelbrotBlaEpsilon(request.tuning);
}
export function blaTableEpsilon(request: Pick<RenderRequest,'family'> & BlaPrecisionPolicy, ): number {
  return request.family==='julia' ? -40 : effectiveBlaEpsilon(request);
}

export function linearBlaPolicy(request: Pick<RenderRequest,'family'|'useApprox'|'colors'> & BlaPrecisionPolicy,
    method:Method,):number|undefined {
  return(request.family??'mandelbrot')==='mandelbrot'&&request.useApprox===true&&
    method!==Method.Direct&&approximationEligible('mandelbrot',request.colors.mode)
    ? effectiveBlaEpsilon(request) : undefined;
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
  /** Captured camera demand stays separate from the retained orbit parameter. */
  centerX: Decimal;
  centerY: Decimal;
  referenceX: Decimal;
  referenceY: Decimal;
  /** Original numerical snapshot; motion does not change its admitted orbit. */
  view: RenderRequest;
  followView: boolean;
}

interface ReferencePrefetch {
  demand:ReferenceDemand;
  epsilonLog2:number;
  owner:RenderRequest;
  claimed:ReferenceDemand|null;
  cancelled:boolean;
  promise:Promise<void>;
}

interface FieldDescriptor {
  family: "mandelbrot" | "julia";
  constant: string;
  maxIterations: number;
  mode: number;
  grid: number;
  method: Method;
  useApprox: boolean;
  retainEndpoints: boolean;
  interiorEndpoints: boolean;
  linearBlaEpsilon?: number;
}

export interface AppearanceFrameIdentity extends DomainView {
  followView?: boolean;
  interacting?: boolean;
  zoom?: number;
  proxy?: boolean;
  family?: "mandelbrot" | "julia";
  juliaX?: Decimal;
  juliaY?: Decimal;
  maxIterations: number;
  useApprox: boolean;
  method: Method;
  grid: number;
  colors: ColorSettings;
  tuning?: Readonly<TuningSettings>;
}

/** Exact numerical/view identity allowed to hold an older completed appearance. */
export function appearanceUpgradeCompatible(
  frame: AppearanceFrameIdentity | null,
  request: RenderRequest,
  method: Method,
  grid: number,
): frame is AppearanceFrameIdentity {
  const family=request.family??"mandelbrot",frameFamily=frame?.family??"mandelbrot";
  return !!frame&&!frame.proxy&&frame.width===request.width&&frame.height===request.height&&
    exportIdentity(frame)===exportIdentity(request)&&
    frame.centerX.eq(request.centerX)&&frame.centerY.eq(request.centerY)&&frame.unitsPerPixel.eq(request.unitsPerPixel)&&(frame.angle??0)===(request.angle??0)&&
    frameFamily===family&&frame.maxIterations===request.maxIterations&&frame.useApprox===(request.useApprox===true)&&
    frame.method===method&&frame.grid===grid&&
    linearBlaPolicy(frame,frame.method)===linearBlaPolicy(request,method)&&
    (family!=="julia"||!!frame.juliaX?.eq(request.juliaX!)&&!!frame.juliaY?.eq(request.juliaY!));
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

  private referenceDecodePipeline: GPUComputePipeline | null = null;
  private juliaPipeline: GPUComputePipeline | null = null;
  private juliaApproxPipeline: GPUComputePipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;
  private retainPipeline: GPURenderPipeline | null = null;
  private retainFloatPipeline: GPURenderPipeline | null = null;
  private ordinaryPlainPipeline: GPUComputePipeline | null = null;
  private ordinaryShapePipelines = new Map<string,GPUComputePipeline>();
  private ordinaryApproxPipeline: GPUComputePipeline | null = null;
  private renderModule: GPUShaderModule | null = null;
  private continuationModule: GPUShaderModule | null = null;
  private continuationLayout: GPUBindGroupLayout | null = null;
  private continuationPipelines = new Map<string,GPUComputePipeline>();
  private reuseModule: GPUShaderModule | null = null;
  private blitModule: GPUShaderModule | null = null;
  private screenHold: GPUTexture | null = null;
  private screenHoldValid = false;
  private screenHoldSize = {width:0,height:0};
  private lastPresentedKey = '';
  private lastPresentedFrame: WebGpuRenderer['lastFrame'] = null;
  private lastPresentedSource: GPUTexture | null = null;
  private lastPresentedCoverage: WebGpuRenderer['coverageFrame'] = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  private pendingPipelines = new Map<string, Promise<void>>();
  private spareHistory: GPUTexture | null = null;
  private deviceLost=false;
  private disposed=false;
  private disposePromise: Promise<void> | null = null;
  private activeOperations = new Set<Promise<unknown>>();
  private lossHook: { notify: (() => void) | null } = { notify: null };

  private target: GPUTexture | null = null;
  private targetSize = { width: 0, height: 0 };
  private sampler: GPUSampler;

  private uniformBuffer: GPUBuffer;
  private stopsBuffer: GPUBuffer;
  private tableMs = 0;
  private tableMaxDelta = new Decimal(0);
  private tableEpsilonLog2:number|undefined;
  /** Geometry and density of the retained history image. */
  private lastFrame: (AppearanceFrameIdentity & {
    proxy?: boolean;
    /** All proxy texels have a source; this is never numerical completion. */
    snapshotComplete?: boolean;
    covered?: {x:number;y:number;width:number;height:number};
    coveredSpacing?: Decimal;
    coveredRegions?: {x:number;y:number;width:number;height:number;spacing:Decimal}[];
  }) | null = null;
  private xformBuffer: GPUBuffer | null = null;
  private history: GPUTexture | null = null;
  private coverageHistory: GPUTexture | null = null;
  private coverageFrame: WebGpuRenderer["lastFrame"] = null;
  private currentView: RenderRequest | null = null;
  private historyValid = false;
  /** Exact current target identity is independent of bounded history pixels. */
  private completedFrame: WebGpuRenderer["lastFrame"] = null;
  private currentImageValid = false;
  private pendingRetain: Promise<boolean> | null = null;
  private publicationEpoch = 0;
  private incomingFrame: WebGpuRenderer["lastFrame"] = null;
  private appearanceHoldFrame: WebGpuRenderer["lastFrame"] = null;
  private partialAppearanceUniforms: ArrayBuffer | null = null;
  private partialSerial = 0;
  private partialRegions = 0;
  private fieldComplete = false;
  private reuseMapping: SampleGridRemap | null = null;
  private reusableView: FrameView | null = null;
  private reusableComplete = false;
  private reusableKnownRectangles: {x:number;y:number;width:number;height:number;spacing?:number}[] = [];
  private batchMsPerSample = 0;
  private gpuBatchCost = {msPerVisit:0};
  private gpuBatchPolicy = '';
  private perturbationActive = false;
  private ordinaryBatchCostKey = "";
  private readonly batchFeedback = new BatchFeedback();
  private readonly pendingContinuation = new PendingContinuationSlot();
  private clearContinuationWork(){
    this.pendingContinuation?.clear();
  }
  private continuationParked = 0;
  private continuationCarried = 0;
  private batchCostKey = "";
  private batchFeedbackCap = 0;
  private retainedAnchor: SampleGridAnchor | null = null;
  private numericalAnchor: SampleGridAnchor | null = null;
  private numericalView: FrameView | null = null;
  private outwardBatchDelayMs = 0;
  private numericalGuardMs = 0;
  private pending = new PendingRegions();
  private retarget = false;
  private determinedRegion: {x:number;y:number;width:number;height:number} | null = null;
  private determined = new CoverageRegions();
  private streamTargets = 0;
  private exactCompletedSamples=0;
  private exactTotalSamples=0;
  private referencePreparing=false;
  private finalizing=false;
  private appearanceSubmissions=0;
  private timing: GpuTiming;
  progress() {
    const progressCurrent=!!(this.currentView&&this.fieldView&&this.sameView(this.fieldView,this.workRequest(this.currentView)));
    const complete=!this.referencePreparing&&!!this.currentView&&this.isComplete(this.currentView)&&this.pending.size===0&&!this.incomingFrame&&!this.finalizing;
    const percentage=this.referencePreparing||!progressCurrent?null:complete&&this.exactTotalSamples?100:this.exactTotalSamples?Math.min(99,Math.floor(this.exactCompletedSamples/this.exactTotalSamples*100)):null;
    const displayed=this.incomingFrame??this.lastFrame;
    const appearancePending=!!(this.currentView&&displayed&&this.sameView(displayed,this.workRequest(this.currentView))&&!this.samePresentation(displayed,this.currentView));
    return {complete, percentage, exactCompletedSamples:this.exactCompletedSamples, exactTotalSamples:this.exactTotalSamples,
      referencePreparing:this.referencePreparing, finalizing:this.finalizing, appearancePending,
      referenceWorkerActive:this.referenceWorker.active, pending:this.pending.size, targets:this.streamTargets};
  }
  private abortRequested = false;
  private shadePipeline: GPUComputePipeline | null = null;
  private distanceToIterationPipeline: GPUComputePipeline | null = null;
  private bindLayout: GPUBindGroupLayout | null = null;
  private fieldBuffer: GPUBuffer | null = null;
  private fieldCapacity = 0;
  private endpointBuffer:GPUBuffer|null=null;
  private endpointCapacity=0;
  private retainEndpoints=false;
  private endpointDemand=false;
  endpointChannelsRequired(){return this.retainEndpoints||this.endpointDemand;}
  private spareField: GPUBuffer | null = null;
  private spareCapacity = 0;
  private fieldView: DomainView | null = null;
  private sampleKey = "";
  private admittedSamples: AdmittedSamples | null = null;
  private reusePipeline: GPUComputePipeline | null = null;
  private capValidationPipeline: GPUComputePipeline | null = null;
  private reuseUniform: GPUBuffer | null = null;
  private cachedStats: RenderStats | null = null;
  private cachedRequest = "";
  private fieldStats: RenderStats | null = null;
  private fieldDescriptor: FieldDescriptor | null = null;
  private fieldUniforms: ArrayBuffer | null = null;

  /**
   * Identifies what is in `fieldBuffer`. Everything that changes the numbers
   * belongs here; everything that only changes how they look must not, or
   * recolouring would recompute the frame it is trying to avoid.
   */
  private fieldKey = "";
  /** Old-cap presentation may follow camera motion while an upgrade settles. */
  private capPresentationTarget:number|null=null;
  /** True when the last render stopped early. */
  private aborted = false;
  private laBuffer: GPUBuffer | null = null;
  private laIndexBuffer: GPUBuffer | null = null;
  private laLevels = 0;
  private laHasUsableMultiStep = false;
  private statsBuffer: GPUBuffer;
  private orbitBuffer: GPUBuffer | null = null;
  private orbitCapacity = 0;
  private referenceWorker = new ReferenceWorkerClient();
  private referenceCache = new ReferenceOrbitCache(4,128*1024*1024);
  private blaCache = new BlaTableCache(2,128*1024*1024);
  private pendingReferenceDemand: ReferenceDemand | null = null;
  private referencePrefetch:ReferencePrefetch|null=null;

  /** Cached reference orbit: regenerating it per frame would kill panning. */
  private refX = new Decimal(0);
  private refY = new Decimal(0);
  private refLimbs = 0;
  private refIterations = 0;
  private refLength = 0;
  private refEscaped = false;
  private refValid = false;
  private refSamples: Float32Array<ArrayBuffer> | null = null;
  private refFormatVersion: typeof REFERENCE_FORMAT_VERSION = REFERENCE_FORMAT_VERSION;
  private refSampleWords: ReferenceSampleWords = 10;
  private refTerminal: ReferenceResumeState | null = null;
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
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    this.sampler = ctx.device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    });
    this.uniformBuffer = ctx.device.createBuffer({
      size: 432,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.stopsBuffer = storageBuffer(ctx.device, MAX_STOPS * 4, "palette-stops");
    this.statsBuffer = storageBuffer(
      ctx.device,
      14,
      "render-stats",
      GPUBufferUsage.COPY_SRC
    );
    this.lossHook.notify = () => { this.deviceLost=true;this.screenHold?.destroy();this.screenHold=null;this.screenHoldValid=false;this.abort(); };
    observeDeviceLoss(ctx.lost, this.lossHook);
  }

  init(): Promise<void> {
    return this.trackOperation(() => this.initialize());
  }

  private async initialize() {
    if(this.disposed)throw new Error('Renderer has been disposed.');
    const { device } = this.ctx;
    this.reuseModule = await compileShader(device, reuseSource, "sample-reuse");
    await this.ensureComputePipeline("reuse");
    this.reuseUniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.renderModule = await compileShader(device, [compensatedSource, quadSource, quadFastSource, perturbationSource, wideSource].join("\n"), "perturbation");

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
        storage("storage", 9),
      ],
    });
    this.bindLayout = bindLayout;
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindLayout],
    });

    await this.ensureComputePipeline("direct");
    await this.ensureComputePipeline("shade");

    this.blitModule = await compileShader(
      device,
      `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(5) var screenHold: texture_2d<f32>;
/** uv' = uv * xform.xy + xform.zw. Identity is (1, 1, 0, 0). */
struct Presentation { front: vec4<f32>, back: vec4<f32>, options: vec4<f32>, fresh: vec4<f32>, freshOptions: vec4<f32>, units: vec4<f32>, cross: vec4<f32>, freshCross: vec4<f32>, fallbackCounts: vec4<f32> };
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

${qualityResolveSource}
@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let uv = in.uv * display.front.xy + in.uv.yx * display.cross.xy + display.front.zw;
    let oldUV = in.uv * display.back.xy + in.uv.yx * display.cross.zw + display.back.zw;
    var frontValid = display.options.z > 0.0 && all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
    var backValid = display.options.x > 0.0 && all(oldUV >= vec2<f32>(0.0)) && all(oldUV <= vec2<f32>(1.0));
    // Select an actual determined sample. Never blend the two images, and do
    // not let a smaller new field erase already calculated coverage.
    var front = textureSample(src, smp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)));
    if(display.fallbackCounts.x>0.0){front=qualityResolve(src,uv,display.fallbackCounts.x);}
    var back = textureSample(coverage, smp, clamp(oldUV, vec2<f32>(0.0), vec2<f32>(1.0)));
    if(display.fallbackCounts.y>0.0){back=qualityResolve(coverage,oldUV,display.fallbackCounts.y);}
    // Numeric sources use positive alpha for reciprocal sample spacing.
    // Float history can retain valid densities below an 8-bit alpha step.
    // Held screen colours are a separate fallback, never a numeric source.
    frontValid = frontValid && front.a > 0.0;
    backValid = backValid && back.a > 0.0;
    // Raw preview densities encode dyadic steps up to 64 in rgba8unorm.
    // Recover that integer step before comparison. Float history contains
    // arbitrary world-grid ratios and must not undergo this correction.
    let frontStep=1.0 / max(front.a, 1e-30);
    let frontSpacing=display.units.x * select(frontStep,round(frontStep),display.options.w>0.0);
    let backSpacing=display.units.y / max(back.a, 1e-30);
    // A finer source grid can still contain coarser preview regions. Compare
    // the actual sample spacing before replacing valid current detail.
    let useBack = backValid && (!frontValid ||
        (display.options.y != 0.0 && backSpacing < frontSpacing));
    var spacing=select(frontSpacing,backSpacing,useBack);
    var result = select(front, back, useBack);
    let freshUV = in.uv * display.fresh.xy + in.uv.yx * display.freshCross.xy + display.fresh.zw;
    var fresh = textureSample(incoming, smp, clamp(freshUV, vec2<f32>(0.0), vec2<f32>(1.0)));
    if(display.fallbackCounts.z>0.0){fresh=qualityResolve(incoming,freshUV,display.fallbackCounts.z);}
    let valid = display.freshOptions.x > 0.0 && fresh.a > 0.0 && all(freshUV >= vec2<f32>(0.0)) && all(freshUV <= vec2<f32>(1.0));
    let freshSpacing=display.units.z * round(1.0 / max(fresh.a,1e-30));
    let prefer = (fresh.a > 0.99 && freshSpacing <= spacing && select(display.freshOptions.y, display.freshOptions.z, useBack) > 0.0) || freshSpacing < spacing;
    if (valid && (prefer || (!frontValid && !backValid))) { result = fresh; spacing=freshSpacing; }
    if (!frontValid && !backValid && !valid) {
        if (display.fallbackCounts.w > 0.0) {
            let dims = vec2<i32>(textureDimensions(screenHold));
            let held = textureLoad(screenHold, clamp(vec2<i32>(floor(in.uv * vec2<f32>(dims))),vec2<i32>(0),dims-vec2<i32>(1)),0);
            return vec4<f32>(held.rgb, 1.0 / 255.0);
        }
        return vec4<f32>(0.0);
    }
    return vec4<f32>(result.rgb, min(1.0, 1.0 / max(spacing,0.00001)));
}
`,
      "blit"
    );
    await this.ensureRenderPipeline("blit");
    await this.ensureRenderPipeline("retain");
    await this.ensureRenderPipeline("retainFloat");
  }

  private async oncePipeline(key:string,ready:()=>boolean,build:()=>Promise<void>) {
    if(this.disposed)throw new Error('Renderer has been disposed.');
    if(ready())return;
    let pending=this.pendingPipelines.get(key);
    if(!pending){
      pending=build();this.pendingPipelines.set(key,pending);
      void pending.finally(()=>{if(this.pendingPipelines.get(key)===pending)this.pendingPipelines.delete(key);}).catch(()=>{});
    }
    await pending;
    if(this.disposed)throw new Error('Renderer has been disposed.');
    if(this.deviceLost)throw Error('GPU connection lost. Reload to reconnect.');
  }

  private async ensureComputePipeline(kind:'reuse'|'direct'|'plain'|'approx'|'ordinaryPlain'|'ordinaryApprox'|'julia'|'juliaApprox'|'shade'|'decode'|'distance',shape:TuningSettings['workgroupShape']=DEFAULT_TUNING.workgroupShape) {
    if((kind==='ordinaryPlain'||kind==='ordinaryApprox')&&shape!==DEFAULT_TUNING.workgroupShape){
      const key=kind+':'+shape;
      await this.oncePipeline(key,()=>this.ordinaryShapePipelines.has(key),async()=>{
        const {x,y}=deliveryWorkgroup(shape),device=this.ctx.device;
        if(x>device.limits.maxComputeWorkgroupSizeX||y>device.limits.maxComputeWorkgroupSizeY||x*y>device.limits.maxComputeInvocationsPerWorkgroup)
          throw Error('Selected GPU workgroup exceeds this device’s limits.');
        if(!this.renderModule)throw Error('Shader module is unavailable.');
        const pipeline=await device.createComputePipelineAsync({label:key,layout:this.pipelineLayout!,
          compute:{module:this.renderModule,entryPoint:'compute',constants:{ORDINARY:1,APPROX:kind==='ordinaryApprox'?1:0,SAMPLE_WORKGROUP_X:x,SAMPLE_WORKGROUP_Y:y}}});
        if(this.deviceLost)throw Error('GPU connection lost. Reload to reconnect.');
        if(this.disposed)throw new Error('Renderer has been disposed.');
        this.ordinaryShapePipelines.set(key,pipeline);
      });
      return this.ordinaryShapePipelines.get(key)!;
    }
    const slot={reuse:'reusePipeline',direct:'directPipeline',plain:'renderPipeline',approx:'approxPipeline',ordinaryPlain:'ordinaryPlainPipeline',ordinaryApprox:'ordinaryApproxPipeline',julia:'juliaPipeline',juliaApprox:'juliaApproxPipeline',shade:'shadePipeline',decode:'referenceDecodePipeline',distance:'distanceToIterationPipeline'} as const;
    const field=slot[kind];
    await this.oncePipeline(kind,()=>!!this[field],async()=>{
      const module=kind==='reuse'?this.reuseModule:this.renderModule;
      if(!module)throw Error('Shader module is unavailable.');
      const names={reuse:'sample-reuse',direct:'direct-compute',plain:'perturbation-compute',approx:'approximation-compute',ordinaryPlain:'ordinary-perturbation-compute',ordinaryApprox:'ordinary-approximation-compute',julia:'julia-compute',juliaApprox:'julia-approximation-compute',shade:'perturbation-shade',decode:'reference-decode',distance:'distance-to-iteration-field'} as const;
      const entryPoint=kind==='reuse'?'remap':kind==='shade'?'shadePass':kind==='decode'?'decodeReferenceOrbit':kind==='distance'?'distanceToIterationField':'compute';
      const ordinaryKind=kind==='ordinaryPlain'||kind==='ordinaryApprox';
      const constants:Record<string,number>|undefined=ordinaryKind?{ORDINARY:1,APPROX:kind==='ordinaryApprox'?1:0,SAMPLE_WORKGROUP_X:ORDINARY_WORKGROUP_X,SAMPLE_WORKGROUP_Y:ORDINARY_WORKGROUP_Y}:kind==='direct'?{DIRECT:1}:kind==='approx'?{APPROX:1}:kind==='julia'?{JULIA:1}:kind==='juliaApprox'?{JULIA:1,APPROX:1}:undefined;
      const pipeline=await this.ctx.device.createComputePipelineAsync({label:names[kind],layout:kind==='reuse'||kind==='decode'?'auto':this.pipelineLayout!,compute:{module,entryPoint,...(constants?{constants}:{})}});
      if(this.deviceLost)throw Error('GPU connection lost. Reload to reconnect.');
      if(this.disposed)throw new Error('Renderer has been disposed.');
      (this[field] as GPUComputePipeline|null)=pipeline;
    });
    return this[field]!;
  }

  private async ensureContinuationPipeline(kind:'direct'|'plain'|'approx'|'ordinaryPlain'|'ordinaryApprox'|'julia'|'juliaApprox',pooled=false,coordinates=pooled) {
    const key=(pooled?'pooled-':coordinates?'cohort-':'')+kind;
    await this.oncePipeline('continuation-'+key,()=>this.continuationPipelines.has(key),async()=>{
      const device=this.ctx.device;
      if(device.limits.maxStorageBuffersPerShaderStage<8)throw Error('Continuation requires eight storage bindings');
      this.continuationModule??=await compileShader(device,
        [compensatedSource,quadSource,quadFastSource,perturbationSource,wideSource,continuationSource].join('\n'),
        'continuation');
      this.continuationLayout??=device.createBindGroupLayout({label:'continuation-state',entries:[
        {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}}]});
      const constants={DIRECT:kind==='direct'?1:0,JULIA:kind.startsWith('julia')?1:0,ORDINARY:kind.startsWith('ordinary')?1:0,APPROX:kind==='approx'||kind==='ordinaryApprox'||kind==='juliaApprox'?1:0,POOL_COORDINATES:coordinates?1:0};
      const pipeline=await device.createComputePipelineAsync({label:'continuation-'+key,
        layout:device.createPipelineLayout({bindGroupLayouts:[this.bindLayout!,this.continuationLayout]}),
        compute:{module:this.continuationModule,entryPoint:pooled?'computePooled':'computeContinued',constants}});
      if(this.deviceLost)throw Error('GPU connection lost. Reload to reconnect.');
      this.continuationPipelines.set(key,pipeline);
    });
    return this.continuationPipelines.get(key)!;
  }

  private async ensureSurvivorCollector() {
    const key='collect-survivors';
    await this.oncePipeline(key,()=>this.continuationPipelines.has(key),async()=>{
      if(!this.continuationModule)throw Error('Continuation module is unavailable');
      const device=this.ctx.device;
      const empty=device.createBindGroupLayout({entries:[]});
      const states=device.createBindGroupLayout({entries:[0,1].map(binding=>
        ({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage' as const}}))});
      const pipeline=await device.createComputePipelineAsync({label:key,
        layout:device.createPipelineLayout({bindGroupLayouts:[empty,states]}),
        compute:{module:this.continuationModule,entryPoint:'collectSurvivors'}});
      if(this.deviceLost)throw Error('GPU connection lost. Reload to reconnect.');
      this.continuationPipelines.set(key,pipeline);
    });
    return this.continuationPipelines.get(key)!;
  }

  private async ensureRenderPipeline(kind:'blit'|'retain'|'retainFloat') {
    const field=kind==='blit'?'blitPipeline':kind==='retain'?'retainPipeline':'retainFloatPipeline';
    await this.oncePipeline(kind,()=>!!this[field],async()=>{
      const device=this.ctx.device;
      const module=this.blitModule;
      if(!module)throw Error('Presentation shader is unavailable.');
      const format:GPUTextureFormat=kind==='blit'?this.format:kind==='retain'?'rgba8unorm':'rgba16float';
      const descriptor:GPURenderPipelineDescriptor={label:kind,layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-strip'}};
      const pipeline=await device.createRenderPipelineAsync(descriptor);
      if(this.disposed)throw new Error('Renderer has been disposed.');
      if(this.deviceLost)throw Error('GPU connection lost. Reload to reconnect.');
      (this[field] as GPURenderPipeline|null)=pipeline;
    });
    return this[field]!;
  }

  private referenceBudget(maxIterations:number,dynamic=false,family:ReferenceOrbitInput['family']='mandelbrot'):number {
    const limit=Math.min(this.ctx.device.limits.maxStorageBufferBindingSize,this.ctx.device.limits.maxBufferSize);
    // A capped reference must cover the requested trajectory. Device capacity
    // is checked separately; it must never silently shorten that trajectory.
    const decodedBytesPerSample=family==='julia'?96:48;
    const ceiling=Math.max(1,Math.min(MAX_REFERENCE_ITERATIONS,Math.floor(limit/decodedBytesPerSample)-1));
    // A live Dynamic limit changes in small steps. Preparing the next power
    // of two avoids rebuilding the CPU orbit and BLA table at every step.
    const desired=dynamic?2**Math.ceil(Math.log2(Math.max(1,maxIterations))):maxIterations;
    return Math.max(maxIterations,Math.min(desired,ceiling));
  }

  private referenceDemand(request: RenderRequest, limbs: number): ReferenceDemand {
    const family = request.family ?? "mandelbrot";
    const input:ReferenceOrbitInput={
      family,
      centerX: coordinateToFixed(request.centerX, 'Center X'), centerY: coordinateToFixed(request.centerY, 'Center Y'),
      juliaX: request.juliaX ? coordinateToFixed(request.juliaX, 'Julia X') : "0", juliaY: request.juliaY ? coordinateToFixed(request.juliaY, 'Julia Y') : "0",
      limbs, maxIterations: this.referenceBudget(request.maxIterations,request.dynamicIterations,family),
    };
    let referenceX=request.centerX,referenceY=request.centerY;
    const constant=family==='julia'?`${request.juliaX},${request.juliaY}`:'';
    if(this.refValid&&!this.refEscaped&&this.refTerminal&&this.refSamples&&
        family===this.refFamily&&constant===this.refConstant&&limbs===this.refLimbs&&
        input.maxIterations>this.refIterations){
      const domain=renderDomain(request);
      const allowance=request.unitsPerPixel.times(Math.min(domain.width,domain.height)/4);
      const drift=request.centerX.minus(this.refX).abs().plus(request.centerY.minus(this.refY).abs());
      const retained={...input,centerX:coordinateToFixed(this.refX,'Reference X'),centerY:coordinateToFixed(this.refY,'Reference Y')};
      // Extend only the exact admitted trajectory. Camera motion inside the
      // existing reuse bound does not turn a cap increase into a new orbit.
      if(drift.lte(allowance)&&this.refTerminal.identity===referenceIdentity(retained)){
        input.centerX=retained.centerX;input.centerY=retained.centerY;
        referenceX=this.refX;referenceY=this.refY;
      }
    }
    return {input,centerX:request.centerX,centerY:request.centerY,referenceX,referenceY,view:request,followView:!!request.followView};
  }

  private referenceDemandCompatible(demand: ReferenceDemand, request: RenderRequest): boolean {
    const visible=request;
    request=this.workRequest(request);
    const method = methodForScale(request.unitsPerPixel,request.tuning);
    if (method === Method.Direct) return false;
    const family = request.family ?? "mandelbrot";
    if (family !== demand.input.family || this.referenceBudget(request.maxIterations,request.dynamicIterations,family) > demand.input.maxIterations) return false;
    if (family === "julia" &&
        (!request.juliaX?.eq(demand.input.juliaX) || !request.juliaY?.eq(demand.input.juliaY))) return false;
    let limbs: number;
    try { limbs = limbsForScale(request.unitsPerPixel, 96); }
    catch { return false; }
    if (limbs !== demand.input.limbs) return false;
    const domain = renderDomain(request);
    const halfSpan = request.unitsPerPixel.times(Math.min(domain.width, domain.height) / 2);
    const drift = request.centerX.minus(demand.referenceX).abs().plus(request.centerY.minus(demand.referenceY).abs());
    return drift.lessThanOrEqualTo(halfSpan.times(0.5))||
      this.inwardPreparationContinues(demand.view,visible);
  }

  private cancelPendingReference(message: string) {
    if (!this.pendingReferenceDemand && !this.referencePrefetch && !this.referenceWorker.active) return;
    this.pendingReferenceDemand = null;
    if(this.referencePrefetch)this.referencePrefetch.cancelled=true;
    this.referencePrefetch=null;
    this.referenceWorker.cancel(message);
  }

  /** Speculation owns CPU data only; the normal foreground path admits GPU data. */
  private prefetchCompatible(job:ReferencePrefetch,live:RenderRequest):boolean {
    if(job.claimed)return this.pendingReferenceDemand===job.claimed&&this.referenceDemandCompatible(job.claimed,live);
    if(!live.followView||!live.interacting||!live.heldInwardZoom||(live.zoom??0)<=0||
       (live.family??'mandelbrot')!=='mandelbrot'||live.angle||live.exportDomain||live.stationaryOversampling||
       live.colors.mode!==0||live.colors.supersample!==1||needsEndpoints(live.colors)||(live.colors.capped??0)!==0||
       !live.useApprox||blaTableEpsilon(live)!==job.epsilonLog2)return false;
    const focus=live.focus??{x:.5,y:.5};
    let limbs:number;try{limbs=limbsForScale(this.workRequest(live).unitsPerPixel,96);}catch{return false;}
    return focus.x===.5&&focus.y===.5&&live.centerX.eq(job.owner.centerX)&&live.centerY.eq(job.owner.centerY)&&
      this.referenceBudget(live.maxIterations,live.dynamicIterations,'mandelbrot')<=job.demand.input.maxIterations&&
      limbs<=job.demand.input.limbs;
  }

  private startReferencePrefetch(request:RenderRequest):void {
    if(this.referencePrefetch||this.pendingReferenceDemand||this.referenceWorker.active||this.referencePreparing||
       !this.refValid||this.disposed||this.abortRequested)return;
    const live=this.currentView??request,rate=live.zoomRate??0;
    if(!Number.isFinite(rate)||rate<=0||!request.useApprox||!live.followView||!live.interacting||!live.heldInwardZoom||
       (live.zoom??0)<=0||(live.family??'mandelbrot')!=='mandelbrot'||live.angle||live.exportDomain||live.stationaryOversampling||
       live.colors.mode!==0||live.colors.supersample!==1||needsEndpoints(live.colors)||(live.colors.capped??0)!==0)return;
    const focus=live.focus??{x:.5,y:.5};if(focus.x!==.5||focus.y!==.5)return;
    const work=this.workRequest(live),factor=Math.exp(-rate*1.5);
    if(!Number.isFinite(factor)||factor<=0)return;
    let next:number;try{next=limbsForScale(work.unitsPerPixel.times(factor),96);}catch{return;}
    if(next!==LIMB_PROFILES[LIMB_PROFILES.indexOf(this.refLimbs as typeof LIMB_PROFILES[number])+1])return;
    // Predict the existing planner's first dyadic grid at the next profile.
    // Its exact centre is only a cache key; mismatched foreground demand cancels
    // speculation rather than changing its reference parameter or admission.
    if(!this.numericalAnchor)return;
    let spacing=work.unitsPerPixel;
    while(limbsForScale(spacing,96)<next)spacing=spacing.div(2);
    const limits=this.ctx.device.limits;
    const forecast=planNumericalView({...live,unitsPerPixel:spacing.times(2).times(1-1e-12)},this.numericalAnchor,
      {maxDimension:limits.maxTextureDimension2D,maxSamples:Math.floor(Math.min(limits.maxStorageBufferBindingSize,limits.maxBufferSize)/8)});
    if(!forecast||!forecast.unitsPerPixel.eq(spacing))return;
    const future={...live,...forecast,workView:true};
    const demand=this.referenceDemand(future,next),cached=this.referenceCache.get(demand.input);
    if(cached&&(cached.escaped||cached.terminal.iteration>=demand.input.maxIterations))return;
    // A discarded orbit would be rebuilt in the foreground. A shorter escaped
    // orbit may also leave room for its table, even when the capped pair would not.
    if((demand.input.maxIterations+1)*40>128*1024*1024)return;
    const epsilonLog2=blaTableEpsilon(work),maxDelta=approximationDeltaBound('mandelbrot',future,demand.referenceX,demand.referenceY);
    const job:ReferencePrefetch={demand,epsilonLog2,owner:live,claimed:null,cancelled:false,promise:Promise.resolve()};
    this.referencePrefetch=job;
    const checkCurrent=()=>{
      if(job.cancelled||this.referencePrefetch!==job||this.disposed||this.abortRequested||
         request.isCurrent&&!request.isCurrent()||!this.prefetchCompatible(job,this.currentView??request))
        throw new DOMException('Superseded reference prefetch','AbortError');
    };
    job.promise=this.trackOperation(async()=>{
      try{
        const limit=Math.min(this.ctx.device.limits.maxStorageBufferBindingSize,this.ctx.device.limits.maxBufferSize);
        const capacity=Math.floor(limit/48)-1;
        const orbit=await prepareReference(demand.input,(input,resume)=>{
          const budget=Math.min(REFERENCE_CHUNK_ITERATIONS,capacity-(resume?.iteration??0));
          if(budget<1)throw Error('Prefetched trajectory exceeds reference capacity');
          return this.referenceWorker.generate(input,resume,budget);
        },checkCurrent,cached,yieldToEvents);
        checkCurrent();this.referenceCache.remember(demand.input,orbit);
        if(orbit.samples.byteLength+orbit.length*ENTRY_FLOATS*4>128*1024*1024)return;
        const table=await buildBlaAsync(orbit.samples,orbit.length,maxDelta,async()=>{await yieldToEvents();checkCurrent();},
          {sampleWords:orbit.sampleWords,epsilonLog2});
        checkCurrent();this.blaCache.remember(orbit.samples,orbit.length,orbit.sampleWords,epsilonLog2,maxDelta,table);
      }finally{if(this.referencePrefetch===job)this.referencePrefetch=null;}
    });
    // Observe failure immediately. Foreground demand can retry through its normal path.
    void job.promise.catch(()=>{});
  }

  /** Generates and transfers the packed reference in one persistent worker. */
  private async generateOrbit(
    request: RenderRequest,
    limbs: number
  ): Promise<{ length: number; escaped: boolean; ms: number; samples: Float32Array<ArrayBuffer>; terminal: ReferenceResumeState;
      formatVersion: typeof REFERENCE_FORMAT_VERSION; sampleWords: ReferenceSampleWords; referenceX: Decimal; referenceY: Decimal }> {
    const started = performance.now(), demand = this.referenceDemand(request, limbs);
    const limit=Math.min(this.ctx.device.limits.maxStorageBufferBindingSize,this.ctx.device.limits.maxBufferSize);
    const decodedBytesPerSample=demand.input.family==='julia'?96:48;
    const capacity = Math.floor(limit / decodedBytesPerSample) - 1;
    const prefetch=this.referencePrefetch;
    const claim=prefetch&&!prefetch.cancelled&&referenceIdentity(prefetch.demand.input)===referenceIdentity(demand.input)&&
      prefetch.demand.input.maxIterations>=demand.input.maxIterations;
    if(prefetch&&!claim)this.cancelPendingReference('Foreground reference changed');
    this.pendingReferenceDemand = demand;
    if(claim)prefetch.claimed=demand;
    this.pipelineWaitMs = 0;
    // This demand always needs decoding: overlap its preparation with the CPU
    // orbit, without compiling unrelated numerical variants at startup.
    const decodePreparation=Promise.all([
      this.ensureComputePipeline('decode'),
    ]);
    // A superseded/failed worker may leave before the later await. Observe the
    // rejection now; the original promise still reports it to current demand.
    void decodePreparation.catch(()=>{});
    try {
      const checkCurrent = () => {
        const live = demand.followView ? this.currentView ?? request : request;
        if (this.pendingReferenceDemand !== demand || this.abortRequested || this.disposed ||
            request.isCurrent && !request.isCurrent() || !this.referenceDemandCompatible(demand, live)) {
          throw new DOMException('Superseded reference', 'AbortError');
        }
      };
      if(claim){await prefetch.promise.catch(()=>{});checkCurrent();}
      const cached=this.referenceCache.get(demand.input);
      const active=this.refValid && this.refSamples && this.refTerminal ? { samples:this.refSamples, terminal:this.refTerminal,
        formatVersion:this.refFormatVersion, sampleWords:this.refSampleWords } : undefined;
      // An oversized extension may outgrow the cache; keep its longer active prefix.
      const previous=cached && (!active || active.terminal.identity!==referenceIdentity(demand.input) ||
        cached.escaped || cached.terminal.iteration>=active.terminal.iteration) ? cached : active;
      const orbit = cached && (cached.escaped||cached.terminal.iteration>=demand.input.maxIterations)?cached:await prepareReference(demand.input,
        (input, resume) => {
          const budget = Math.min(REFERENCE_CHUNK_ITERATIONS, capacity - (resume?.iteration ?? 0));
          if (budget < 1) throw new Error('This trajectory needs a longer reference than this GPU can hold. No result was finalised.');
          return this.referenceWorker.generate(input, resume, budget);
        }, checkCurrent,
        previous,
        yieldToEvents);
      checkCurrent();
      this.referenceCache.remember(demand.input,orbit);
      const samples = orbit.samples;
      const pipelineStarted=performance.now();
      await decodePreparation;
      this.pipelineWaitMs+=performance.now()-pipelineStarted;
      if(this.pendingReferenceDemand!==demand||this.abortRequested||request.isCurrent&&!request.isCurrent())throw new DOMException('Superseded reference','AbortError');
      const device=this.ctx.device;
      let raw:GPUBuffer|undefined,replacement:GPUBuffer|undefined;
      try{
        await checkedGpu(device,()=>{
          raw=storageBuffer(device,orbit.length*orbit.sampleWords,"reference-orbit-raw");
          replacement=storageBuffer(device,orbit.length*(orbit.sampleWords/10)*12,"reference-orbit-decoded",GPUBufferUsage.COPY_SRC);
        });
        for (let offset = 0; offset < samples.length; offset += REFERENCE_TRANSFER_FLOATS) {
          checkCurrent();
          const part = samples.subarray(offset, Math.min(samples.length, offset + REFERENCE_TRANSFER_FLOATS));
          // Error scopes are opened and popped synchronously by checkedGpu;
          // another renderer may safely run at the following event-loop yield.
          await checkedGpu(device,()=>{
            device.queue.writeBuffer(raw!, offset * Float32Array.BYTES_PER_ELEMENT, part);

          });
          if (offset + part.length < samples.length) await yieldToEvents();
        }
        checkCurrent();
        await checkedGpu(device,()=>{
          const encoder=device.createCommandEncoder({label:'decode-reference-orbit'});
          const decode=encoder.beginComputePass({label:'decode-reference-orbit'});
          decode.setPipeline(this.referenceDecodePipeline!);
          decode.setBindGroup(0,device.createBindGroup({layout:this.referenceDecodePipeline!.getBindGroupLayout(0),entries:[
            {binding:0,resource:{buffer:raw!}},{binding:9,resource:{buffer:replacement!}},
          ]}));
          const dispatch = referenceDecodeDispatch(orbit.length*(orbit.sampleWords/10), device.limits.maxComputeWorkgroupsPerDimension);
          decode.dispatchWorkgroups(...dispatch);decode.end();
          device.queue.submit([encoder.finish()]);
          return device.queue.onSubmittedWorkDone();
        });
        const currentLive=demand.followView?this.currentView??request:request;
        if(this.pendingReferenceDemand!==demand||request.isCurrent&&!request.isCurrent()||!this.referenceDemandCompatible(demand,currentLive))throw new DOMException("Superseded reference","AbortError");
        this.clearContinuationWork();
        const previous=this.orbitBuffer;this.orbitBuffer=replacement!;replacement=undefined;this.orbitCapacity=orbit.length;previous?.destroy();
      }finally{raw?.destroy();replacement?.destroy();}
      return { length: orbit.length, escaped: orbit.escaped, ms: performance.now() - started, samples, terminal:orbit.terminal,
        formatVersion:orbit.formatVersion, sampleWords:orbit.sampleWords, referenceX:demand.referenceX,referenceY:demand.referenceY };
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
    this.requireLiveMethod(request);

    const live=request.followView?this.currentView??request:request;
    // Reserve four outward doublings in this same conservative table. Rebuilding
    // a long table for every slightly wider target lets the camera outrun work.
    const outward=request.followView&&live.interacting&&(live.zoom??0)<0;
    const maxDelta = approximationDeltaBound(request.family ?? "mandelbrot", request, this.refX, this.refY).times(outward?16:1);

    const samples = this.refSamples;
    if (!samples || samples.length !== this.refLength * this.refSampleWords) {
      throw new Error("The CPU reference orbit is unavailable for approximation");
    }
    const epsilonLog2=blaTableEpsilon(request);
    const sourceOrbit=this.orbitBuffer;
    const checkCurrent=()=>{
      if(this.disposed||this.abortRequested||request.isCurrent&&!request.isCurrent()||
          this.refSamples!==samples||this.orbitBuffer!==sourceOrbit)throw new DOMException('Superseded table','AbortError');
      this.requireLiveMethod(request);
    };
    const checkpoint=async()=>{
      await yieldToEvents();
      checkCurrent();
    };
    const cached=this.blaCache.get(samples,this.refLength,this.refSampleWords,epsilonLog2,maxDelta);
    const table = cached?.table??await buildBlaAsync(samples, this.refLength, maxDelta, checkpoint,
       { sampleWords: this.refSampleWords, epsilonLog2 });
    checkCurrent();
    if(!cached)this.blaCache.remember(samples,this.refLength,this.refSampleWords,epsilonLog2,maxDelta,table);
    if(table.data.byteLength>Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize))throw Error('The approximation table exceeds this GPU’s buffer capacity.');
    const tableMs = performance.now() - started;
    // Builders own an ordinary ArrayBuffer. Narrow its type without copying
    // the complete table just to satisfy writeBuffer's concrete source type.
    const tableData = table.data.buffer;
    if(!(tableData instanceof ArrayBuffer))throw Error('The approximation table has an incompatible data buffer.');
    const index = new Uint32Array(Math.max(2, table.levels * 2));
    for (let level = 0; level < table.levels; level++) {
      index[level] = table.levelOffsets[level];
      index[table.levels + level] = table.levelCounts[level];
    }
    let nextTable:GPUBuffer|undefined,nextIndex:GPUBuffer|undefined;
    try{
      await checkedGpu(device,()=>{

        nextTable=storageBuffer(device,Math.max(8,table.data.length),'la-table');
        nextIndex=storageBuffer(device,index.length,'la-index');
        device.queue.writeBuffer(nextIndex,0,index);
      });

      for(let offset=0;offset<table.data.length;offset+=REFERENCE_TRANSFER_FLOATS){
        checkCurrent();

        const count=Math.min(REFERENCE_TRANSFER_FLOATS,table.data.length-offset);
        const part=new Float32Array(tableData,table.data.byteOffset+offset*4,count);
        await checkedGpu(device,()=>{
          device.queue.writeBuffer(nextTable!,offset*4,part);

        });
        if(offset+count<table.data.length)await checkpoint();
      }
      checkCurrent();
      // No partial upload or canceled identity can replace the admitted table.
      this.clearContinuationWork();
      const previousTable=this.laBuffer,previousIndex=this.laIndexBuffer;
      this.laBuffer=nextTable!;this.laIndexBuffer=nextIndex!;nextTable=undefined;nextIndex=undefined;
      this.tableMaxDelta=cached?.maxDelta??maxDelta;this.tableEpsilonLog2=epsilonLog2;
      this.laLevels=table.entryCount===0?0:table.levels;
      this.laHasUsableMultiStep=table.entryCount!==0&&table.hasUsableMultiStep;
      this.tableMs=tableMs;
      previousTable?.destroy();previousIndex?.destroy();
    }finally{nextTable?.destroy();nextIndex?.destroy();}
  }

  private async ensureTarget(width: number, height: number) {
    if (this.target && this.targetSize.width === width && this.targetSize.height === height) {
      return;
    }
    let replacement:GPUTexture|undefined;
    try{await checkedGpu(this.ctx.device,()=>{replacement = this.ctx.device.createTexture({
      label: "render-target",
      size: { width, height },
      format: "rgba8unorm",
      viewFormats:['rgba8unorm-srgb'],
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    });}catch(error){replacement?.destroy();throw error;}
    this.incomingFrame=null;
    this.currentImageValid=false;this.target?.destroy();this.target=replacement!;
    this.targetSize = { width, height };
  }

  /**
   * Keeps the history texture at its own size, independent of the render
   * target.
   *
   * Retain one useful completed source while preparing the incoming image.
   * Neither source changes geometry without its corresponding pixel copy.
   */
  private commitHistory(request: NonNullable<WebGpuRenderer["lastFrame"]>,candidate:GPUTexture) {
    const live=this.currentView,view=live??request;
    const compatible = (frame: WebGpuRenderer["lastFrame"]) => this.samePresentation(frame,request)||
      !!(live&&
        this.presentationCompatible(request,live)&&this.presentationCompatible(frame,live));
    const bounds = (frame: FrameView) => {
      if((frame.angle??0)!==(view.angle??0))return [0,0,0,0];
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
    const priorCap=!!(this.lastFrame&&this.lastFrame.maxIterations!==request.maxIterations&&compatible(this.lastFrame));
    // A native completed view is already authoritative. Keep extra partial
    // detail only when bounding the replacement actually coarsened the view.
    const finerFront = request.unitsPerPixel.gt(view.unitsPerPixel) && compatible(this.lastFrame) &&
      this.hasFinerRetainedCoverage(this.lastFrame,request,view);
    const finerBack = finerFront && compatible(this.coverageFrame) && this.hasFinerRetainedCoverage(this.coverageFrame,request,view);
    const coversView = incoming[0]===0 && incoming[1]===0 && incoming[2]===1 && incoming[3]===1;
    const keepFront = this.historyValid && (this.lastFrame?.snapshotComplete||priorCap||finerFront) && compatible(this.lastFrame) &&
      (coversView && finerFront && !finerBack || !compatible(this.coverageFrame) || score(this.lastFrame!) > score(this.coverageFrame!));
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
    this.spareHistory?.destroy();this.spareHistory=available;this.history=candidate;
    this.historyValid=true;
  }

  private candidateTexture(width:number,height:number){
    const spare=this.spareHistory;
    this.spareHistory=null;
    const usage=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST;
    if(spare&&spare.format==='rgba8unorm'&&spare.width===width&&spare.height===height&&(spare.usage&usage)===usage)return spare;
    spare?.destroy();
    return this.ctx.device.createTexture({label:'complete-frame',size:{width,height},format:'rgba8unorm',viewFormats:['rgba8unorm-srgb'],usage});
  }

  private snapshotFrame(frame: NonNullable<WebGpuRenderer["lastFrame"]>) {
    const limit=this.ctx.device.limits.maxTextureDimension2D,live=this.currentView;
    const bounded=boundedRetainedView(frame,limit);
    // Preserve wider coverage when the source already fits: its full copy is
    // lossless. Crop only to avoid the bounded snapshot's coarsening.
    const retained=bounded.unitsPerPixel.gt(frame.unitsPerPixel)&&live&&(live.zoom??0)>=0&&frame.interacting&&
      (frame.zoom??0)>0&&!frame.stationaryOversampling&&this.presentationCompatible(frame,live)
      ? sourceAlignedRetainedView(frame,live,limit)??bounded : bounded;
    return {...frame,...retained,stationaryOversampling:frame.stationaryOversampling&&this.sameView(frame,retained),proxy:true,snapshotComplete:true,
      coveredRegions:[{x:0,y:0,width:retained.width,height:retained.height,spacing:retained.unitsPerPixel}]};
  }

  private encodeCompletedSnapshot(encoder:GPUCommandEncoder,frame:NonNullable<WebGpuRenderer["lastFrame"]>,retained:FrameView,candidate:GPUTexture){
    if(this.sameView(frame,retained)){
      encoder.copyTextureToTexture({texture:this.target!},{texture:candidate},{width:frame.width,height:frame.height});
      return;
    }
    const crop=sampleGridRemap(frame,retained);
    if(crop?.step===1&&crop.denominator===1&&crop.offsetX>=0&&crop.offsetY>=0&&
        crop.offsetX+retained.width<=frame.width&&crop.offsetY+retained.height<=frame.height){
      encoder.copyTextureToTexture({texture:this.target!,origin:{x:crop.offsetX,y:crop.offsetY}},
        {texture:candidate},{width:retained.width,height:retained.height});
      return;
    }
    const live=this.currentView,incoming=this.incomingFrame;
    this.currentView={...frame,...retained};this.incomingFrame=frame;
    try{this.encodeBlit(encoder,this.target!,reprojectionFor(frame,retained,true)!,candidate,false,true);}
    finally{this.currentView=live;this.incomingFrame=incoming;}
  }

  /**
   * The orbit buffer is bound on every render, so it has to exist even when the
   * direct method never reads it.
   */
  /** Largest sample grid up to `wanted` whose field fits in one binding. */
  private affordableGrid(wanted: number, width: number, height: number): number {
    const limit = Math.min(this.ctx.device.limits.maxStorageBufferBindingSize,this.ctx.device.limits.maxBufferSize);
    for (let grid = wanted; grid >= 1; grid--) {
      if (width * height * grid * grid * 8 <= limit) return grid;
    }
    throw Error('The sample field exceeds this GPU’s buffer capacity. Reduce the viewport.');
  }

  private moveField(request: RenderRequest, samples: number, key: string, reuse: boolean, grid = 1, capMapping: SampleGridRemap | null = null, lowerCap = 0): boolean {
    const previous = this.fieldBuffer, previousCapacity = this.fieldCapacity;
    const mapping = capMapping ?? (reuse && !request.exportDomain && !this.fieldView?.exportDomain && previous && this.fieldView && this.sampleKey === key
      ? sampleGridRemap(this.fieldView, request) : null);
    this.reuseMapping = mapping; this.reusableView = this.fieldView; this.reusableComplete = this.fieldComplete;
    // Only completed native-density rectangles certify exact copied samples.
    this.reusableKnownRectangles=mapping&&grid===1&&!capMapping
      ?this.determined.rectangles.filter(r=>r.spacing===1).map(r=>({...r})):[];
    // Geometry ownership moves now, even if the caller is cancelled before its
    // later pending reset. Old-coordinate certificates must not survive adoption.
    this.determined=new CoverageRegions();this.determinedRegion=null;
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
        lowerCap, 0, 0, 0,
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
    this.fieldView = { centerX: request.centerX, centerY: request.centerY, angle:request.angle??0,
      unitsPerPixel: request.unitsPerPixel, width: request.width, height: request.height, exportDomain: request.exportDomain };
    this.sampleKey = key;
    return !!mapping;
  }

  private ensureOrbitCapacity(samples: number) {
    if (this.orbitCapacity >= samples && this.orbitBuffer) return;
    if(samples*96>Math.min(this.ctx.device.limits.maxStorageBufferBindingSize,this.ctx.device.limits.maxBufferSize))throw Error('This iteration limit exceeds this GPU’s decoded-reference buffer capacity.');
    this.clearContinuationWork();
    this.orbitBuffer?.destroy();
    this.orbitBuffer = storageBuffer(
      this.ctx.device,
      samples * 24,
      "reference-orbit-decoded",
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
    xform: Reprojection,
    destination?: GPUTexture,
    allowAppearanceFallback=false,
    completedSnapshot=false,
  ) {
    const { device } = this.ctx;
    if(!destination && (!this.screenHold || this.screenHoldSize.width!==this.canvas.width || this.screenHoldSize.height!==this.canvas.height)){
      this.screenHold?.destroy();
      this.screenHoldSize={width:this.canvas.width,height:this.canvas.height};
      this.screenHold=device.createTexture({label:'last-presented-screen',size:this.screenHoldSize,
        format:this.format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
      this.screenHoldValid=false;
    }
    if (!this.xformBuffer) {
      this.xformBuffer = device.createBuffer({
        label: "blit-xform",
        size: 144,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    const matchesView = (frame: WebGpuRenderer["lastFrame"]) => !this.currentView || this.presentationCompatible(frame,this.currentView)||
      !!(allowAppearanceFallback&&frame===this.lastFrame)||
      !!(allowAppearanceFallback&&this.appearanceHoldFrame&&this.appearanceHoldActive(this.currentView)&&
        this.samePresentation(frame,this.appearanceHoldFrame));
    const secondaryFrame=completedSnapshot?null:source===this.history?this.coverageFrame:this.historyValid?this.lastFrame:null;
    const secondaryTexture=completedSnapshot?null:source===this.history?this.coverageHistory:this.history;
    const coverage = secondaryTexture && secondaryFrame && matchesView(secondaryFrame) && this.currentView
      ? reprojectionFor(secondaryFrame, this.currentView, true, true) : null;
    const frontFrame=source===this.history?this.lastFrame:      source===this.target?this.incomingFrame??this.completedFrame:null;
    const transforms = new Float32Array(36);
    transforms[32]=frontFrame?.stationaryOversampling?frontFrame.colors.gamma:0;
    transforms[33]=secondaryFrame?.stationaryOversampling?secondaryFrame.colors.gamma:0;
    transforms[34]=this.incomingFrame?.stationaryOversampling?this.incomingFrame.colors.gamma:0;
    transforms[35]=!destination&&this.screenHoldValid?1:0;
    transforms.set([xform.scaleX,xform.scaleY,xform.offsetX,xform.offsetY]);
    transforms.set([xform.crossX??0,xform.crossY??0],24);
    transforms[10] = source !== this.history || this.historyValid && matchesView(this.lastFrame) ? 1 : 0;
    transforms[11] = source===this.target ? 1 : 0;
    if (xform.scaleX*xform.scaleY-(xform.crossX??0)*(xform.crossY??0) === 0) transforms[10] = 0;
    if (source === this.target && !this.currentImageValid) transforms[10] = 0;
    if (coverage && secondaryTexture) {
      transforms.set([coverage.scaleX, coverage.scaleY, coverage.offsetX, coverage.offsetY], 4);
      transforms.set([coverage.crossX??0,coverage.crossY??0],26);
      transforms[8] = 1;
      const front = frontFrame!, view = this.currentView!;
      const exactStationary = !front.proxy && front.unitsPerPixel.lte(view.unitsPerPixel) && this.sameView(front,this.workRequest(view));
      transforms[9] = !front.proxy && !exactStationary && secondaryFrame!.unitsPerPixel.lt(front.unitsPerPixel) ? 1 : 0;
    }
    const fresh = this.incomingFrame, view = this.currentView;
    if (fresh && view && this.target && this.presentationCompatible(fresh,view)) {
      const m = reprojectionFor(fresh, view)??reprojectionFor(fresh,view,true,true);
      if (m) {
        transforms.set([m.scaleX, m.scaleY, m.offsetX, m.offsetY], 12);
        transforms.set([m.crossX??0,m.crossY??0],28);
        transforms[16] = 1;
        // A fully sampled outward preview can still be coarser than retained detail.
        const exact = fresh.unitsPerPixel.lte(view.unitsPerPixel) && this.sameView(fresh,this.workRequest(view));
        transforms[17] = exact ? 1 : 0;
        transforms[18] = exact ? 1 : 0;
      }
    }
    const pixelUnit=this.currentView?.unitsPerPixel;
    transforms[20]=pixelUnit ? frontFrame?.unitsPerPixel.div(pixelUnit).toNumber()??1 : 1;
    transforms[21]=pixelUnit ? secondaryFrame?.unitsPerPixel.div(pixelUnit).toNumber()??1 : 1;
    transforms[22]=pixelUnit ? this.incomingFrame?.unitsPerPixel.div(pixelUnit).toNumber()??1 : 1;
    if(frontFrame?.proxy) transforms[9]=-1;
    device.queue.writeBuffer(this.xformBuffer, 0, transforms);

    const pipeline=destination ? destination.format === "rgba16float" ? this.retainFloatPipeline! : this.retainPipeline! : this.blitPipeline!;
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.xformBuffer } },
        { binding: 3, resource: (secondaryTexture ?? source).createView() },
        { binding: 4, resource: (this.target ?? source).createView() },
        { binding: 5, resource: (this.screenHold ?? source).createView() },
      ],
    });
    const presented=destination??this.context.getCurrentTexture();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: presented.createView(),
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
    // Keep the last colour at each screen pixel as fresh partial regions arrive.
    // This copy follows the pass and never enters numerical history or exports.
    if(!destination&&this.screenHold){
      encoder.copyTextureToTexture({texture:presented},{texture:this.screenHold},this.screenHoldSize);
      this.screenHoldValid=true;
    }
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
    this.clearContinuationWork();
    if(this.batchCostKey)this.batchFeedback.enterTarget(true);
    this.batchCostKey="";
    this.abortRequested = true;
    this.cancelPendingReference("Reference generation aborted");
  }

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if(this.disposed)return Promise.reject(new Error('Renderer has been disposed.'));
    const pending = operation();
    this.activeOperations.add(pending);
    void pending.finally(() => this.activeOperations.delete(pending)).catch(() => {});
    return pending;
  }

  /** Releases this renderer only; the caller's shared GPU device stays usable. */
  dispose(): Promise<void> {
    if(this.disposePromise)return this.disposePromise;
    this.disposed=true;
    this.lossHook.notify=null;
    this.publicationEpoch++;
    this.abort();
    this.referenceWorker.cancel('Renderer disposed');
    this.disposePromise=(async()=>{
      await Promise.allSettled([...this.activeOperations,...this.pendingPipelines.values(),...(this.pendingRetain?[this.pendingRetain]:[])]);
      // Disposal must still release allocations after device loss or a failed fence.
      try { await this.ctx.device.queue.onSubmittedWorkDone(); } catch { /* lost device */ }
      this.timing.dispose();
      const resources=new Set<GPUBuffer|GPUTexture>([
        this.uniformBuffer,this.stopsBuffer,this.statsBuffer,
        this.fieldBuffer,this.spareField,this.endpointBuffer,this.orbitBuffer,
        this.laBuffer,this.laIndexBuffer,this.reuseUniform,this.xformBuffer,
        this.target,this.history,this.coverageHistory,this.spareHistory,
        this.screenHold,
        this.lastPresentedSource,
      ].filter((value):value is GPUBuffer|GPUTexture=>!!value));
      for(const resource of resources)resource.destroy();
      this.context.unconfigure();
      this.fieldBuffer=null;this.spareField=null;this.endpointBuffer=null;this.orbitBuffer=null;
      this.laBuffer=null;this.laIndexBuffer=null;this.reuseUniform=null;this.xformBuffer=null;
      this.target=null;this.history=null;this.coverageHistory=null;this.spareHistory=null;this.screenHold=null;this.admittedSamples=null;
      this.refSamples=null;this.refValid=false;this.referenceCache.clear();this.blaCache.clear();
      this.pendingReferenceDemand=null;this.fieldUniforms=null;this.partialAppearanceUniforms=null;
      this.currentView=null;this.fieldView=null;this.completedFrame=null;this.lastFrame=null;this.regionCoverage=null;
      this.coverageFrame=null;this.incomingFrame=null;this.appearanceHoldFrame=null;
      this.lastPresentedSource=null;this.lastPresentedFrame=null;this.lastPresentedCoverage=null;this.cachedStats=null;this.fieldStats=null;this.fieldDescriptor=null;
      this.retainedAnchor=null;this.reuseMapping=null;this.reusableView=null;
      this.reusableKnownRectangles=[];
      this.pending.reset(0,0);this.determined=new CoverageRegions();
      this.activeOperations.clear();this.pendingPipelines.clear();this.pendingRetain=null;
      this.ordinaryShapePipelines.clear();
      this.fieldComplete=false;this.currentImageValid=false;this.historyValid=false;
    })();
    return this.disposePromise;
  }

  /** Starts a fresh calculation without discarding the displayed history. */
  restartCalculation() {
    this.abort();
    this.publicationEpoch++;
    this.lastPresentedKey='';
    this.currentImageValid=false;
    this.cachedRequest='';this.cachedStats=null;this.fieldKey='';this.sampleKey='';this.admittedSamples=null;
    this.fieldComplete=false;this.fieldDescriptor=null;this.fieldUniforms=null;this.fieldStats=null;
    this.partialAppearanceUniforms=null;this.incomingFrame=null;this.appearanceHoldFrame=null;
    this.pending.reset(0,0);this.partialRegions=0;this.determined=new CoverageRegions();
    this.exactCompletedSamples=0;this.exactTotalSamples=0;this.referencePreparing=false;this.finalizing=false;
    this.aborted=true;
  }

  reproject(request: RenderRequest, allowStaleAppearance=false): boolean {
    if(this.referencePrefetch&&!this.referencePrefetch.claimed&&!this.prefetchCompatible(this.referencePrefetch,request))
      this.cancelPendingReference('Reference forecast changed');
    if(this.disposed||request.exportDomain)return false;
    if(this.deviceLost)return false;
    this.validateCoordinates(request);
    if(!request.workView&&(!request.interacting||(request.zoom??0)===0)) {
      this.numericalAnchor=null;this.numericalView=null;
      this.numericalGuardMs=0;this.outwardBatchDelayMs=0;
    }
    this.currentView = request;
    if(this.capUpgradeBase(request))this.capPresentationTarget=request.maxIterations;
    const heldAppearance=this.appearanceHoldActive(request);
    if(this.appearanceHoldFrame&&!heldAppearance)this.appearanceHoldFrame=null;
    if (this.pendingReferenceDemand?.followView && !this.referenceDemandCompatible(this.pendingReferenceDemand, request)) {
      this.cancelPendingReference("Reference demand changed");
    }
    const current=this.currentImageValid&&this.completedFrame&&this.samePresentation(this.completedFrame,request);
    const last = current ? this.completedFrame : this.historyValid ? this.lastFrame : this.incomingFrame;
    const source = current ? this.target : this.historyValid ? this.history : this.target;
    if (!last || !source || !this.blitPipeline) {
      return false;
    }
    const compatible = (frame: WebGpuRenderer["lastFrame"]) => this.presentationCompatible(frame,request);
    const heldCompatible=(frame:WebGpuRenderer["lastFrame"])=>!!(heldAppearance&&this.appearanceHoldFrame&&this.samePresentation(frame,this.appearanceHoldFrame));
    const stale=allowStaleAppearance&&this.historyValid&&this.stalePresentationCompatible(last,request);
    const incomingAvailable = compatible(this.incomingFrame) && reprojectionFor(this.incomingFrame!, request);
    if (!compatible(last) && !heldCompatible(last) && !stale && !incomingAvailable) return false;

    let mapping = compatible(last)||heldCompatible(last)||stale ? reprojectionFor(last, request) : null;
    if (!mapping) {
      const heldMap=compatible(last)||heldCompatible(last)||stale?
        reprojectionFor(last,request,true,true):null;
      if (!incomingAvailable && !heldMap &&
          (!compatible(this.coverageFrame)||!reprojectionFor(this.coverageFrame!,request,true,true)))return false;
      // Relaxed geometry is presentation-only; the numerical remap and
      // determined-sample coverage continue using their strict contracts.
      mapping=heldMap??{scaleX:0,scaleY:0,offsetX:-1,offsetY:-1};
    }

    const presentationKey=[request.width,request.height,request.centerX.toString(),request.centerY.toString(),
      request.unitsPerPixel.toString(),request.angle??0,request.maxIterations,request.family,
      request.juliaX?.toString(),request.juliaY?.toString(),JSON.stringify(request.colors),
      this.partialSerial,this.publicationEpoch,this.appearanceSubmissions,
      source===this.target?'target':'history',
      last===this.incomingFrame?'incoming':last===this.completedFrame?'completed':last===this.lastFrame?'history':'other',
      allowStaleAppearance,this.canvas.width,this.canvas.height].join('|');
    if(this.lastPresentedKey===presentationKey&&this.lastPresentedFrame===last&&
      this.lastPresentedSource===source&&this.lastPresentedCoverage===this.coverageFrame)return true;
    const encoder = this.ctx.device.createCommandEncoder({ label: "reproject" });
    this.encodeBlit(
      encoder,
      source,
      mapping,
      undefined,
      heldAppearance||stale,
    );
    this.ctx.device.queue.submit([encoder.finish()]);
    this.lastPresentedKey=presentationKey;
    this.lastPresentedFrame=last;this.lastPresentedSource=source;this.lastPresentedCoverage=this.coverageFrame;
    return true;
  }

  invalidateHistory() {
    this.outwardBatchDelayMs=0;this.numericalGuardMs=0;
    this.gpuBatchCost={msPerVisit:0};this.gpuBatchPolicy='';
    this.perturbationActive=false;
    this.screenHold?.destroy();this.screenHold=null;this.screenHoldValid=false;
    this.lastPresentedKey='';
    this.publicationEpoch++; this.historyValid=false; this.refValid=false; this.refSamples=null;
    this.currentImageValid=false;this.completedFrame=null;
    this.incomingFrame=null; this.appearanceHoldFrame=null; this.fieldComplete=false;  this.pending.reset(0,0);
    this.retainEndpoints=false;
    this.coverageFrame=null; this.coverageHistory?.destroy(); this.coverageHistory=null;
    this.retainedAnchor=null; this.fieldView=null; this.sampleKey="";this.admittedSamples=null; this.fieldKey=""; this.cachedRequest="";
    this.capPresentationTarget=null;
    this.fieldStats=null;this.fieldDescriptor=null;this.fieldUniforms=null;this.partialAppearanceUniforms=null;
    this.exactCompletedSamples=0;this.exactTotalSamples=0;this.referencePreparing=false;this.finalizing=false;
    this.abort();
  }
  private sameView(a: DomainView, b: DomainView) {
    return a.width === b.width && a.height === b.height && a.centerX.eq(b.centerX) &&
      a.centerY.eq(b.centerY) && a.unitsPerPixel.eq(b.unitsPerPixel) && (a.angle??0)===(b.angle??0)&&exportIdentity(a)===exportIdentity(b);
  }

  private validateCoordinates(request:RenderRequest){
    assertCoordinatePreparation(request.centerX,'Center X');assertCoordinatePreparation(request.centerY,'Center Y');
    if(request.juliaX)assertCoordinatePreparation(request.juliaX,'Julia X');
    if(request.juliaY)assertCoordinatePreparation(request.juliaY,'Julia Y');
  }

  private fieldIdentity(request:RenderRequest,family:"mandelbrot"|"julia",constant:string,method:Method,grid:number,retainEndpoints:boolean,approximationLevels:number){
    return [family,constant,request.centerX.toString(),request.centerY.toString(),request.unitsPerPixel.toString(),request.angle??0,
      request.width,request.height,request.maxIterations,request.colors.mode,retainEndpoints,grid,method,
      this.refLength,approximationLevels,exportIdentity(request),linearBlaPolicy(request,method)].join("|");
  }

  private sampleIdentity(request:RenderRequest,family:"mandelbrot"|"julia",constant:string,method:Method,grid:number,limbs:number,approximationLevels:number){
    return [family,constant,request.maxIterations,request.colors.mode,grid,method,limbs,this.refLimbs,
      !!approximationLevels,request.useApprox===true,exportIdentity(request),linearBlaPolicy(request,method)].join("|");
  }

  private sameBlaPolicy(a:RenderRequest|AppearanceFrameIdentity,b:RenderRequest|AppearanceFrameIdentity){
    const method=(value:RenderRequest|AppearanceFrameIdentity)=>'method' in value
      ? value.method : methodForScale(value.unitsPerPixel,value.tuning);
    return linearBlaPolicy(a,method(a))===
      linearBlaPolicy(b,method(b));
  }

  private beginAppearanceHold(request:RenderRequest,method:Method,grid:number){
    if(this.appearanceHoldFrame&&this.historyValid&&this.appearanceHoldFrame===this.completedFrame&&
        appearanceUpgradeCompatible(this.appearanceHoldFrame,request,method,grid)&&
        !this.samePresentation(this.appearanceHoldFrame,request))return true;
    const frame=this.completedFrame;
    if(this.historyValid&&this.fieldComplete&&appearanceUpgradeCompatible(frame,request,method,grid)&&
        !this.samePresentation(frame,request)){
      this.appearanceHoldFrame=frame;
      return true;
    }
    if(this.appearanceHoldFrame&&(!appearanceUpgradeCompatible(this.appearanceHoldFrame,request,method,grid)||
        this.samePresentation(this.appearanceHoldFrame,request)))this.appearanceHoldFrame=null;
    return false;
  }

  private appearanceHoldActive(request:RenderRequest){
    const frame=this.appearanceHoldFrame;
    request=this.workRequest(request);
    const method=methodForScale(request.unitsPerPixel,request.tuning);
    const grid=this.affordableGrid(Math.max(1,Math.min(3,request.colors.supersample)),request.width,request.height);
    return this.historyValid&&frame===this.completedFrame&&appearanceUpgradeCompatible(frame,request,method,grid)&&
      !this.samePresentation(frame,request);
  }

  isComplete(request: RenderRequest) {
    if(this.disposed)return false;
    if(this.deviceLost||this.finalizing||this.referencePreparing)return false;
    request=this.workRequest(request);
    const frame=this.completedFrame;
    return this.fieldComplete && this.currentImageValid && !this.finalizing && !!frame && !frame.proxy &&
      this.sameView(frame,request) && frame.family===request.family && frame.maxIterations===request.maxIterations &&
      frame.method===(methodForScale(request.unitsPerPixel,request.tuning)) &&
      frame.useApprox===(request.useApprox===true) &&
      this.sameBlaPolicy(frame,request) &&
      (request.family!=="julia" || !!frame.juliaX?.eq(request.juliaX!) && !!frame.juliaY?.eq(request.juliaY!)) &&
      JSON.stringify(frame.colors)===JSON.stringify(request.colors);
  }
  private samePresentation(frame: WebGpuRenderer["lastFrame"], request: RenderRequest | NonNullable<WebGpuRenderer["lastFrame"]>): frame is NonNullable<WebGpuRenderer["lastFrame"]> {
    // Retained imagery survives automatic route changes. Compare configured
    // tolerance even for Direct-labelled composites that can contain BLA pixels;
    // numerical reuse/completion keep their method-dependent policy checks.
    return !!frame && exportIdentity(frame)===exportIdentity(request) && frame.family === request.family && frame.maxIterations === request.maxIterations &&
      frame.useApprox === (request.useApprox === true) &&
      linearBlaPolicy(frame,Method.Hdr)===linearBlaPolicy(request,Method.Hdr) &&
      (request.family !== "julia" || !!frame.juliaX?.eq(request.juliaX!) && !!frame.juliaY?.eq(request.juliaY!)) &&
      JSON.stringify(frame.colors) === JSON.stringify(request.colors);
  }
  /** Only an otherwise-identical, completed ordinary field can be refined in place. */
  private capUpgradeBase(request:RenderRequest): NonNullable<WebGpuRenderer["lastFrame"]>|null {
    const frame=this.completedFrame,descriptor=this.fieldDescriptor;
    // Most presentation calls cannot upgrade a completed field. Reject them
    // before planning numerical geometry or inspecting the precision method.
    if(!request.followView||!frame||!descriptor||!this.fieldComplete||this.aborted||
      !this.currentImageValid||!this.fieldBuffer||!this.fieldView||!this.fieldKey||
      request.maxIterations<=frame.maxIterations)return null;
    const work=this.workRequest(request),family=request.family??'mandelbrot';
    const method=methodForScale(request.unitsPerPixel,request.tuning);
    const constant=family==='julia'?`${request.juliaX},${request.juliaY}`:'';
    if(!this.sameView(frame,work)||!this.sameView(this.fieldView,work)||
      descriptor.maxIterations!==frame.maxIterations||descriptor.family!==family||descriptor.constant!==constant||
      descriptor.mode!==0||descriptor.grid!==1||descriptor.method!==method||descriptor.retainEndpoints||this.retainEndpoints||
      descriptor.useApprox!==(request.useApprox===true)||frame.method!==method||frame.useApprox!==(request.useApprox===true)||
      request.colors.mode!==0||request.colors.supersample!==1||
      (request.colors.capped??0)!==0||needsEndpoints(request.colors)||
      !this.samePresentation({...frame,maxIterations:request.maxIterations},work))return null;
    return frame;
  }
  /** Scan actual numerical samples once instead of scheduling empty regions.
   * Only a current whole-field result can remove the new cap's obligations. */
  private async validateCapField(request:RenderRequest):Promise<CapCertificate> {
    const device=this.ctx.device,field=this.fieldBuffer!,epoch=this.publicationEpoch;
    const bytes=Math.ceil(request.width/8)*Math.ceil(request.height/8)*4;
    const current=()=>epoch===this.publicationEpoch&&field===this.fieldBuffer&&
      !this.abortRequested&&request.isCurrent!()&&!this.deviceLost;
    await this.oncePipeline('cap-validation',()=>!!this.capValidationPipeline,async()=>{
      const module=await compileShader(device,capValidationSource,'cap-validation');
      this.capValidationPipeline=await device.createComputePipelineAsync({label:'cap-validation',layout:'auto',
        compute:{module,entryPoint:'validateCap'}});
    });
    if(!current())throw new DOMException('Superseded cap validation','AbortError');
    let uniform:GPUBuffer|undefined,flag:GPUBuffer|undefined;
    try{
      const data=await checkedGpu(device,()=>{
        uniform=device.createBuffer({label:'cap-validation-geometry',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        flag=device.createBuffer({label:'cap-validation-result',size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
        device.queue.writeBuffer(uniform,0,new Uint32Array([request.width,request.height,request.maxIterations,0]));
        const encoder=device.createCommandEncoder({label:'validate-reused-cap'}),pass=encoder.beginComputePass();
        pass.setPipeline(this.capValidationPipeline!);
        pass.setBindGroup(0,device.createBindGroup({layout:this.capValidationPipeline!.getBindGroupLayout(0),entries:[
          {binding:0,resource:{buffer:field}}, {binding:1,resource:{buffer:uniform}}, {binding:2,resource:{buffer:flag}},
        ]}));
        pass.dispatchWorkgroups(Math.ceil(request.width/8),Math.ceil(request.height/8));pass.end();
        device.queue.submit([encoder.finish()]);
        return readBuffer(device,flag,bytes);
      });
      if(!current())throw new DOMException('Superseded cap validation','AbortError');
      const unresolved=new Uint32Array(data);
      if(unresolved.byteLength!==bytes)throw Error('Invalid cap validation tile count');
      return {width:request.width,height:request.height,unresolved};
    }finally{uniform?.destroy();flag?.destroy();}
  }
  /** Prior-cap imagery remains display-only while the new cap catches up. */
  private presentationCompatible(frame:WebGpuRenderer["lastFrame"],request:RenderRequest):frame is NonNullable<WebGpuRenderer["lastFrame"]>{
    if(!frame)return false;
    if(Boolean(this.samePresentation(frame,request)))return true;
    // Retained textures may be cropped or bounded at a different resolution.
    // Their reprojection is checked by the presentation caller; their old cap
    // remains intact and cannot certify numerical coverage or completion.
    if(request.followView&&!request.interacting&&frame.maxIterations!==request.maxIterations&&
      this.samePresentation({...frame,maxIterations:request.maxIterations},request))return true;
    if(!request.dynamicIterations)return false;
    const held=this.completedFrame;
    const base=this.capUpgradeBase(request)??
      (request.dynamicIterations&&held&&this.capPresentationTarget===request.maxIterations&&
        request.maxIterations>held.maxIterations&&
        this.samePresentation({...held,maxIterations:request.maxIterations},request)?held:null);
    return !!(request.dynamicIterations&&request.followView&&request.provisionalNavigationCap&&frame&&
      frame.maxIterations!==request.maxIterations&&
      this.samePresentation({...frame,maxIterations:request.maxIterations},request)) ||
      !!(base&&frame&&frame.maxIterations===base.maxIterations&&
      this.samePresentation({...frame,maxIterations:request.maxIterations},request));
  }
  private stalePresentationCompatible(frame: WebGpuRenderer["lastFrame"], request: RenderRequest | NonNullable<WebGpuRenderer["lastFrame"]>){
    return !!frame&&exportIdentity(frame)===exportIdentity(request)&&frame.family===request.family&&frame.maxIterations===request.maxIterations&&
      frame.useApprox===(request.useApprox===true)&&
      linearBlaPolicy(frame,Method.Hdr)===linearBlaPolicy(request,Method.Hdr)&&
      (request.family!=='julia'||!!frame.juliaX?.eq(request.juliaX!)&&!!frame.juliaY?.eq(request.juliaY!));
  }

  private copyColors(colors: ColorSettings): ColorSettings {
    return { ...colors, stops: [...colors.stops], positions: colors.positions ? [...colors.positions] : undefined };
  }

  /** Mutates one host-side uniform snapshot and returns its matching stop data. */
  private fillAppearance(uniforms: ArrayBuffer, colors: ColorSettings, retainEndpoints: boolean) {
    const f32=new Float32Array(uniforms),u32=new Uint32Array(uniforms);
    const stopData=new Float32Array(MAX_STOPS*4);
    colors.stops.slice(0,MAX_STOPS).forEach((stop,i)=>{
      stopData.set(hexToRgb(stop),i*4);stopData[i*4+3]=stopPositions(colors)[i];
    });
    u32[84]=colors.formula??0;u32[85]=colors.effect??0;u32[86]=colors.capped??0;u32[87]=colors.repeating===false?0:1;u32[88]=retainEndpoints?1:0;f32[89]=colors.hueRotation/360;
    u32[9]=colors.palette;f32[10]=Math.max(1,colors.cycle);f32[11]=colors.offset;u32[12]=colors.mapping;u32[13]=colors.mirror?1:0;u32[14]=colors.smooth?1:0;
    const interior=hexToRgb(colors.interior);f32[16]=interior[0];f32[17]=interior[1];f32[18]=interior[2];u32[19]=Math.max(1,Math.min(MAX_STOPS,colors.stops.length));
    u32[22]=colors.mode;f32[23]=colors.colorDensity;f32[24]=colors.colorPhase;f32[25]=colors.slopeDepth;
    const azimuth=colors.lightAngle*Math.PI/180,elevation=colors.lightElevation*Math.PI/180;
    f32[28]=Math.cos(azimuth)*Math.cos(elevation);f32[29]=Math.sin(azimuth)*Math.cos(elevation);f32[30]=Math.sin(elevation);
    f32[31]=colors.ambientLight;f32[32]=colors.diffuseStrength;f32[33]=colors.specularStrength;u32[34]=colors.slopeLighting?1:0;f32[36]=1/Math.max(1,colors.gamma);
    f32.set(hexToRgb(colors.highlightColour),104);
    return stopData;
  }

  private createRenderBind() {
    return this.ctx.device.createBindGroup({
      layout:this.bindLayout!,entries:[
        {binding:1,resource:{buffer:this.uniformBuffer}},{binding:2,resource:this.target!.createView()},
        {binding:3,resource:{buffer:this.stopsBuffer}},
        {binding:4,resource:{buffer:this.laBuffer!}},{binding:5,resource:{buffer:this.laIndexBuffer!}},
        {binding:6,resource:{buffer:this.statsBuffer}},{binding:7,resource:{buffer:this.fieldBuffer!}},
        {binding:8,resource:{buffer:this.endpointBuffer!}},{binding:9,resource:{buffer:this.orbitBuffer!}},
      ],
    });
  }

  private encodeShadePass(encoder:GPUCommandEncoder,bind:GPUBindGroup,width:number,height:number){
    const pass=encoder.beginComputePass({label:"shade-region"});
    pass.setPipeline(this.shadePipeline!);pass.setBindGroup(0,bind);
    pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();
  }

  private appearanceCompatible(base:RenderRequest,latest:RenderRequest,method:Method,grid:number,retainEndpoints:boolean){
    const family=base.family??"mandelbrot",latestFamily=latest.family??"mandelbrot";
    return this.sameView(base,latest)&&family===latestFamily&&base.maxIterations===latest.maxIterations&&
      this.sameBlaPolicy(base,latest)&&
      (base.useApprox===true)===(latest.useApprox===true)&&
      (family!=="julia"||!!base.juliaX?.eq(latest.juliaX!)&&!!base.juliaY?.eq(latest.juliaY!))&&
      base.colors.mode===latest.colors.mode&&grid===this.affordableGrid(Math.max(1,Math.min(3,latest.colors.supersample)),latest.width,latest.height)&&
      method===(methodForScale(latest.unitsPerPixel,latest.tuning))&&(!needsEndpoints(latest.colors)||retainEndpoints)&&
      !((base.colors.capped??0)===0&&(latest.colors.capped??0)>0&&base.colors.mode===0);
  }

  private fieldSupportsAppearance(request:RenderRequest,method:Method,grid:number){
    const descriptor=this.fieldDescriptor,view=this.fieldView,family=request.family??"mandelbrot";
    const constant=family==="julia"?`${request.juliaX},${request.juliaY}`:"";
    return !!(this.fieldComplete&&this.fieldUniforms&&this.fieldStats&&descriptor&&view&&this.target&&this.fieldBuffer&&this.endpointBuffer&&
      this.sameView(view,request)&&descriptor.family===family&&descriptor.constant===constant&&descriptor.maxIterations===request.maxIterations&&
      descriptor.mode===request.colors.mode&&descriptor.grid===grid&&descriptor.method===method&&
      descriptor.useApprox===(request.useApprox===true)&&
      descriptor.linearBlaEpsilon===linearBlaPolicy(request,method)&&
      (!needsEndpoints(request.colors)||descriptor.retainEndpoints)&&
      ((request.colors.capped??0)===0||descriptor.interiorEndpoints));
  }

  /** Converts a complete distance field back to iteration scalars in place. */
  private async convertDistanceToIteration(request:RenderRequest,method:Method,grid:number){
    const descriptor=this.fieldDescriptor,view=this.fieldView,family=request.family??"mandelbrot";
    const constant=family==="julia"?`${request.juliaX},${request.juliaY}`:"";
    if(!this.fieldComplete||!this.fieldUniforms||!this.fieldStats||!descriptor||!view||!this.target||
        !this.fieldBuffer||!this.endpointBuffer||request.colors.mode!==0||
        descriptor.mode!==1||!descriptor.retainEndpoints||!this.retainEndpoints||!this.sameView(view,request)||
        descriptor.family!==family||descriptor.constant!==constant||descriptor.maxIterations!==request.maxIterations||
        descriptor.grid!==grid||descriptor.method!==method||descriptor.useApprox!==(request.useApprox===true)||
        descriptor.linearBlaEpsilon!==linearBlaPolicy(request,method))return false;
    await this.ensureComputePipeline('distance');
    if(this.deviceLost||request.isCurrent&&!request.isCurrent())return false;
    const uniforms=this.fieldUniforms.slice(0),u32=new Uint32Array(uniforms);
    u32[22]=0;u32[26]=request.height;u32[35]=grid;u32[40]=0;u32[42]=0;u32[43]=request.width;u32[54]=1;u32[55]=1;
    const bind=this.createRenderBind(),device=this.ctx.device;
    await checkedGpu(device,()=>{
      device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
      const encoder=device.createCommandEncoder({label:"distance-to-iteration-field"});
      const pass=encoder.beginComputePass({label:"distance-to-iteration-field"});
      pass.setPipeline(this.distanceToIterationPipeline!);pass.setBindGroup(0,bind);
      pass.dispatchWorkgroups(Math.ceil(request.width/8),Math.ceil(request.height/8));pass.end();
      device.queue.submit([encoder.finish()]);
    });
    const limbs=limbsForScale(request.unitsPerPixel,family==="julia"||method!==Method.Direct?96:48);
    const approximationLevels=u32[20];
    this.fieldUniforms=uniforms;
    this.fieldDescriptor={...descriptor,mode:0};
    this.fieldKey=this.fieldIdentity(request,family,constant,method,grid,true,approximationLevels);
    this.sampleKey=this.sampleIdentity(request,family,constant,method,grid,limbs,approximationLevels);
    this.aborted=false;
    return true;
  }

  /** Fast completed-field recolour: no orbit/table/resource setup or stats readback. */
  private async recolorCompleted(request:RenderRequest,requestKey:string,method:Method,grid:number):Promise<RenderStats|null>{
    if(!this.fieldSupportsAppearance(request,method,grid))return null;
    const {device}=this.ctx,started=performance.now();
    const colors=this.copyColors(request.colors),uniforms=this.fieldUniforms!.slice(0),u32=new Uint32Array(uniforms);
    u32[26]=request.height;u32[35]=grid;u32[40]=0;u32[41]=0;u32[42]=0;u32[43]=request.width;u32[54]=1;u32[55]=1;
    const stops=this.fillAppearance(uniforms,colors,this.fieldDescriptor!.retainEndpoints),bind=this.createRenderBind();
    const frame={...request,colors,method,grid,useApprox:request.useApprox===true};
    const retained=this.snapshotFrame(frame);
    let candidate:GPUTexture|undefined;
    this.finalizing=true;
    try{
      if(this.deviceLost||request.isCurrent&&!request.isCurrent())return null;
      await checkedGpu(device,()=>{
        candidate=this.candidateTexture(retained.width,retained.height);
        device.queue.writeBuffer(this.stopsBuffer,0,stops);device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
        const encoder=device.createCommandEncoder({label:"recolour-complete"});
        this.currentImageValid=false;
        this.encodeShadePass(encoder,bind,request.width,request.height);
        this.encodeCompletedSnapshot(encoder,frame,retained,candidate!);
        device.queue.submit([encoder.finish()]);
      });
      this.appearanceSubmissions++;
      const current=(!request.isCurrent||request.isCurrent())&&(!request.followView||!this.currentView||this.sameView(frame,this.workRequest(this.currentView))&&this.samePresentation(frame,this.currentView));
      if(!current||this.deviceLost){return {...this.fieldStats!,completed:false,computed:false,computedSamples:0,reusedSamples:0,renderMs:performance.now()-started};}
      this.commitHistory(retained,candidate!);candidate=undefined;this.lastFrame=retained;this.completedFrame=frame;this.currentImageValid=true;this.historyValid=true;this.incomingFrame=null;this.appearanceHoldFrame=null;
      this.capPresentationTarget=null;
      this.fieldUniforms=uniforms;
      const result={...this.fieldStats!,completed:true,computed:false,computedSamples:0,reusedSamples:request.width*request.height,
        orbitMs:0,pipelineWaitMs:0,tableMs:0,renderMs:performance.now()-started,skippedIterations:0,plainIterations:0,approxSteps:0,rebases:0,skipRatio:0};
      this.cachedStats=result;this.cachedRequest=requestKey;return result;
    }finally{candidate?.destroy();this.finalizing=false;}
  }

  /** Recolours only channels already present after an explicit Stop. Never starts orbit or region work. */
  recolorRetained(request:RenderRequest):Promise<boolean>{
    return this.trackOperation(() => this.recolorRetainedRequest(request));
  }
  private async recolorRetainedRequest(request:RenderRequest):Promise<boolean>{
    if(this.deviceLost)return false;
    const visible=request;
    if(request.stationaryOversampling)request=this.workRequest(request);
    const retained=this.incomingFrame??this.fieldView;
    if(retained&&retained.width>=request.width&&retained.height>=request.height&&
      retained.centerX.eq(request.centerX)&&retained.centerY.eq(request.centerY)&&
      retained.unitsPerPixel.eq(request.unitsPerPixel)&&(retained.angle??0)===(request.angle??0)){
      request={...request,width:retained.width,height:retained.height,workView:true};
    }
    const method=methodForScale(request.unitsPerPixel,request.tuning);
    const grid=this.affordableGrid(Math.max(1,Math.min(3,request.colors.supersample)),request.width,request.height);
    if(!this.fieldSupportsAppearance(request,method,grid))await this.convertDistanceToIteration(request,method,grid);
    if(this.fieldSupportsAppearance(request,method,grid)){
      const result=await this.recolorCompleted(request,'',method,grid);
      return !!result?.completed;
    }
    const frame=this.incomingFrame,base=this.partialAppearanceUniforms;
    if(!frame||!base||!this.target||!this.fieldBuffer||!this.sameView(frame,request)||
      frame.family!==request.family||frame.maxIterations!==request.maxIterations||
      frame.useApprox!==(request.useApprox===true)||frame.method!==method||frame.grid!==grid||
      !this.sameBlaPolicy(frame,request)||
      (request.family==='julia'&&(!frame.juliaX?.eq(request.juliaX!)||!frame.juliaY?.eq(request.juliaY!)))||
      frame.colors.mode!==request.colors.mode||(needsEndpoints(request.colors)&&!this.retainEndpoints)||
      ((frame.colors.capped??0)===0&&(request.colors.capped??0)>0&&frame.colors.mode===0))return false;
    const {device}=this.ctx,epoch=this.publicationEpoch,colors=this.copyColors(request.colors);
    const uniforms=base.slice(0),u32=new Uint32Array(uniforms);
    u32[26]=request.height;u32[40]=0;u32[42]=0;u32[43]=request.width;u32[54]=1;
    const stops=this.fillAppearance(uniforms,colors,this.retainEndpoints),bind=this.createRenderBind();
    await checkedGpu(device,()=>{
      device.queue.writeBuffer(this.stopsBuffer,0,stops);device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
      const encoder=device.createCommandEncoder({label:'recolour-stopped-partial'});
      this.encodeShadePass(encoder,bind,request.width,request.height);
      device.queue.submit([encoder.finish()]);
    });
    this.appearanceSubmissions++;
    if(epoch!==this.publicationEpoch||request.isCurrent&&!request.isCurrent())return false;
    this.partialAppearanceUniforms=uniforms;this.incomingFrame={...frame,colors};

    this.reproject(visible,true);
    return true;
  }

  /** Match and copy synchronously: subsequent navigation cannot alter an export snapshot. */
  captureMatchingQuality(request:RenderRequest,width:number,height:number):Promise<{width:number;height:number;pixels:Uint8ClampedArray}>|null {
    if(!request.colors.oversampling||request.exportDomain||this.disposed)return null;
    const quality={...request,stationaryOversampling:true,workView:false};
    if(!this.isComplete(quality)||!this.completedFrame?.stationaryOversampling||!this.target)return null;
    const fullWidth=request.width*2,fullHeight=request.height*2;
    const reduce=width===request.width&&height===request.height;
    if(!reduce&&(width!==fullWidth||height!==fullHeight))return null;
    const {device}=this.ctx;
    const snapshot=device.createTexture({label:'quality-export-snapshot',size:{width:fullWidth,height:fullHeight},format:'rgba8unorm',
      usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING});
    const copy=device.createCommandEncoder({label:'snapshot-complete-quality'});
    copy.copyTextureToTexture({texture:this.target},{texture:snapshot},{width:fullWidth,height:fullHeight});
    device.queue.submit([copy.finish()]);
    return this.trackOperation(async()=>{
      let resolved:GPUTexture|undefined,staging:GPUBuffer|undefined,mapped=false;
      try{
        let source=snapshot;
        if(reduce){
          const module=await compileShader(device,qualityResolveSource+`
struct Output { @builtin(position) position:vec4<f32>, @location(0) uv:vec2<f32> };
@vertex fn vertexMain(@builtin(vertex_index) i:u32)->Output {
  let points=array<vec2<f32>,4>(vec2<f32>(-1,-1),vec2<f32>(1,-1),vec2<f32>(-1,1),vec2<f32>(1,1));
  var o:Output;o.position=vec4<f32>(points[i],0,1);o.uv=vec2<f32>((points[i].x+1)*0.5,(1-points[i].y)*0.5);return o;
}
@group(0) @binding(0) var source:texture_2d<f32>;
@fragment fn fragmentMain(i:Output)->@location(0) vec4<f32>{return qualityResolve(source,i.uv,${request.colors.gamma.toFixed(8)});}
`,'quality-export-resolve');
          const pipeline=await device.createRenderPipelineAsync({label:'quality-export-resolve',layout:'auto',
            vertex:{module,entryPoint:'vertexMain'},fragment:{module,entryPoint:'fragmentMain',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-strip'}});
          resolved=device.createTexture({label:'quality-export-output',size:{width,height},format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
          const encoder=device.createCommandEncoder({label:'resolve-quality-export'});
          const pass=encoder.beginRenderPass({colorAttachments:[{view:resolved.createView(),loadOp:'clear',storeOp:'store'}]});
          pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:snapshot.createView()}]}));pass.draw(4);pass.end();
          device.queue.submit([encoder.finish()]);source=resolved;
        }
        const bytesPerRow=Math.ceil(width*4/256)*256;
        staging=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const encoder=device.createCommandEncoder({label:'quality-export-readback'});
        encoder.copyTextureToBuffer({texture:source},{buffer:staging,bytesPerRow,rowsPerImage:height},{width,height});device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);mapped=true;
        const raw=new Uint8Array(staging.getMappedRange()),pixels=new Uint8ClampedArray(width*height*4);
        for(let y=0;y<height;y++)pixels.set(raw.subarray(y*bytesPerRow,y*bytesPerRow+width*4),y*width*4);
        for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
        return {width,height,pixels};
      }finally{if(mapped)staging!.unmap();staging?.destroy();resolved?.destroy();snapshot.destroy();}
    });
  }

  /** Read one displayed pixel, including reprojection and partial refinement. */
  captureDisplayedColour(x:number,y:number):Promise<string>{
    return this.trackOperation(async()=>{
      const texture=this.screenHold,{width,height}=this.screenHoldSize;
      if(!texture||!this.screenHoldValid||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=width||y>=height)throw new Error('Image is not ready');
      const {device}=this.ctx;
      const staging=device.createBuffer({label:'colour-picker-readback',size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      let mapped=false;
      try{
        const encoder=device.createCommandEncoder({label:'colour-picker-readback'});
        encoder.copyTextureToBuffer({texture,origin:{x,y}},{buffer:staging},{width:1,height:1});
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);mapped=true;
        const pixel=new Uint8Array(staging.getMappedRange());
        const rgb=this.format.startsWith('bgra')?[pixel[2],pixel[1],pixel[0]]:[pixel[0],pixel[1],pixel[2]];
        return '#'+rgb.map(value=>value.toString(16).padStart(2,'0')).join('');
      }finally{if(mapped)staging.unmap();staging.destroy();}
    });
  }

  /** Small displayed-pixel neighbourhood for the image picker, centred even at canvas edges. */
  captureDisplayedColourPatch(x:number,y:number):Promise<{width:number;height:number;pixels:Uint8ClampedArray}>{
    return this.trackOperation(async()=>{
      const texture=this.screenHold,{width,height}=this.screenHoldSize;
      if(!texture||!this.screenHoldValid||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=width||y>=height)throw new Error('Image is not ready');
      const size=15,radius=7,left=Math.max(0,x-radius),top=Math.max(0,y-radius);
      const copiedWidth=Math.min(width,x+radius+1)-left,copiedHeight=Math.min(height,y+radius+1)-top,bytesPerRow=256;
      const {device}=this.ctx;
      const staging=device.createBuffer({label:'colour-picker-loupe',size:bytesPerRow*copiedHeight,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      let mapped=false;
      try{
        const encoder=device.createCommandEncoder({label:'colour-picker-loupe'});
        encoder.copyTextureToBuffer({texture,origin:{x:left,y:top}},{buffer:staging,bytesPerRow},{width:copiedWidth,height:copiedHeight});
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);mapped=true;
        const raw=new Uint8Array(staging.getMappedRange()),pixels=new Uint8ClampedArray(size*size*4),bgra=this.format.startsWith('bgra');
        for(let py=0;py<size;py++)for(let px=0;px<size;px++){
          const sx=Math.max(0,Math.min(width-1,x+px-radius))-left,sy=Math.max(0,Math.min(height-1,y+py-radius))-top;
          const source=sy*bytesPerRow+sx*4,destination=(py*size+px)*4;
          pixels[destination]=raw[source+(bgra?2:0)];pixels[destination+1]=raw[source+1];
          pixels[destination+2]=raw[source+(bgra?0:2)];pixels[destination+3]=255;
        }
        return {width:size,height:size,pixels};
      }finally{if(mapped)staging.unmap();staging.destroy();}
    });
  }

  /** Captures only the completed, current 8-bit presentation image. */
  capturePixels(request:RenderRequest):Promise<{width:number;height:number;pixels:Uint8ClampedArray}> {
    return this.trackOperation(() => this.readCompletedPixels(request));
  }

  private async readCompletedPixels(request:RenderRequest):Promise<{width:number;height:number;pixels:Uint8ClampedArray}> {
    if(!this.isComplete(request))throw new Error('The current image is not ready to save yet.');
    const texture=this.target;
    if(!texture)throw new Error('The completed image is unavailable.');
    const {device}=this.ctx,{width,height}=request;
    const work=this.workRequest(request);
    const origin={x:(work.width-width)/2,y:(work.height-height)/2};
    const bytesPerRow=Math.ceil(width*4/256)*256;
    const staging=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    let mapped=false;
    try{
      const encoder=device.createCommandEncoder({label:'png-readback'});
      encoder.copyTextureToBuffer({texture,origin},{buffer:staging,bytesPerRow,rowsPerImage:height},{width,height});
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
    // Rotated rectangles must not invent covered corners. The affine image can
    // still be displayed; omit these scheduling hints across orientations.
    if((frame.angle??0)!==(view.angle??0))return [];
    const m=reprojectionFor(frame,view,!!frame.snapshotComplete||!frame.proxy);
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

  private hasFinerRetainedCoverage(frame: WebGpuRenderer["lastFrame"], replacement: FrameView, view: FrameView) {
    return !!frame && frame.unitsPerPixel.lt(replacement.unitsPerPixel) &&
      this.coverageIn(frame,view).some(region=>region.spacing.lt(replacement.unitsPerPixel));
  }

  async retainDisplayedPartial(request:RenderRequest,keepIncoming=false):Promise<boolean>{
    if(this.disposed)return false;
    const live=this.currentView;
    this.currentView=request;
    try{const scheduled=this.retainPartial(true,keepIncoming);return this.pendingRetain??scheduled;}finally{this.currentView=live;}
  }

  private retainPartial(allowStaleAppearance=false,keepIncoming=false) {
    if(this.disposed)return false;
    const frame = this.incomingFrame;
    if (!frame || !this.target || !this.partialRegions) return false;
    // Coalesce while device validation is pending; never build a snapshot queue.
    if (this.pendingRetain) return false;
    if (this.currentView && !this.presentationCompatible(frame,this.currentView)) {
      this.incomingFrame=null;this.partialRegions=0;this.determined=new CoverageRegions();
      this.determinedRegion=null;
      return false;
    }
    const { device } = this.ctx;
    const rotated=!!frame.angle;
    if(!rotated)this.retainedAnchor ??= createSampleGridAnchor(this.lastFrame?.angle?frame:this.lastFrame ?? frame);
    const live=this.currentView;
    // During inward zoom, retain the composite on the exact visible grid.
    // Regridding it onto the incoming source can shift density boundaries and
    // replace published detail; lattice padding can also halve its resolution.
    // Keep only geometry from the live view, preserving the captured identity.
    const inward=!!(live?.interacting&&(live.zoom??0)>0&&!rotated&&!live.angle);
    let geometry=inward?boundedRetainedView({centerX:live!.centerX,centerY:live!.centerY,
      unitsPerPixel:live!.unitsPerPixel,width:live!.width,height:live!.height},device.limits.maxTextureDimension2D):
      rotated?boundedRetainedView(frame,device.limits.maxTextureDimension2D):
        planRetainedView(frame,this.retainedAnchor!,{overscan:1,deviceLimit:device.limits.maxTextureDimension2D});
    // Releasing input must not downsample detail already published from this
    // target. Keep the existing stable lattice unless its padding would force
    // a coarser snapshot and a lossless visible crop fits the same history cap.
    if(!inward&&!rotated&&!live?.angle&&(live?.zoom??0)>=0&&geometry.unitsPerPixel.gt(frame.unitsPerPixel))
      geometry=sourceAlignedRetainedView(frame,live??frame,device.limits.maxTextureDimension2D)??geometry;
    const retained={...frame,...geometry};
    const candidates=[...this.coverageIn({...frame,proxy:true,coveredRegions:this.determined.rectangles.map(r=>({...r,spacing:frame.unitsPerPixel.times(r.spacing??1)}))},retained),...[this.historyValid?this.lastFrame:null,this.coverageFrame].flatMap(
      old=>this.samePresentation(old,frame) ? this.coverageIn(old!,retained) : [])].filter(r=>r!==null);
    const covered=candidates.sort((a,b)=>b.width*b.height-a.width*a.height)[0];
    const retainedCoverage=new CoverageRegions();
    for(const c of candidates)retainedCoverage.add({...c,spacing:c.spacing.div(retained.unitsPerPixel).toNumber()});
    const epoch=this.publicationEpoch,history=this.history;
    // The snapshot below has the incoming cap's identity. Keep a useful prior
    // cap in its own texture/metadata slot instead of relabelling its pixels.
    const keepPriorCap=!!(this.historyValid&&this.lastFrame&&this.currentView&&
      !this.samePresentation(this.lastFrame,frame)&&this.presentationCompatible(this.lastFrame,this.currentView)&&
      reprojectionFor(this.lastFrame,this.currentView,true,true));
    const keepFiner=!!(this.historyValid&&retained.unitsPerPixel.gt((live??retained).unitsPerPixel)&&
      !retained.angle&&!live?.angle&&containsNumericalView(retained,live??retained)&&
      this.samePresentation(this.lastFrame,frame)&&
      this.hasFinerRetainedCoverage(this.lastFrame,retained,live??retained)&&
      (!this.presentationCompatible(this.coverageFrame,live??retained)||
        !this.hasFinerRetainedCoverage(this.coverageFrame,retained,live??retained)));
    // A bounded composite cannot encode detail finer than its own texel grid.
    // Preserve an already finer backup when the front has no proved finer
    // coverage; promoting a completed but coarser front would erase that detail.
    const keepFinerBack=!!(this.samePresentation(this.coverageFrame,frame)&&
      this.hasFinerRetainedCoverage(this.coverageFrame,retained,live??retained)&&
      !(this.samePresentation(this.lastFrame,frame)&&
        this.hasFinerRetainedCoverage(this.lastFrame,this.coverageFrame!,live??retained)));
    let snapshot:GPUTexture|undefined;
    this.spareHistory?.destroy();this.spareHistory=null;
    const pending=checkedGpu(device,()=>{
      snapshot=device.createTexture({label:'retained-progress',size:[retained.width,retained.height],
        format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});
      const live=this.currentView;
      this.currentView={...retained};
      try{
        const source=this.historyValid?this.history!:this.target!;
        const mapping=this.historyValid&&this.lastFrame?reprojectionFor(this.lastFrame,retained,!!this.lastFrame.snapshotComplete||!this.lastFrame.proxy):null;
        const encoder=device.createCommandEncoder({label:'retain-progress'});
        this.encodeBlit(encoder,source,mapping??{scaleX:0,scaleY:0,offsetX:-1,offsetY:-1},snapshot,
          allowStaleAppearance&&this.stalePresentationCompatible(this.lastFrame,retained));
        device.queue.submit([encoder.finish()]);
      }finally{this.currentView=live;}
    }).then(()=>{
      if(this.deviceLost||epoch!==this.publicationEpoch||this.incomingFrame!==frame||this.history!==history)return false;
      if(this.currentView&&!this.presentationCompatible(frame,this.currentView)&&
        !(allowStaleAppearance&&this.stalePresentationCompatible(frame,this.currentView)))return false;
      if(this.historyValid&&!keepFinerBack&&(this.lastFrame?.snapshotComplete||keepPriorCap||keepFiner)){
        this.coverageHistory?.destroy();this.coverageHistory=this.history;this.coverageFrame=this.lastFrame;
      }else this.history?.destroy();
      this.history=snapshot!;snapshot=undefined;
      // encodeBlit already resolved any quality source in this composite.
      this.lastFrame={...retained,stationaryOversampling:false,proxy:true,covered,coveredSpacing:covered?.spacing,
        coveredRegions:retainedCoverage.rectangles.map(r=>({...r,spacing:retained.unitsPerPixel.times(r.spacing??1)}))};this.historyValid=true;
      if(!keepIncoming)this.incomingFrame=null;
      return true;
    }).catch(()=>false).finally(()=>{snapshot?.destroy();if(this.pendingRetain===pending)this.pendingRetain=null;});
    this.pendingRetain=pending;
    return true;
  }

  private isInteracting(request: RenderRequest): boolean {
    return !!(request.followView ? this.currentView ?? request : request).interacting;
  }
  /** Finish the admitted snapshot while inward demand remains inside it.
   * The resulting pixels keep their original grid/reference/table identity;
   * committed-reference reuse still uses its strict quarter-span bound. */
  private inwardPreparationContinues(prepared:RenderRequest,live:RenderRequest):boolean {
    const ordinary=(r:RenderRequest)=>!!r.followView&&!!r.interacting&&!!r.heldInwardZoom&&(r.zoom??0)>0&&
      (r.family??'mandelbrot')==='mandelbrot'&&!r.angle&&!r.exportDomain&&!r.stationaryOversampling&&
      r.publishPartial!==false&&r.colors.mode===0&&r.colors.supersample===1&&
      !needsEndpoints(r.colors)&&(r.colors.capped??0)===0;
    return !!prepared&&ordinary(prepared)&&ordinary(live)&&containsNumericalView(prepared,live);
  }
  private referenceNeedsPreparation(request:RenderRequest,limbs:number):boolean {
    const family=request.family??'mandelbrot';
    const constant=family==='julia'?`${request.juliaX},${request.juliaY}`:'';
    const domain=renderDomain(request);
    const allowance=request.unitsPerPixel.times(Math.min(domain.width,domain.height)/2).times(.5);
    const drift=request.centerX.minus(this.refX).abs().plus(request.centerY.minus(this.refY).abs());
    return family!==this.refFamily||constant!==this.refConstant||!this.refValid||limbs!==this.refLimbs||
      (!this.refEscaped&&this.referenceBudget(request.maxIterations,request.dynamicIterations,family)>this.refIterations)||
      drift.greaterThan(allowance);
  }
  private approximationPreparation(request:RenderRequest) {
    const family=request.family??'mandelbrot';
    const requiredDelta=approximationDeltaBound(family,request,this.refX,this.refY);
    const narrowRetry=this.laLevels>0&&!this.laHasUsableMultiStep&&requiredDelta.lt(this.tableMaxDelta.times(1-1e-12));
    const needed=request.useApprox===true&&approximationEligible(family,request.colors.mode)&&
      (this.tableEpsilonLog2!==blaTableEpsilon(request)||
       requiredDelta.gt(this.tableMaxDelta.times(1+1e-12))||narrowRetry);
    return {requiredDelta,needed};
  }
  /** Called once immediately before required preparation, against the old cap.
   * An updated cap may extend the reference budget; callers recheck that need. */
  private preparationRequest(request:RenderRequest,limbs:number):RenderRequest {
    if(!request.followView||request.exportDomain||!request.dynamicIterations||!request.beforePreparation||
       !this.referenceNeedsPreparation(request,limbs)&&!this.approximationPreparation(request).needed)return request;
    if(!request.isCurrent?.())return request;
    this.requireLiveMethod(request);
    const limit=request.beforePreparation();
    if(limit===null||limit===request.maxIterations)return request;
    if(!Number.isInteger(limit)||limit<1||limit>MAX_REFERENCE_ITERATIONS)throw Error('Invalid Dynamic preparation limit.');
    if(this.currentView)this.currentView={...this.currentView,maxIterations:limit,provisionalNavigationCap:true};
    return {...request,maxIterations:limit,provisionalNavigationCap:true};
  }
  /** Camera drift may preserve useful preparation; a different numerical
   * method must not admit another old-mode region after an async boundary. */
  private requireLiveMethod(request:RenderRequest){
    const live=request.followView&&this.currentView?this.workRequest(this.currentView):null;
    if(!live)return;
    // Held zoom releases before the interaction grace expires. Stop submitting
    // the outward preview as soon as the final native grid is requested.
    if(request.interacting&&(request.zoom??0)<0&&(live.zoom??0)===0&&!this.sameView(request,live))
      throw new LiveDemandChanged();
    const method=methodForScale(request.unitsPerPixel,request.tuning);
    const next=methodForScale(live.unitsPerPixel,live.tuning);
    const wide=request.family==='julia'||method!==Method.Direct;
    if(!!request.stationaryOversampling!==!!live.stationaryOversampling||method!==next||request.family!==live.family||request.useApprox!==live.useApprox||
      !this.sameBlaPolicy(request,live)||
      (request.family==='julia'&&(!request.juliaX?.eq(live.juliaX!)||!request.juliaY?.eq(live.juliaY!)))||
      limbsForScale(request.unitsPerPixel,wide?96:48)!==limbsForScale(live.unitsPerPixel,wide?96:48))
      throw new LiveDemandChanged();
  }
  /** An admitted inward snapshot gets useful work before the existing batch
   * retarget follows a finer live grid. Other geometry changes still retry. */
  private requirePreparedInwardView(request:RenderRequest){
    const live=request.followView?this.currentView:null;
    if((request.family??'mandelbrot')==='mandelbrot'&&live?.interacting&&(live.zoom??0)>0&&
        !this.sameView(request,this.workRequest(live))&&!this.inwardPreparationContinues(request,live))throw new LiveDemandChanged();
  }
  /** Plan numerical sampling independently of the visible camera and output. */
  methodForRequest(visible:RenderRequest):Method|null {
    try{const work=this.workRequest(visible,false);return methodForScale(work.unitsPerPixel,work.tuning);}
    catch{return null;}
  }
  private workRequest(visible:RenderRequest,commit=true):RenderRequest {
    if(visible.workView)return visible;
    const stable=visible.followView&&visible.interacting&&(visible.zoom??0)!==0&&
      (visible.family??'mandelbrot')==='mandelbrot'&&!visible.angle&&!visible.exportDomain&&
      !visible.stationaryOversampling&&visible.colors.mode===0&&visible.colors.supersample===1&&
      !needsEndpoints(visible.colors)&&(visible.colors.capped??0)===0;
    if(stable) {
      const anchor=this.numericalAnchor??createSampleGridAnchor(visible);
      if(commit)this.numericalAnchor=anchor;
      const previous=this.numericalView;
      const outwardPreview=(visible.zoom??0)<0;
      const focus=visible.focus??{x:.5,y:.5};
      // Freeze the learned horizon for each retained grid. Timing callbacks
      // must not change its identity during preparation or completion checks.
      const guard=outwardPreview?outwardPadding(visible.width,visible.height,
        visible.zoomRate??0,focus,this.numericalGuardMs):{x:0,y:0};
      const maximumSpacing=visible.unitsPerPixel.times(outwardPreview?2:1);
      const fits=previous&&previous.unitsPerPixel.lte(maximumSpacing)&&
        previous.unitsPerPixel.times(2).gt(maximumSpacing)&&
        containsNumericalView(previous,visible,guard);
      const limits=this.ctx.device.limits;
      const planningLimits={
        maxDimension:limits.maxTextureDimension2D,
        maxSamples:Math.floor(Math.min(limits.maxStorageBufferBindingSize,limits.maxBufferSize)/8),
      };
      const nextHorizon=outwardPreview?outwardHorizonMs(this.outwardBatchDelayMs):0;
      const forecast=outwardPreview?outwardPadding(visible.width,visible.height,
        visible.zoomRate??0,focus,nextHorizon,true):{x:0,y:0};
      // Keep the existing lattice and overscan minimum; add bounded lead room.
      const padding=outwardPreview?{x:Math.max(visible.overscanPixels?.x??0,forecast.x),
        y:Math.max(visible.overscanPixels?.y??0,forecast.y)}:undefined;
      const expanded=padding?{...visible,
        width:visible.width+2*Math.max(0,Math.floor((padding.x??0)/2)*2),
        height:visible.height+2*Math.max(0,Math.floor((padding.y??0)/2)*2)}:visible;
      const expandedPlan=fits?previous:planNumericalView(expanded,anchor,planningLimits,outwardPreview);
      const planned=expandedPlan??(padding?planNumericalView(visible,anchor,planningLimits,outwardPreview):null);
      if(planned) {
        if(commit){
          if(!fits)this.numericalGuardMs=expandedPlan?nextHorizon:0;
          this.numericalView=planned;
        }
        return {...visible,...planned,overscanPixels:undefined,workView:true};
      }
    }
    if(visible.stationaryOversampling&&!visible.exportDomain)return {...oversampledView(visible),colors:{...visible.colors,supersample:1},overscanPixels:undefined,workView:true};
    const requested=visible.followView&&visible.zoom!==undefined&&visible.zoom<0 ? visible.overscanPixels : undefined;
    if(!requested?.x&&!requested?.y)return {...visible,workView:true};
    const limits=this.ctx.device.limits;
    const grid=Math.max(1,Math.min(3,visible.colors.supersample));
    const bytes=(needsEndpoints(visible.colors)||visible.colors.mode===1?16:8)*grid*grid;
    const area=Math.floor(Math.min(limits.maxStorageBufferBindingSize,limits.maxBufferSize)/bytes);
    const maxX=Math.max(0,Math.floor((limits.maxTextureDimension2D-visible.width)/4)*2);
    const maxY=Math.max(0,Math.floor((limits.maxTextureDimension2D-visible.height)/4)*2);
    const desiredX=Math.min(maxX,Math.max(0,Math.floor(requested.x/2)*2));
    const desiredY=Math.min(maxY,Math.max(0,Math.floor(requested.y/2)*2));
    if((visible.width+2*desiredX)*(visible.height+2*desiredY)<=area)
      return {...visible,width:visible.width+2*desiredX,height:visible.height+2*desiredY,workView:true};
    let low=0,high=1;
    for(let n=0;n<20;n++){
      const mid=(low+high)/2;
      const x=Math.floor(desiredX*mid/2)*2,y=Math.floor(desiredY*mid/2)*2;
      if((visible.width+2*x)*(visible.height+2*y)<=area)low=mid;else high=mid;
    }
    const x=Math.floor(desiredX*low/2)*2,y=Math.floor(desiredY*low/2)*2;
    return {...visible,width:visible.width+2*x,height:visible.height+2*y,workView:true};
  }

  private regionCoverage: {request:RenderRequest;last:WebGpuRenderer["lastFrame"];secondary:WebGpuRenderer["coverageFrame"];valid:boolean;capBase:WebGpuRenderer["lastFrame"];covered:Demand['covered']} | null = null;
  private regionDemand(request: RenderRequest): Demand {
    const live = request.followView ? this.currentView ?? request : request;
    const m = reprojectionFor(request,live);
    const focus = live.focus ?? {x:.5,y:.5};
    // Old-cap presentation coverage is not upgraded numerical coverage.
    const capBase=this.capUpgradeBase(request), cached=this.regionCoverage;
    // Retained frames and target geometry are stable across pixel batches.
    // Only pointer/visible demand and newly determined regions change each time.
    if(!cached || cached.request!==request || cached.last!==this.lastFrame ||
        cached.secondary!==this.coverageFrame || cached.valid!==this.historyValid || cached.capBase!==capBase) {
      const covered=(capBase?[]:[this.historyValid?this.lastFrame:null,this.coverageFrame]).flatMap(frame=>{
        if(!this.samePresentation(frame,request))return [];
        return this.coverageIn(frame,request).map(r=>({...r,spacing:r.spacing.div(request.unitsPerPixel).toNumber()}));
      });
      this.regionCoverage={request,last:this.lastFrame,secondary:this.coverageFrame,valid:this.historyValid,capBase,covered};
    }
    const covered=this.regionCoverage!.covered.slice();
    covered.push(...this.determined.rectangles.map(r=>({...r,spacing:r.spacing??1})));
    const hints=new CoverageRegions();for(const c of covered)hints.add(c);
    const mapped=m?mapUv(m,focus.x,focus.y):focus;
    const corners=m&&request.workView
      ? [[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>mapUv(m,x,y)) : [];
    const xs=corners.map(p=>p.x*request.width),ys=corners.map(p=>p.y*request.height);
    const visible=corners.length?{x:Math.min(...xs),y:Math.min(...ys),
      width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}:undefined;
    const heldInwardZoom=!!(live.heldInwardZoom&&live.interacting&&(live.zoom??0)>0&&
      this.perturbationActive&&methodForScale(request.unitsPerPixel,request.tuning)!==Method.Direct&&
      (request.family??'mandelbrot')==='mandelbrot'&&!request.angle&&!live.angle&&request.colors.mode===0&&
      request.colors.supersample===1&&!needsEndpoints(request.colors)&&(request.colors.capped??0)===0);
    return {x:mapped.x*request.width,y:mapped.y*request.height,zoom:live.zoom??0,covered:hints.rectangles,visible,heldInwardZoom};
  }

  render(request: RenderRequest): Promise<RenderStats> {
    return this.trackOperation(() => this.renderRequest(request.exportDomain ? {...request, exportDomain:{...request.exportDomain}, publishPartial:false} : request));
  }
  private async renderRequest(request: RenderRequest): Promise<RenderStats> {
    request=this.workRequest(request);
    let result: RenderStats;
    this.endpointDemand=needsEndpoints(request.colors)||request.colors.mode===1;
    try{do {
      this.retarget=false;
      try{result=await this.renderTarget(request);}catch(error){
        this.clearContinuationWork();
        this.referencePreparing=false;this.finalizing=false;this.cachedRequest='';
        if(error instanceof LiveDemandChanged&&this.currentView&&!this.abortRequested&&
            (!request.isCurrent||request.isCurrent())){
          this.retainPartial(false,true);await this.pendingRetain;
          request=this.workRequest({...this.currentView,followView:true,isCurrent:request.isCurrent});
          continue;
        }
        if(!(error instanceof DOMException&&error.name==='AbortError')){this.fieldKey='';this.fieldComplete=false;}
        if(!(error instanceof DOMException&&error.name==='AbortError')){this.incomingFrame=null;this.sampleKey='';this.admittedSamples=null;this.fieldView=null;this.aborted=true;this.exactCompletedSamples=0;}
        throw error;
      }finally{if(this.batchCostKey)this.batchFeedback.enterTarget();}
      // Counter readback also yields. Demand arriving during that last fence
      // must be serviced before reporting the stream complete.
      if (request.followView && result.completed && this.currentView && !this.isComplete(this.currentView)) this.retarget=true;
      if (!this.retarget || this.abortRequested || request.isCurrent && !request.isCurrent()) return result;
      this.retainPartial(false,true);
      await this.pendingRetain;
      request=this.workRequest({...this.currentView!,followView:true,isCurrent:request.isCurrent});
    } while (true);}finally{this.endpointDemand=false;}
  }

  private async renderTarget(request: RenderRequest): Promise<RenderStats> {
    const targetStartingSerial=this.partialSerial;
    this.batchFeedback.enterTarget();

    const { device } = this.ctx;
    const tuning=request.tuning??DEFAULT_TUNING;
    this.validateCoordinates(request);
    validateExportDomain(request);
    await this.pendingRetain;
    if(this.disposed)throw new Error("Renderer has been disposed.");
    try{validateRenderSize(device.limits,request.width,request.height,needsEndpoints(request.colors)||request.colors.mode===1?16:8);}
    catch(error){if(request.stationaryOversampling)throw new Error(`2x oversampling is unsupported at this viewport size: ${error instanceof Error?error.message:String(error)}`);throw error;}
    if(this.deviceLost)throw Error('GPU connection lost. Reload to reconnect.');
    this.referencePreparing=false;this.finalizing=false;
    const epoch = this.publicationEpoch;
    this.abortRequested=false;
    if(!Number.isInteger(request.maxIterations)||request.maxIterations<1||request.maxIterations>10_000_000)throw Error('Unsupported iteration limit (maximum 10000000).');
    const presentationCurrent=request.isCurrent;
    const originalCurrent = request.isCalculationCurrent ?? presentationCurrent;
    request = { ...request, colors: this.copyColors(request.colors),tuning:request.tuning?{...request.tuning}:undefined,
      isCurrent: () => epoch === this.publicationEpoch && (!originalCurrent || originalCurrent()) };

    const keyFor=(value:RenderRequest)=>[value.centerX,value.centerY,value.unitsPerPixel,value.width,value.height,value.angle??0,
      value.family,value.juliaX,value.juliaY,value.maxIterations,
      methodForScale(value.unitsPerPixel,value.tuning),value.useApprox===true,
      JSON.stringify(value.colors),exportIdentity(value),linearBlaPolicy(value,methodForScale(value.unitsPerPixel,value.tuning))].join("|");
    let requestKey=keyFor(request);
    if (requestKey === this.cachedRequest && this.cachedStats && this.isComplete(request) && request.isCurrent!()) {
      this.referencePreparing=false;this.exactTotalSamples=request.width*request.height;this.exactCompletedSamples=this.exactTotalSamples;
      return { ...this.cachedStats, computed: false, computedSamples: 0,
        reusedSamples: request.width * request.height, orbitMs: 0, pipelineWaitMs: 0, tableMs: 0, renderMs: 0,
        skippedIterations:0,plainIterations:0,approxSteps:0,rebases:0,skipRatio:0 };
    }
    if (!this.directPipeline || !this.shadePipeline || !this.reusePipeline || !this.blitPipeline) {
      throw new Error("WebGpuRenderer.init() was not awaited");
    }

    const method = methodForScale(request.unitsPerPixel,request.tuning);
    if(method===Method.Direct)this.perturbationActive=false;
    this.requireLiveMethod(request);
    const initialGrid=this.affordableGrid(Math.max(1,Math.min(3,request.colors.supersample)),request.width,request.height);
    if(request.exportDomain&&initialGrid!==Math.max(1,Math.min(3,request.colors.supersample)))throw new Error("Export tile cannot fit the requested sample grid.");
    let recoloured=await this.recolorCompleted(request,requestKey,method,initialGrid);
    if(recoloured)return recoloured;
    const holdCompletedAppearance=this.beginAppearanceHold(request,method,initialGrid);
    if(await this.convertDistanceToIteration(request,method,initialGrid)){
      recoloured=await this.recolorCompleted(request,requestKey,method,initialGrid);
      if(recoloured)return recoloured;
    }
    this.referencePreparing=true;
    const wide = request.family === "julia" || method !== Method.Direct;
    const limbs = limbsForScale(request.unitsPerPixel, wide ? 96 : 48);
    Decimal.set({ precision: Math.max(Decimal.precision,Math.ceil((32 * (limbs - 1)) / 3.32) + 10) });

    // Reuse the reference orbit while the view stays near the point it was
    // built at. Regenerating costs tens of milliseconds, so doing it every
    // frame would make panning unusable at depth.
    if(method!==Method.Direct){request=this.preparationRequest(request,limbs);requestKey=keyFor(request);}
    const domain=renderDomain(request);
    const family = request.family ?? "mandelbrot";
    const constant = family === "julia" ? `${request.juliaX},${request.juliaY}` : "";
    const stale=this.referenceNeedsPreparation(request,limbs);

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
        this.refX = orbit.referenceX; this.refY = orbit.referenceY;
        this.refLimbs = limbs; this.refIterations = this.referenceBudget(request.maxIterations,request.dynamicIterations,family);
        this.refLength = orbit.length; this.refEscaped = orbit.escaped;
        this.refSamples = orbit.samples; this.refTerminal = orbit.terminal; this.refValid = true;
        this.refFormatVersion=orbit.formatVersion;this.refSampleWords=orbit.sampleWords;
        orbitMs = orbit.ms;
        this.tableMs = 0; this.laLevels=0; this.laHasUsableMultiStep=false; this.tableMaxDelta=new Decimal(-1);
        if (request.useApprox===true && approximationEligible(family, request.colors.mode)) await this.buildApproxTable(request);
      } catch (error) {
        this.referencePreparing=false;
        throw error;
      }
    }
    // Reversal/overscan can need a larger delta domain without a new orbit.
    // Conversely, a table with no usable multi-step entry can become useful
    // when the same orbit is viewed through a narrower domain.
    const {requiredDelta,needed:tableNeedsPreparation}=this.approximationPreparation(request);
    if (method !== Method.Direct && tableNeedsPreparation) {
      await this.buildApproxTable(request);
    }

    this.referencePreparing=false;
    this.startReferencePrefetch(request);
    // Preparation can take longer than a fast outward zoom's viewport lifetime.
    // Re-enter the existing retarget loop before allocating/calculating an old
    // field; the reserved table is reused if the live domain fits it.
    const preparedLive=request.followView?this.currentView:null;
    if((orbitMs>0||this.tableMs>0)&&preparedLive?.interacting&&(preparedLive.zoom??0)<0&&
      !this.sameView(request,this.workRequest(preparedLive)))throw new LiveDemandChanged();
    const started = performance.now();
    if (!request.isCurrent!()) throw new DOMException("Superseded render", "AbortError");
    this.requireLiveMethod(request);
    const approximationLevels =
      request.useApprox !== true || method === Method.Direct || !approximationEligible(family, request.colors.mode) ||
      !this.laHasUsableMultiStep || this.tableEpsilonLog2!==blaTableEpsilon(request) ||
      requiredDelta.gt(this.tableMaxDelta.times(1 + 1e-12)) ? 0 : this.laLevels;
    const pipelineKind=family==='julia'?approximationLevels>0?'juliaApprox':'julia':method===Method.Direct?'direct':approximationLevels>0?'approx':'plain';
    // Table viability now fixes the exact variant. Prepare only that variant
    // while target/field resources are validated, then await residual work.
    const ordinarySpecialized=(pipelineKind==='plain'||pipelineKind==='approx')&&
      request.colors.mode===0&&initialGrid===1&&(request.colors.capped??0)===0&&!needsEndpoints(request.colors);
    let ordinaryShape=tuning.workgroupShape;
    const calculationPreparation=this.ensureComputePipeline(ordinarySpecialized?
      pipelineKind==='approx'?'ordinaryApprox':'ordinaryPlain':pipelineKind,ordinaryShape);
    const initialWorkgroup=deliveryWorkgroup(ordinaryShape);
    let calculateWorkgroupX=ordinarySpecialized?initialWorkgroup.x:8;
    let calculateWorkgroupY=ordinarySpecialized?initialWorkgroup.y:4;
    void calculationPreparation.catch(()=>{});
    // Every buffer in the bind group must exist even when this method does not
    // read it: the direct path builds neither an orbit nor a skip table.
    this.ensureOrbitCapacity(1);
    if (!this.laBuffer || !this.laIndexBuffer) {
      this.laBuffer = storageBuffer(device, ENTRY_FLOATS, "la-table");
      this.laIndexBuffer = storageBuffer(device, 2, "la-index");
    }
    // The outgoing colour texture remains valid while numerical preparation
    // yields. Do not re-shade it using the next field's appearance uniforms.
    this.partialAppearanceUniforms=null;

    const scale = splitExponent(request.unitsPerPixel);
    const offset = splitComplex(
      request.centerX.minus(this.refX),
      request.centerY.minus(this.refY)
    );

    let colors=this.copyColors(request.colors);

    // The field is two floats per sub-sample, so it grows with the square of
    // the sample grid: 3x3 at 4K would be a gigabyte and the allocation simply
    // fails. Drop sample counts that will not fit rather than die trying.
    const grid=initialGrid;

    let previewStride=1;
    if(request.followView && grid===1) {
      while(Math.ceil(request.width/previewStride)*Math.ceil(request.height/previewStride)>MIN_BATCH_SAMPLES) previewStride*=2;
    }

    // Layout must match the Uniforms struct in perturbation.wgsl. vec3 members
    // align to 16 bytes, which is what the gaps below are for.
    const uniforms = new ArrayBuffer(432);
    const f32 = new Float32Array(uniforms);
    const i32 = new Int32Array(uniforms);
    const u32 = new Uint32Array(uniforms);
    f32[0] = request.width;
    f32[1] = request.height;
    f32[100] = domain.width; f32[101] = domain.height;
    f32[102] = domain.x; f32[103] = domain.y;
    f32[2] = scale.mantissa;
    i32[3] = scale.exponent;
    f32[4] = offset.x;
    f32[5] = offset.y;
    i32[6] = offset.exponent;
    u32[7] = request.maxIterations;
    const wantsEndpoints=needsEndpoints(colors)||colors.mode===1;
    // Appearance-only recolouring returned above if its cached channels were
    // useful. A fresh ordinary calculation must not inherit endpoint demand
    // from an earlier colour mode at this same geometry.
    if(this.retainEndpoints&&!wantsEndpoints){
      this.retainEndpoints=false;this.endpointBuffer?.destroy();this.endpointBuffer=null;this.endpointCapacity=0;
    }
    this.retainEndpoints ||= wantsEndpoints;
    const endpointCount=this.retainEndpoints?request.width*request.height*grid*grid:1;
    if(endpointCount*16>Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize))throw Error('Final-orbit channels exceed this GPU’s buffer capacity. Reduce the viewport or disable the orbit-dependent mode.');
    if(!this.endpointBuffer||this.endpointCapacity<endpointCount){
      let replacement:GPUBuffer|undefined;
      try{await checkedGpu(device,()=>{replacement=storageBuffer(device,endpointCount*4,'final-orbits');});}catch(error){replacement?.destroy();throw error;}
      this.endpointBuffer?.destroy();this.endpointBuffer=replacement!;this.endpointCapacity=endpointCount;
    }
    if(this.abortRequested||!request.isCurrent!())throw new DOMException('Superseded endpoints','AbortError');
    u32[8] = this.refLength;
    u32[20] = approximationLevels;
    u32[21] = BASE_STEP;
    u32[35] = grid;
    u32[26] = request.height; u32[54]=1; u32[55]=previewStride;
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
    const rotation=rotationBasis(request.angle??0);
    // Four-word coefficients preserve the CPU camera basis; no absolute deep
    // coordinate is converted to f32 for rotation. Zero uses the unrotated path.
    f32.set(splitQuad(new Decimal(rotation.c)),92);f32.set(splitQuad(new Decimal(rotation.s)),96);
    const stopData=this.fillAppearance(uniforms,colors,this.retainEndpoints);
    device.queue.writeBuffer(this.stopsBuffer,0,stopData);
    device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    device.queue.writeBuffer(this.statsBuffer, 0, new Uint32Array(14));

    // What the field holds is a function of the geometry and the iteration,
    // not of the palette. Rebuilding it is the whole cost of a frame, so it is
    // only rebuilt when one of these changes.
    const fieldKey = this.fieldIdentity(request,family,constant,method,grid,this.retainEndpoints,u32[20]);
    const fieldStale = fieldKey !== this.fieldKey || this.aborted;
    const sampleKey = this.sampleIdentity(request,family,constant,method,grid,limbs,u32[20]);
    const ordinary=colors.mode===0&&grid===1&&colors.supersample===1&&
      (colors.capped??0)===0&&!this.retainEndpoints&&!needsEndpoints(colors);
    const admitted:AdmittedSamples={view:request,maxIterations:request.maxIterations,ordinary,
      policy:this.sampleIdentity({...request,maxIterations:0},family,constant,method,grid,limbs,u32[20]),
      reference:method===Method.Direct?null:this.refSamples,
      approximation:u32[20]>0?this.laBuffer:null};
    const capMapping=fieldStale&&this.fieldBuffer?
      automaticCapRemap(this.admittedSamples,admitted,
        !!(request.dynamicIterations&&request.followView&&request.provisionalNavigationCap),
        !!request.followView&&!this.isInteracting(request)):null;
    const lowerCap=capMapping&&this.admittedSamples!.maxIterations>request.maxIterations?request.maxIterations:0;
    const inPlaceCapUpgrade=fieldStale&&!!capMapping&&!!this.capUpgradeBase(request);
    const capUpgrade=inPlaceCapUpgrade||!!capMapping;
    if(inPlaceCapUpgrade)this.capPresentationTarget=request.maxIterations;
    if (fieldStale && !inPlaceCapUpgrade) {
      this.currentImageValid=false;
      this.admittedSamples=null;
      await checkedGpu(device,()=>{
        this.moveField(request, request.width * request.height * grid * grid, sampleKey,
          grid === 1 && colors.mode === 0 && !this.retainEndpoints, grid,capMapping,lowerCap);
        this.admittedSamples=admitted;
      });
      if(this.abortRequested||!request.isCurrent!())throw new DOMException('Superseded field','AbortError');
      // A calculated anchor remains authoritative when refinement changes only
      // sample density: sparse and dense visits use the same numerical policy.
      // A partial upward upgrade can contain stamps from several caps. Even
      // a later same-cap remap must reopen the older unresolved stamps.
      u32[41] = ordinary ? 2 : grid === 1 ? 1 : 0;
      device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    } else if(inPlaceCapUpgrade) {
      // Keep the old field and visible target. Reopened regions will visit only
      // samples stamped with an older cap; no CPU whole-region reuse applies.
      this.reuseMapping=null;this.reusableComplete=false;this.reusableKnownRectangles=[];
      this.determined=new CoverageRegions();this.determinedRegion=null;
      this.fieldComplete=false;this.sampleKey=sampleKey;this.currentImageValid=false;
      u32[41]=2;
      device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
    }
    this.admittedSamples=admitted;
    const capCertificate=capMapping&&ordinary&&request.followView&&!this.isInteracting(request)
      ?await this.validateCapField(request):null;
    const capFieldResolved=!!capCertificate&&capRegionResolved(capCertificate,{x:0,y:0,width:request.width,height:request.height});
    this.exactTotalSamples=request.width*request.height;
    this.exactCompletedSamples=fieldStale&&!capFieldResolved?0:this.exactTotalSamples;

    const pipelineStarted=performance.now();
    let calculatePipeline=await calculationPreparation;
    this.pipelineWaitMs+=performance.now()-pipelineStarted;
    if(this.abortRequested||!request.isCurrent!())throw new DOMException('Superseded pipeline','AbortError');
    this.requireLiveMethod(request);
    if(method!==Method.Direct)this.requirePreparedInwardView(request);
    // Replace the colour target only after asynchronous preparation. From
    // this swap through initialization/publication below there is no yield,
    // so presentation never observes the new texture with the old geometry.
    await this.ensureTarget(request.width, request.height);
    if(this.abortRequested||!request.isCurrent!())throw new DOMException("Superseded target","AbortError");
    this.incomingFrame=null;
    this.partialAppearanceUniforms=uniforms.slice(0);
    const bind=this.createRenderBind();

    const frame = {
      family: request.family, juliaX: request.juliaX, juliaY: request.juliaY,
      centerX: request.centerX, centerY: request.centerY, angle:request.angle??0,
      unitsPerPixel: request.unitsPerPixel, width: request.width, height: request.height,
      exportDomain: request.exportDomain, stationaryOversampling:request.stationaryOversampling,
      colors, maxIterations: request.maxIterations,
      useApprox: request.useApprox===true,
      tuning:request.tuning,
      followView:request.followView,interacting:request.interacting,zoom:request.zoom,
      method, grid,
    };
    const progressive = grid === 1 && request.publishPartial!==false&&!holdCompletedAppearance;
    // Measured ordinary dispatch does not transfer recurrence state between
    // views. Rotated fields keep the incumbent cold cohort and carry guards.
    const measuredBlaEligible=!!request.followView&&ordinary&&family==='mandelbrot'&&pipelineKind==='approx'&&
      !request.exportDomain&&!request.stationaryOversampling;
    const cohortEligible=measuredBlaEligible&&!request.angle;
    const continuationCapacity=Math.min(cohortEligible?32768:4096,
      continuationLaneLimit(Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize)));
    const continuationSupported=device.limits.maxStorageBuffersPerShaderStage>=8 && continuationCapacity>=grid*grid;
    if(request.maxIterations>=MANDATORY_CONTINUATION_ITERATIONS&&!continuationSupported)
      throw Error('This GPU cannot safely render million-iteration requests. Reduce the iteration limit.');
    const shade=(encoder:GPUCommandEncoder,width:number,height:number)=>this.encodeShadePass(encoder,bind,width,height);
    this.aborted = false;
    this.partialRegions = 0;
    let completed = true, cpuReused = capFieldResolved?request.width*request.height:0, submittedVisits=0;
    let exactCoverage=fieldStale&&!capFieldResolved?0:request.width*request.height;
    u32[40] = 0; u32[42] = 0; u32[43] = request.width;
    device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    if (fieldStale && !inPlaceCapUpgrade) {
      // Initialize once: copied exact samples become visible, unknown positions
      // have zero alpha. A recycled allocation never supplies validity.
      const init = device.createCommandEncoder({ label: "initialize-incoming" });
      shade(init, request.width, request.height);
      device.queue.submit([init.finish()]);

      if (progressive && request.isCurrent!()) this.incomingFrame = frame;
    }
    const epsilonPolicy=linearBlaPolicy(request,method);
    const ordinaryCostKey=[family,method,pipelineKind,request.maxIterations,limbs,colors.mode,grid,epsilonPolicy].join("|");
    const gpuPolicy=[family,method,pipelineKind,limbs,colors.mode,grid,this.retainEndpoints,epsilonPolicy].join('|');
    if(this.gpuBatchPolicy!==gpuPolicy){this.gpuBatchPolicy=gpuPolicy;this.gpuBatchCost={msPerVisit:0};}
    // Each callback retains the estimate for its numerical policy. Late results
    // cannot train a replacement policy after a mode/precision transition.
    const gpuCost=this.gpuBatchCost;
    if(this.ordinaryBatchCostKey!==ordinaryCostKey){
      this.ordinaryBatchCostKey=ordinaryCostKey;this.batchMsPerSample=0;
    }
    const freshWork=!this.reuseMapping&&!capUpgrade;
    const feedbackPolicy=[family,method,pipelineKind,limbs,colors.mode,grid,
      this.retainEndpoints,request.useApprox===true,freshWork,epsilonPolicy].join("|");
    const syncFeedbackPolicy=(hardBudget:number)=>{
      if(hardBudget<=0){
        if(this.batchCostKey){this.batchFeedback.enterTarget(true);this.batchCostKey="";}
        return;
      }
      const key=feedbackPolicy+"|"+hardBudget;
      const explicitCapChange=this.batchFeedbackCap!==request.maxIterations&&
        !(request.dynamicIterations&&request.followView&&request.provisionalNavigationCap);
      if(this.batchCostKey!==key||explicitCapChange){this.batchCostKey=key;this.batchFeedback.enterTarget(true);}
      this.batchFeedbackCap=request.maxIterations;
    };
    const settledPreviewEligible=progressive&&ordinary&&family==='mandelbrot'&&!!request.followView;
    let singlePreview=settledPreviewEligible&&!this.isInteracting(request);
    if (!fieldStale||capFieldResolved) this.pending.reset(0,0);
    if (fieldStale&&!capFieldResolved) {
      // Settled ordinary views need one broad preview before exact refinement.
      // Motion keeps the full density ladder so new visible areas can catch up.
      this.pending.reset(request.width,request.height,previewStride,request.followView,singlePreview);
      this.determined=new CoverageRegions(); this.determinedRegion=null;  this.streamTargets++;
    }
    if(capFieldResolved){
      this.determined=new CoverageRegions();
      this.determinedRegion={x:0,y:0,width:request.width,height:request.height};
      this.determined.add({...this.determinedRegion,spacing:1});
    }
    const targetStarted=performance.now();
    const serviceAppearance=()=>{
      if(!request.followView)return true;
      const latest=this.currentView;
      if(!latest||frame.family===latest.family&&frame.maxIterations===latest.maxIterations&&this.sameBlaPolicy(request,latest)&&
        (latest.family!=="julia"||!!frame.juliaX?.eq(latest.juliaX!)&&!!frame.juliaY?.eq(latest.juliaY!))&&
        JSON.stringify(frame.colors)===JSON.stringify(latest.colors))return true;
      if(!this.sameView(request,this.workRequest(latest)))return true;
      if(!this.appearanceCompatible(request,this.workRequest(latest),method,grid,this.retainEndpoints))return false;
      colors=this.copyColors(latest.colors);request={...request,colors};requestKey=keyFor(request);frame.colors=colors;
      const latestStops=this.fillAppearance(uniforms,colors,this.retainEndpoints);
      this.partialAppearanceUniforms=uniforms.slice(0);
      u32[26]=request.height;u32[40]=0;u32[42]=0;u32[43]=request.width;u32[54]=1;
      device.queue.writeBuffer(this.stopsBuffer,0,latestStops);device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
      const encoder=device.createCommandEncoder({label:"shade-latest-appearance"});shade(encoder,request.width,request.height);
      device.queue.submit([encoder.finish()]);this.appearanceSubmissions++;
      if(progressive){this.incomingFrame=frame;this.reproject(latest);}
      return true;
    };
    let scratch:GPUBuffer|undefined,scratchBind:GPUBindGroup|undefined,scratchCapacity=0;
    let continuationReadback:GPUBuffer|undefined;
    const continuationOrbit=this.orbitBuffer;
    let continuationProbe:{msPerVisit:number}|undefined;
    const carryEligible=!!(continuationSupported&&ordinary&&family==='mandelbrot'&&!request.angle&&
      !request.exportDomain&&!request.stationaryOversampling);
    const continuationIdentity:ContinuationIdentity={epoch,policy:[sampleKey,pipelineKind,this.refLength,u32[20],u32[21]].join('|'),
      reference:this.refSamples,orbit:this.orbitBuffer,table:this.laBuffer,index:this.laIndexBuffer};
    if(!carryEligible)this.clearContinuationWork();
    let carriedRegion=carryEligible?this.pendingContinuation.claim(continuationIdentity,request,this.regionDemand(request).visible):undefined;
    if(carriedRegion){scratch=carriedRegion.scratch;scratchCapacity=carriedRegion.capacity;this.continuationCarried++;}
    const poolEligible=!!(progressive&&request.followView&&ordinary&&family==='mandelbrot'&&
      method!==Method.Direct&&request.maxIterations>=MANDATORY_CONTINUATION_ITERATIONS&&
      !request.angle&&!request.exportDomain&&!request.stationaryOversampling&&!this.retainEndpoints&&
      colors.mode===0&&(colors.capped??0)===0);
    const cohort=new SurvivorCohort();
    let pool:GPUBuffer|undefined,poolBind:GPUBindGroup|undefined;
    let pooledPipeline:GPUComputePipeline|undefined,collectorPipeline:GPUComputePipeline|undefined;
    type Cost={expected:number;reported:number;gpuMs:number;unavailable:boolean;notify:()=>void};
    const newCost=():Cost=>({expected:0,reported:0,gpuMs:0,unavailable:false,notify:()=>{}});
    let poolCost=newCost();
    type Prefix={visits:number;wallMs:number;cost:()=>Omit<Cost,'notify'>;notify:(f:()=>void)=>void};
    let prefixes:Prefix[]=[];
    let observedCompletions=0;
    const poolCurrent=()=>epoch===this.publicationEpoch&&continuationOrbit===this.orbitBuffer&&
      request.isCurrent!()&&!this.abortRequested;
    const collectTiming=(sample:ReturnType<GpuTiming['begin']>,cost:Cost)=>{
      if(sample){cost.expected++;this.timing.collect(sample,
        ms=>{cost.reported++;cost.gpuMs+=ms;cost.notify();},
        ()=>{cost.reported++;cost.unavailable=true;cost.notify();});}
      else cost.unavailable=true;
    };
    const flushPool=async()=>{
      if(!cohort.lanes)return;
      const started=performance.now(),records=prefixes,metric=poolCost;
      let unfinished=cohort.lanes,published=observedCompletions;
      do{
        this.requireLiveMethod(request);
        if(!poolCurrent()){completed=false;this.aborted=true;return;}
        const stride=cohort.regions[0].stride;
        u32[54]=stride;u32[26]=request.height;u32[40]=0;u32[42]=0;u32[43]=request.width;
        device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
        const stationarySlice=!this.isInteracting(request);
        const operations=resumedContinuationOperations(COLD_CONTINUATION_OPERATIONS,unfinished,stationarySlice);
        // Do not overwrite byte 12: it is the independently computed append count.
        device.queue.writeBuffer(pool!,0,new Uint32Array([operations,1,cohort.lanes]));
        device.queue.writeBuffer(this.statsBuffer,28,new Uint32Array(1));
        const encoder=device.createCommandEncoder({label:'calculate-pooled-survivors'});
        const sample=this.timing.begin();
        const pass=encoder.beginComputePass({label:'calculate-pooled-survivors',timestampWrites:this.timing.writes(sample)});
        pass.setPipeline(pooledPipeline!);pass.setBindGroup(0,bind);pass.setBindGroup(1,poolBind!);
        pass.dispatchWorkgroups(Math.ceil(cohort.lanes/32));pass.end();
        this.timing.resolve(encoder,sample);
        encoder.copyBufferToBuffer(this.statsBuffer,0,continuationReadback!,0,56);
        encoder.copyBufferToBuffer(pool!,12,continuationReadback!,56,4);
        device.queue.submit([encoder.finish()]);collectTiming(sample,metric);
        this.ctx.lastNumericalWork=Object.freeze({route:'continued',method:'perturbation',family,
          maxIterations:request.maxIterations,width:cohort.lanes,height:1,stride,sampleGrid:1,operations,
          submittedAt:new Date().toISOString()});
        await continuationReadback!.mapAsync(GPUMapMode.READ);
        let completedSamples:number;
        try{
          const counters=new Uint32Array(continuationReadback!.getMappedRange());
          if(counters[14]!==cohort.lanes)throw Error('Survivor collection count mismatch');
          completedSamples=counters[5]+counters[6];unfinished=counters[7];
          if(unfinished>cohort.lanes)throw Error('Invalid survivor completion count');
        }finally{continuationReadback!.unmap();}
        observedCompletions=completedSamples;
        if(!poolCurrent()){completed=false;this.aborted=true;return;}
        if(completedSamples>published){
          // Each write is submitted before the next rectangle rewrites the
          // shared uniform buffer. No additional CPU/GPU fence is needed.
          for(const region of cohort.regions){
            u32[54]=region.stride;u32[26]=region.y+region.height;
            u32[40]=region.y;u32[42]=region.x;u32[43]=region.x+region.width;
            device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
            const encoder=device.createCommandEncoder({label:'shade-pooled-survivors'});
            shade(encoder,region.width,region.height);device.queue.submit([encoder.finish()]);
          }
          published=completedSamples;this.incomingFrame=frame;this.partialSerial++;this.partialRegions++;
          if(request.presentationOwner!=='animation')this.reproject(this.currentView??request);
        }
        if(!unfinished)break;
        await yieldToEvents();
        if(!poolCurrent()){completed=false;this.aborted=true;return;}
        await request.betweenBatches?.();
        if(!poolCurrent()){completed=false;this.aborted=true;return;}
        if(!serviceAppearance()){this.retarget=true;completed=false;return;}
        const live=this.currentView;
        if(request.followView&&live&&!this.sameView(request,this.workRequest(live))&&
          performance.now()-targetStarted>=(live.tuning?.targetResidencyMs??tuning.targetResidencyMs)){
          this.retarget=true;completed=false;return;
        }
      }while(unfinished);
      for(const region of cohort.regions){
        this.determined.add({x:region.x,y:region.y,width:region.width,height:region.height,spacing:region.stride});
        if(!this.determinedRegion||region.width*region.height>=this.determinedRegion.width*this.determinedRegion.height)
          this.determinedRegion={x:region.x,y:region.y,width:region.width,height:region.height};
        if(region.stride===1){exactCoverage+=region.width*region.height;this.exactCompletedSamples=exactCoverage;}
      }
      // Train on the ENTIRE cohort (prefixes + compaction + tail), without
      // inventing a per-region allocation of shared GPU time.
      const visits=records.reduce((n,r)=>n+r.visits,0);
      const wallMs=records.reduce((n,r)=>n+r.wallMs,0)+performance.now()-started;
      const measurement=this.batchFeedback.submit(visits,cohort.regions[0].stride,(this.currentView?.tuning??tuning).batchTargetMs);
      const probe={msPerVisit:wallMs/visits};continuationProbe=probe;
      this.batchMsPerSample=this.batchMsPerSample ? .75*this.batchMsPerSample+.25*probe.msPerVisit : probe.msPerVisit;
      let applied=false;
      const learn=()=>{
        if(applied)return;
        const costs=[metric,...records.map(r=>r.cost())];
        if(costs.some(c=>c.unavailable)){
          applied=true;this.batchFeedback.observe(measurement,wallMs,'fallback');
        }else if(costs.every(c=>c.reported===c.expected)){
          applied=true;const ms=costs.reduce((n,c)=>n+c.gpuMs,0);
          this.batchFeedback.observe(measurement,ms,'gpu');
          if(ms>0){probe.msPerVisit=ms/visits;gpuCost.msPerVisit=gpuCost.msPerVisit>0?.75*gpuCost.msPerVisit+.25*probe.msPerVisit:probe.msPerVisit;}
        }
      };
      metric.notify=learn;for(const record of records)record.notify(learn);learn();
      cohort.clear();prefixes=[];poolCost=newCost();
    };
    // The ordinary wall estimator is independent of continuation feedback.
    try { while (this.pending.size||carriedRegion||cohort.lanes) {
      if(cohort.ready(performance.now(),!!(this.pending.size||carriedRegion))){
        await flushPool();if(!completed)break;continue;
      }
      this.requireLiveMethod(request);
      const carry=carriedRegion;carriedRegion=undefined;
      const batchTuning=this.currentView?.tuning??tuning;
      if(ordinarySpecialized&&ordinaryShape!==batchTuning.workgroupShape){
        ordinaryShape=batchTuning.workgroupShape;
        calculatePipeline=await this.ensureComputePipeline(pipelineKind==='approx'?'ordinaryApprox':'ordinaryPlain',ordinaryShape);
        if(epoch!==this.publicationEpoch||!request.isCurrent!()||this.abortRequested){completed=false;this.aborted=true;break;}
        this.requireLiveMethod(request);
        const shape=deliveryWorkgroup(ordinaryShape);
        calculateWorkgroupX=shape.x;calculateWorkgroupY=shape.y;
      }
      const interacting=this.isInteracting(request);
      if(settledPreviewEligible&&!singlePreview&&!interacting){
        this.pending.settle(previewStride);singlePreview=true;
      }
      // Workload scale and time allowance are independent; preserve direction policy.
      const zoom=this.currentView?.zoom??request.zoom??0;
      const liveBatchView=this.currentView??request;
      const crossover=request.followView&&family==='mandelbrot'&&interacting&&zoom>0&&
        !this.perturbationActive&&liveBatchView.unitsPerPixel.times(liveBatchView.height).lte('2.8e-11');
      // Established inward perturbation uses a larger starting workload.
      const inwardIncumbent=!!request.followView&&interacting&&zoom>0&&family==='mandelbrot'&&ordinary&&
        method!==Method.Direct&&!crossover;
      const multiplier=crossover?Math.min(2,batchTuning.batchMultiplier):inwardIncumbent?32:batchTuning.batchMultiplier;
      const directionScale=request.followView?(!interacting?2:zoom<0?.5:1):1;
      // Apply the tested larger stationary floor only to this ordinary
      // perturbation path. Direct and expensive-pixel continuation stay unchanged.
      const stationaryEligible=!!request.followView&&!interacting&&family==='mandelbrot'&&
        method!==Method.Direct&&colors.mode===0&&grid===1;
      const stationaryFactor=stationaryEligible?2:1;
      const minimum=startingBatchVisits(request.maxIterations,multiplier*directionScale*stationaryFactor);
      const allowanceMs=perturbationAllowanceMs(inwardIncumbent?batchTuning.inwardWorkTargetMs/1.5:batchTuning.navigationTargetMs,directionScale,!!crossover);
      const automaticGuard=continuationSupported&&
        request.maxIterations>COLD_CONTINUATION_OPERATIONS;
      const measuredOrdinary=automaticGuard&&continuationProbe?measuredContinuationBudget(this.batchMsPerSample,batchTuning.batchTargetMs):undefined;
      const ordinaryBudget=measuredOrdinary??(this.batchMsPerSample>0
        ? Math.max(minimum,batchTuning.batchTargetMs/this.batchMsPerSample) : minimum);
      // Off disables the optional override, not the first-work safeguard. A
      // cold high-cap region cannot establish its cost by first running to cap.
      const sliceOperations=carry?.operations??(continuationSupported ? continuationOperations(request.maxIterations,
        this.batchMsPerSample,batchTuning.batchTargetMs,measuredBlaEligible) : 0);
      const costly=sliceOperations>0;
      syncFeedbackPolicy(sliceOperations);
      // Only the continuation route consults its separate, bounded feedback.
      const continuedBudget=costly?this.batchFeedback.budget(minimum,batchTuning.batchTargetMs,
        // A current GPU certificate permits normal measured growth while
        // resolved regions are skipped. The lane and operation bounds below
        // still apply to every unresolved region, even a single long-tail pixel.
        freshWork||capCertificate?request.width*request.height:Math.min(request.width*request.height,minimum)):ordinaryBudget;
      const spatialBudget=costly?Math.min(cohortEligible?continuationCapacity:continuedBudget,Math.floor(continuationCapacity/(grid*grid))):ordinaryBudget;
      // A direct-iteration wave can exceed the allowance even at minimum size;
      // shrinking it further loses occupancy without making it finish sooner.
      const gpuControlled=!!request.followView&&family==='mandelbrot'&&ordinary&&
        method!==Method.Direct&&!costly;
      // Soften an expensive floor only after perturbation is established and
      // while zooming. Preserve the allowance, estimator and stationary policy.
      const navigationMinimum=!inwardIncumbent&&gpuControlled&&this.timing.supported&&interacting&&zoom!==0&&
        this.perturbationActive&&!crossover
        ? navigationBatchMinimum(minimum,zoom,gpuCost.msPerVisit) : minimum;
      // A completed cold probe bootstraps this same controller. Its wall cost
      // is conservative until all GPU slice timings arrive. The old floor
      // cannot turn a measured small allowance back into a multi-second pass.
      const automaticCost=continuationProbe?.msPerVisit??
        (this.timing.supported&&gpuCost.msPerVisit>0?gpuCost.msPerVisit:this.batchMsPerSample);
      const measuredGpu=automaticGuard&&continuationProbe?measuredContinuationBudget(automaticCost,allowanceMs):undefined;
      // Keep the base sample minimum independent of the multiplier-expanded
      // floor. Preserve measured growth, directional sizing and the cold fallback.
      const measuredInward=gpuControlled&&this.timing.supported&&inwardIncumbent&&this.perturbationActive
        ? measuredContinuationBudget(gpuCost.msPerVisit,allowanceMs):undefined;
      const inwardMinimum=measuredInward===undefined?undefined:Math.max(batchTuning.minimumLogicalSamples/1.5,measuredInward);
      const gpuBudget=measuredGpu??inwardMinimum??(gpuCost.msPerVisit>0&&this.timing.supported ? Math.max(navigationMinimum,allowanceMs/gpuCost.msPerVisit) : spatialBudget);
      const sizingActive=gpuControlled&&this.timing.supported&&interacting&&zoom!==0&&this.perturbationActive&&!crossover;
      const motionBudget=sizingActive?motionBatchBudget(gpuBudget,zoom>0):gpuBudget;
      const proposedVisits=gpuControlled?motionBudget:spatialBudget;
      const requestedVisits=proposedVisits;
      const region = carry?.region??this.pending.take(requestedVisits,this.regionDemand(request),undefined,{
        pointer:batchTuning.pointerWeight,distributed:batchTuning.distributedWeight,
        oldest:batchTuning.oldestWeight,pointerRadius:batchTuning.pointerRadius,pointerRefinement:batchTuning.pointerRefinement},
        gpuControlled&&interacting&&zoom!==0);
      if(!region)break;
      // Serialize density transitions and intersecting output owners before
      // their cold field checks; skipKnown alone cannot prevent a write race.
      if(cohort.conflicts(region)){await flushPool();if(!completed)break;}
      const ownsExact=!carry;
      const width=region.width, rows=region.height;
      const m = this.reuseMapping, old = this.reusableView;
      const fullyKnown = !!(capCertificate&&capRegionResolved(capCertificate,region)) || !capUpgrade && m && old && m.denominator === 1 &&
        m.offsetX + region.x * m.step >= 0 && m.offsetY + region.y * m.step >= 0 &&
        m.offsetX + (region.x + width - 1) * m.step < old.width &&
        m.offsetY + (region.y + rows - 1) * m.step < old.height &&
        (this.reusableComplete || grid===1&&knownRemappedRegion(region,m,old,this.reusableKnownRectangles));
      if (!carry&&fullyKnown) {
        if(region.stride===1){
          cpuReused += width * rows;exactCoverage+=width*rows;this.exactCompletedSamples=exactCoverage;
          this.determined.add({x:region.x,y:region.y,width,height:rows,spacing:1});
        }
        continue;
      }
      const visits=Math.ceil(width/region.stride)*Math.ceil(rows/region.stride);
      const limit=Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize);
      // Fail closed if region selection ever exceeds the admitted capacity;
      // silently falling back here would undo the cold dispatch guard.
      const shape=costly ? continuationRegion(width,rows,region.stride,limit,grid) : null;
      let regionPipeline=calculatePipeline;
      if(shape){
        const preparing=performance.now();
        const kind=ordinarySpecialized ? pipelineKind==='approx'?'ordinaryApprox':'ordinaryPlain' : pipelineKind as 'direct'|'plain'|'approx'|'julia'|'juliaApprox';
        regionPipeline=await this.ensureContinuationPipeline(kind,false,poolEligible&&!carry);
        if(poolEligible&&!carry){pooledPipeline=await this.ensureContinuationPipeline(kind,true);collectorPipeline=await this.ensureSurvivorCollector();}
        this.pipelineWaitMs+=performance.now()-preparing;
        if(this.abortRequested||!request.isCurrent!()||continuationOrbit!==this.orbitBuffer)throw new DOMException('Superseded continuation','AbortError');
        this.requireLiveMethod(request);
        if(method!==Method.Direct)this.requirePreparedInwardView(request);
      }
      if(shape&&shape.bytes>scratchCapacity){
        scratch?.destroy();scratch=storageBuffer(device,shape.bytes/4,'wide-continuation');scratchCapacity=shape.bytes;scratchBind=undefined;
      }
      if(shape&&!scratchBind){
        if(!scratch)throw Error('Continuation scratch ownership is unavailable');
        scratchBind=device.createBindGroup({layout:this.continuationLayout!,entries:[{binding:0,resource:{buffer:scratch}}]});
      }
      if(shape&&!continuationReadback){
        continuationReadback=device.createBuffer({label:'continuation-counter-readback',size:60,
          usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      }
      let batchStarted=0;
      let deferred=false;
      if(shape){
        const measurement=carry?null:this.batchFeedback.submit(visits,region.stride,batchTuning.batchTargetMs);
        const learnBatch=(ms:number,kind:'gpu'|'fallback')=>{
          if(measurement)this.batchFeedback.observe(measurement,ms,kind);
        };
        const regionStarted=performance.now();
        const probe={msPerVisit:0};
        let sliceExpected=0,sliceReported=0,sliceGpuMs=0,sliceUnavailable=false,slicesFinished=false,costApplied=false,regionWallMs=0;
        let deferredNotify=()=>{};
        const learnRegion=()=>{
          if(deferred){deferredNotify();return;}
          if(!slicesFinished||costApplied)return;
          // Carried work has already paid part of its cost in the old target.
          if(carry){costApplied=true;return;}
          if(sliceUnavailable){costApplied=true;learnBatch(regionWallMs,'fallback');}
          else if(sliceReported===sliceExpected){
            costApplied=true;learnBatch(sliceGpuMs,'gpu');
            const cost=sliceGpuMs/visits;
            if(Number.isFinite(cost)&&cost>0){
              probe.msPerVisit=cost;
              // The captured object belongs to this numerical policy; a late
              // result cannot train a replacement policy after a transition.
              gpuCost.msPerVisit=gpuCost.msPerVisit>0?.75*gpuCost.msPerVisit+.25*cost:cost;
            }
          }
        };
        let resume=!!carry,unfinished=carry?.unfinished??0,
          publishedCompleted=observedCompletions;
        if(carry)submittedVisits+=unfinished;
        do {
          this.requireLiveMethod(request);
          // Appearance service may rewrite full-frame uniforms between slices.
          u32[54]=region.stride;u32[26]=region.y+rows;
          u32[40]=region.y;u32[42]=region.x;u32[43]=region.x+width;
          device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
          const control=new Uint32Array(resume?4:CONTINUATION_HEADER_BYTES/4);
          const stationarySlice=!!request.followView&&request.maxIterations>=MANDATORY_CONTINUATION_ITERATIONS&&family==='mandelbrot'&&ordinary&&
            method!==Method.Direct&&!this.isInteracting(request);
          const operations=cohortEligible&&!resume?coldCohortOperations(shape.lanes,stationarySlice):
            resumedContinuationOperations(sliceOperations,resume?unfinished:shape.lanes,stationarySlice);
          control.set([operations,resume?1:0,shape.columns,0]);
          device.queue.writeBuffer(scratch!,0,control);
          device.queue.writeBuffer(this.statsBuffer,28,new Uint32Array(1));
          const encoder=device.createCommandEncoder({label:'calculate-region'});
          const sample=this.timing.begin();
          const pass=encoder.beginComputePass({label:'calculate-region',timestampWrites:this.timing.writes(sample)});
          pass.setPipeline(regionPipeline);pass.setBindGroup(0,bind);pass.setBindGroup(1,scratchBind!);
          pass.dispatchWorkgroups(Math.ceil(shape.columns/8),Math.ceil(Math.ceil(rows/region.stride)*grid/4));pass.end();
          this.timing.resolve(encoder,sample);
          // Read the existing survivor/completion counters in this submission.
          encoder.copyBufferToBuffer(this.statsBuffer,0,continuationReadback!,0,56);
          device.queue.submit([encoder.finish()]);
          this.ctx.lastNumericalWork=Object.freeze({route:'continued',method:method===Method.Direct?'direct':'perturbation',family,maxIterations:request.maxIterations,width,height:rows,stride:region.stride,sampleGrid:grid,operations,submittedAt:new Date().toISOString()});
          if(!resume)submittedVisits+=shape.lanes;
          if(sample){
            sliceExpected++;
            this.timing.collect(sample,ms=>{sliceReported++;sliceGpuMs+=ms;learnRegion();},
              ()=>{sliceReported++;sliceUnavailable=true;learnRegion();});
          }else sliceUnavailable=true;

          // Mapping the reusable copy fences this slice. Unmap before reuse.
          await continuationReadback!.mapAsync(GPUMapMode.READ);
          let completedSamples:number;
          try {
            const counters=new Uint32Array(continuationReadback!.getMappedRange());
            completedSamples=counters[5]+counters[6];
            unfinished=counters[7];
          } finally { continuationReadback!.unmap(); }
          observedCompletions=completedSamples;
          if(epoch!==this.publicationEpoch||continuationOrbit!==this.orbitBuffer||
              !request.isCurrent!()||this.abortRequested){completed=false;this.aborted=true;break;}
          if(progressive&&completedSamples>publishedCompleted){
            // Another async service may have changed these shared uniforms
            // while the counter copy was mapped.
            device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
            const shadeEncoder=device.createCommandEncoder({label:'shade-completed-continuation'});
            shade(shadeEncoder,width,rows);
            device.queue.submit([shadeEncoder.finish()]);
            publishedCompleted=completedSamples;
            this.incomingFrame=frame;this.partialSerial++;this.partialRegions++;
            if(!unfinished){
              this.determined.add({x:region.x,y:region.y,width,height:rows,spacing:region.stride});
              if(!this.determinedRegion||width*rows>=this.determinedRegion.width*this.determinedRegion.height){
                this.determinedRegion={x:region.x,y:region.y,width,height:rows};

              }
            }

            if(request.presentationOwner!=='animation')this.reproject(this.currentView??request);
          }
          if(!unfinished)break;
          await yieldToEvents();
          if(epoch!==this.publicationEpoch||continuationOrbit!==this.orbitBuffer||
              !request.isCurrent!()||this.abortRequested){completed=false;this.aborted=true;break;}
          await request.betweenBatches?.();
          if(epoch!==this.publicationEpoch||continuationOrbit!==this.orbitBuffer||
              !request.isCurrent!()||this.abortRequested){completed=false;this.aborted=true;break;}
          if(!serviceAppearance()){this.retarget=true;completed=false;break;}
          const live=this.currentView;
          // An unfinished first slice is not a publication. Keep its bounded
          // continuation until some completed samples can be shown; otherwise
          // each inward scale change discards every unfinished lane.
          if(request.followView&&live&&!this.sameView(request,this.workRequest(live))&&
              !(this.partialSerial===targetStartingSerial&&this.inwardPreparationContinues(request,live))&&
              performance.now()-targetStarted>=(live.tuning?.targetResidencyMs??tuning.targetResidencyMs)){
            const next=this.workRequest(live);
            const saved:PendingContinuation={scratch:scratch!,capacity:scratchCapacity,region,view:request,
              identity:continuationIdentity,unfinished,operations:sliceOperations};
            if(carryEligible&&(colors.capped??0)===0&&!this.retainEndpoints&&
              translatedContinuationRegion(saved,next,this.regionDemand(next).visible)){
              this.pendingContinuation.park(saved);this.continuationParked++;
              scratch=undefined;scratchBind=undefined;scratchCapacity=0;
            }
            this.retarget=true;completed=false;break;
          }
          resume=true;
          if(poolEligible&&!carry&&cohort.accepts(region,unfinished,shape.lanes)){
            if(!pool){
              pool=storageBuffer(device,(CONTINUATION_HEADER_BYTES+SURVIVOR_CAPACITY*CONTINUATION_STATE_BYTES)/4,'pooled-survivors',GPUBufferUsage.COPY_SRC);
              poolBind=device.createBindGroup({layout:this.continuationLayout!,entries:[{binding:0,resource:{buffer:pool}}]});
            }
            if(!cohort.lanes)device.queue.writeBuffer(pool,0,new Uint32Array(CONTINUATION_HEADER_BYTES/4));
            // FIFO order: copy the source before its next cold header reset.
            device.queue.writeBuffer(scratch!,8,new Uint32Array([shape.lanes]));
            const collectorBind=device.createBindGroup({layout:collectorPipeline!.getBindGroupLayout(1),entries:[
              {binding:0,resource:{buffer:scratch!}},{binding:1,resource:{buffer:pool}}]});
            const emptyBind=device.createBindGroup({layout:collectorPipeline!.getBindGroupLayout(0),entries:[]});
            const encoder=device.createCommandEncoder({label:'collect-survivors'}),sample=this.timing.begin();
            const pass=encoder.beginComputePass({label:'collect-survivors',timestampWrites:this.timing.writes(sample)});
            pass.setPipeline(collectorPipeline!);pass.setBindGroup(0,emptyBind);pass.setBindGroup(1,collectorBind);
            pass.dispatchWorkgroups(Math.ceil(shape.lanes/64));pass.end();this.timing.resolve(encoder,sample);
            device.queue.submit([encoder.finish()]);collectTiming(sample,poolCost);
            cohort.add(region,unfinished,shape.lanes,performance.now());deferred=true;
            prefixes.push({visits,wallMs:performance.now()-regionStarted,
              cost:()=>({expected:sliceExpected,reported:sliceReported,gpuMs:sliceGpuMs,unavailable:sliceUnavailable}),
              notify:f=>{deferredNotify=f;}});
            break;
          }
        }while(unfinished);
        if(!completed)break;
        regionWallMs=performance.now()-regionStarted;
        if(!carry&&!deferred){probe.msPerVisit=regionWallMs/visits;continuationProbe=probe;}
        slicesFinished=!deferred;learnRegion();
        // A bounded probe must provide an exit to ordinary bulk rendering for
        // cheap work. Include its fences, as the ordinary estimator does; do
        // not include pipeline compilation or reference preparation.
        const observed=regionWallMs/visits;
        if(!carry&&!deferred&&Number.isFinite(observed)&&observed>0)this.batchMsPerSample=this.batchMsPerSample
          ? .75*this.batchMsPerSample+.25*observed : observed;
      }else{
        // Keep this scheduler selection intact. Only established inward motion
        // yields between aligned portions of the same logical region.
        const striped=sizingActive&&zoom>0&&progressive;
        let stripeCost=gpuCost.msPerVisit>0?gpuCost.msPerVisit:allowanceMs/visits;
        let rowsDone=0,timingExpected=0,timingReported=0,regionGpuMs=0;
        let timingUnavailable=false,regionFinished=false,costLearned=false;
        batchStarted=performance.now();
        const learnRegion=()=>{
          if(costLearned||!regionFinished||timingUnavailable||timingReported!==timingExpected||regionGpuMs<=0||!gpuControlled)return;
          if(striped&&(epoch!==this.publicationEpoch||this.abortRequested||!request.isCurrent!()))return;
          costLearned=true;
          const cost=regionGpuMs/visits;
          gpuCost.msPerVisit=gpuCost.msPerVisit>0?.75*gpuCost.msPerVisit+.25*cost:cost;
        };
        do{
          const stripeTuning=this.currentView?.tuning??batchTuning;
          const stripeRows=striped?ordinaryStripeRows(width,rows-rowsDone,region.stride,stripeCost,stripeTuning.publicationTargetMs,stripeTuning.minimumPassSamples,calculateWorkgroupY):rows;
          const stripeY=region.y+rowsDone;
          const stripeVisits=Math.ceil(width/region.stride)*Math.ceil(stripeRows/region.stride);
          if(striped){
            // Async appearance service can replace the shared GPU buffers.
            // Restore matching colours/stops as well as this stripe's bounds.
            const stops=this.fillAppearance(uniforms,colors,this.retainEndpoints);
            device.queue.writeBuffer(this.stopsBuffer,0,stops);
          }
          u32[54]=region.stride;u32[26]=stripeY+stripeRows;
          u32[40]=stripeY;u32[42]=region.x;u32[43]=region.x+width;
          device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
          const encoder=device.createCommandEncoder({label:'calculate-region'});
          const sample=gpuControlled?this.timing.begin():undefined;
          const pass=encoder.beginComputePass({label:'calculate-region',timestampWrites:this.timing.writes(sample)});
          pass.setPipeline(calculatePipeline);pass.setBindGroup(0,bind);
          pass.dispatchWorkgroups(Math.ceil(width/region.stride/calculateWorkgroupX),Math.ceil(stripeRows/region.stride/calculateWorkgroupY));pass.end();
          this.timing.resolve(encoder,sample);
          if(progressive)shade(encoder,width,stripeRows);
          device.queue.submit([encoder.finish()]);
          this.ctx.lastNumericalWork=Object.freeze({route:'ordinary',method:method===Method.Direct?'direct':'perturbation',family,maxIterations:request.maxIterations,width,height:stripeRows,stride:region.stride,sampleGrid:grid,operations:null,submittedAt:new Date().toISOString()});
          submittedVisits+=stripeVisits*grid*grid;
          if(sample){
            timingExpected++;
            this.timing.collect(sample,ms=>{
              timingReported++;
              // Zero timestamps can guide bounded local growth, but cannot
              // certify a complete measured cost for the logical region.
              if(ms>0)regionGpuMs+=ms;else timingUnavailable=true;
              if(striped)stripeCost=learnOrdinaryStripeCost(stripeCost,ms,stripeVisits);
              learnRegion();
            },()=>{timingReported++;timingUnavailable=true;});
          }else timingUnavailable=true;

          if(progressive&&request.isCurrent!()){
            this.incomingFrame=frame;this.partialSerial++;this.partialRegions++;
            this.determined.add({x:region.x,y:stripeY,width,height:stripeRows,spacing:region.stride});
            if(!this.determinedRegion||width*stripeRows>=this.determinedRegion.width*this.determinedRegion.height){
              this.determinedRegion={x:region.x,y:stripeY,width,height:stripeRows};

            }

            // The shared queue presents only this calculated and shaded stripe.
            if(request.presentationOwner!=='animation')this.reproject(this.currentView??request);
          }
          await device.queue.onSubmittedWorkDone();
          rowsDone+=stripeRows;
          if(striped){
            if(epoch!==this.publicationEpoch||this.abortRequested||!request.isCurrent!()){
              completed=false;this.aborted=true;break;
            }
            if(rowsDone<rows){
              await yieldToEvents();
              if(epoch!==this.publicationEpoch||this.abortRequested||!request.isCurrent!()){
                completed=false;this.aborted=true;break;
              }
              this.requireLiveMethod(request);
              if(!serviceAppearance()){this.retarget=true;completed=false;break;}
            }
          }
        }while(rowsDone<rows);
        if(!completed)break;
        if(striped){
          // Only now can the whole selected region replace its stripe hints.
          this.determined.add({x:region.x,y:region.y,width,height:rows,spacing:region.stride});
          if(!this.determinedRegion||width*rows>=this.determinedRegion.width*this.determinedRegion.height){
            this.determinedRegion={x:region.x,y:region.y,width,height:rows};

          }
        }
        continuationProbe=undefined;
        regionFinished=true;learnRegion();
      }
      // Preparation and one actual perturbation batch have finished. Restore
      // the selected multiplier on the very next batch, even during motion.
      if(method!==Method.Direct&&completed&&request.isCurrent!()&&!this.abortRequested)this.perturbationActive=true;
      // PendingRegions still owns the carried rectangle's exact obligations.
      // Its later known-sample visit counts this area once, without duplicating it.
      if(ownsExact&&!deferred&&region.stride===1){exactCoverage+=width*rows;this.exactCompletedSamples=exactCoverage;}
      if(!shape){
        const elapsed=performance.now()-batchStarted;
        if(request.interacting&&(request.zoom??0)<0)
          this.outwardBatchDelayMs=learnOutwardDelay(this.outwardBatchDelayMs,elapsed);
        const cost=elapsed/visits;
        this.batchMsPerSample=this.batchMsPerSample
          ? .75*this.batchMsPerSample+.25*cost : cost;
      }
      await yieldToEvents();
      if (!request.isCurrent!() || this.abortRequested) {
        completed = false; this.aborted = true; break;
      }
      await request.betweenBatches?.();
      if (!request.isCurrent!() || this.abortRequested) {
        completed = false; this.aborted = true; break;
      }
      if(!serviceAppearance()){
        this.retarget=true;completed=false;break;
      }
      // A geometry change updates demand regardless of input state. Give each
      // target useful bounded work, then follow the live camera. Releasing a
      // button changes neither this condition nor the outstanding queue.
      const live=this.currentView;
      if (request.followView && live && !this.sameView(request,this.workRequest(live)) &&
          (performance.now()-targetStarted >= (live.tuning?.targetResidencyMs??tuning.targetResidencyMs) || !this.pending.size)) {
        this.retarget=true; completed=false; break;
      }
    }
      if(completed&&(carriedRegion||cohort.lanes))throw Error('Unfinished continuation at final coverage.');
    }finally{
      scratch?.destroy();pool?.destroy();continuationReadback?.destroy();
    }
    if (!request.isCurrent!()||this.abortRequested) completed = false;
    if(completed&&!serviceAppearance()){this.retarget=true;completed=false;}
    if(completed&&(this.pending.size!==0||exactCoverage!==request.width*request.height))throw Error('Incomplete final sample coverage.');
    this.finalizing=completed;
    const retained=this.snapshotFrame(frame);
    let candidate:GPUTexture|undefined,published=false;
    let counters:Uint32Array;
    try{
      if(this.abortRequested||!request.isCurrent!()||this.deviceLost)completed=false;
      counters=!completed&&(this.abortRequested||!request.isCurrent!()||this.deviceLost)?new Uint32Array(14):new Uint32Array(await checkedGpu(device,()=>{
        if(completed){
          candidate=this.candidateTexture(retained.width,retained.height);
          const encoder=device.createCommandEncoder({label:'shade'});
          u32[26]=request.height;u32[54]=1;u32[40]=0;u32[42]=0;u32[43]=request.width;
          device.queue.writeBuffer(this.uniformBuffer,0,uniforms);
          if(capUpgrade||!fieldStale||!progressive||colors.mode===1||(colors.effect??0)>=7&&(colors.effect??0)<=9)shade(encoder,request.width,request.height);
          this.encodeCompletedSnapshot(encoder,frame,retained,candidate);
          device.queue.submit([encoder.finish()]);
        }
        // Existing map fences the final copy. Scopes are popped before it yields.
        return readBuffer(device,this.statsBuffer,56);
      }));
      if(this.deviceLost)throw Error('GPU connection lost. Reload to reconnect.');
      if(request.isCurrent!()&&!this.abortRequested&&completed){
        // Coarse and reused visits are not unique pixels. The region partition
        // supplies exact coverage separately; cached recolours have zero visits.
        if(counters[5]+counters[6]!==submittedVisits)throw Error('GPU sample accounting did not match submitted work.');
        this.fieldKey=fieldKey;this.fieldComplete=true;
        if(capUpgrade)this.sampleKey=sampleKey;
        const currentPresentation=(!presentationCurrent||presentationCurrent())&&
          (!request.followView||!this.currentView||this.samePresentation(frame,this.currentView));
        if(currentPresentation){
          this.commitHistory(retained,candidate!);candidate=undefined;
          this.lastFrame=retained;this.completedFrame=frame;this.currentImageValid=true;this.appearanceHoldFrame=null;published=true;
          this.capPresentationTarget=null;
        }else if(this.currentView&&this.presentationCompatible(frame,this.currentView)&&
            reprojectionFor(frame,this.currentView,true,true)){
          // A newer automatic cap does not make these finished pixels cease
          // to exist. Retain their actual old-cap identity for display only.
          this.commitHistory(retained,candidate!);candidate=undefined;this.lastFrame=retained;
        }
        this.incomingFrame=null;
      }else{
        completed=false;this.cachedRequest='';
        if(epoch===this.publicationEpoch){this.fieldKey='';this.fieldComplete=false;}
      }
    }finally{
      candidate?.destroy();
      if(epoch===this.publicationEpoch)this.finalizing=false;
    }
    const renderMs=performance.now()-started;
    const work = (i:number) => counters[i] + counters[i+8] * 4294967296;
    const skippedIterations = work(0);
    const plainIterations = work(3);
    const total = skippedIterations + plainIterations;

    const result: RenderStats = {
      completed, computed: fieldStale, capUpgrade,
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
      limitHitRatio: capUpgrade ? counters[12]/(request.width*request.height) : counters[5] > 0 ? counters[12] / counters[5] : 0,
      numericalPeriodicRatio: counters[5] > 0 ? counters[13] / counters[5] : 0,
    };
    if(completed&&this.fieldComplete){
      this.fieldDescriptor={family,constant,maxIterations:request.maxIterations,mode:colors.mode,grid,method,useApprox:request.useApprox===true,retainEndpoints:this.retainEndpoints,
        interiorEndpoints:colors.mode!==0||(colors.capped??0)>0,linearBlaEpsilon:linearBlaPolicy(request,method)};
      this.fieldUniforms=uniforms.slice(0);this.fieldStats=result;this.partialAppearanceUniforms=null;
    }
    if (completed && request.isCurrent!() && published) {
      this.cachedStats = result; this.cachedRequest = requestKey;

    }
    return result;
  }
}
