/** Local navigation controls are deliberately separate from saved views. */
export interface TuningSettings {
  throughput: number;
  inwardWorkScale: number;
  gpuPassScale: number;
  /** Effective measured inward budget, before region subdivision. */
  inwardWorkTargetMs: number;
  publicationTargetMs: number;
  minimumLogicalSamples: number;
  minimumPassSamples: number;

  targetResidencyMs: number;
  pointerRefinement: boolean;
  workgroupShape: WorkgroupShape;
  batchTargetMs: number;
  /** Internal starting allowance for adaptive motion sizing. */
  navigationTargetMs: number;
  /** Internal starting scale; measured motion costs select the operating size. */
  batchMultiplier: number;

  overscanBase: number;
  overscanMax: number;
  dynamicDepthGain: number;

  /** Fixed, user-selected rendering policy, retained in requests for clarity. */
  directExponent: number;

  pointerPriority: number;
  pointerWeight: number;
  distributedWeight: number;
  oldestWeight: number;
  pointerRadius: number;

  /** Mandelbrot linear BLA local tolerance; other approximation policies are fixed. */
  blaPrecisionLog2: number;
}

export const THROUGHPUT_PRESETS = [
  {name:'Smooth',workScale:1,targetResidencyMs:64},
  {name:'Balanced',workScale:2,targetResidencyMs:128},
  {name:'Detailed',workScale:4,targetResidencyMs:32},
] as const;
const DELIVERY_BASE = {inwardWorkTargetMs:24,publicationTargetMs:12,
  minimumLogicalSamples:24_576,minimumPassSamples:16_384} as const;
const DEFAULT_THROUGHPUT = 0;
const DEFAULT_PRESET = THROUGHPUT_PRESETS[DEFAULT_THROUGHPUT];

export const DEFAULT_TUNING: Readonly<TuningSettings> = Object.freeze({
  throughput: DEFAULT_THROUGHPUT,
  inwardWorkScale: DEFAULT_PRESET.workScale, gpuPassScale: DEFAULT_PRESET.workScale,
  inwardWorkTargetMs: DELIVERY_BASE.inwardWorkTargetMs*DEFAULT_PRESET.workScale,
  publicationTargetMs: DELIVERY_BASE.publicationTargetMs*DEFAULT_PRESET.workScale,
  minimumLogicalSamples: DELIVERY_BASE.minimumLogicalSamples*DEFAULT_PRESET.workScale,
  minimumPassSamples: DELIVERY_BASE.minimumPassSamples*DEFAULT_PRESET.workScale,
  targetResidencyMs: DEFAULT_PRESET.targetResidencyMs,
  pointerRefinement: false, workgroupShape: '16x4',
  batchMultiplier: 16, navigationTargetMs: 16,
  overscanBase: 64, overscanMax: 128,
  dynamicDepthGain: 3000,
  // Fixed crossover into perturbation rendering.
  directExponent: 14.75, batchTargetMs: 8,
  pointerPriority: 1, pointerWeight: 2, distributedWeight: 1, oldestWeight: 1,
  pointerRadius: 32, blaPrecisionLog2: -14,
});

export const TUNING_STORAGE_KEY = 'gpu-zoomer-navigation-tuning-v4';
export const WORKGROUP_SHAPES = ['8x4', '16x4', '8x8', '24x4', '32x4', '64x4'] as const;
export type WorkgroupShape = typeof WORKGROUP_SHAPES[number];
export const EDITABLE_TUNING_KEYS = [
  'throughput', 'pointerRefinement',
  'dynamicDepthGain',
  'blaPrecisionLog2',
  'pointerPriority',
] as const;
export type EditableTuningKey = typeof EDITABLE_TUNING_KEYS[number];

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const stepped = (value: unknown, fallback: number, min: number, max: number, step: number) =>
  Math.min(max, Math.max(min, Math.round((finite(value, fallback) - min) / step) * step + min));

export function mandelbrotBlaEpsilon(tuning?: Partial<TuningSettings>): number {
  return stepped(tuning?.blaPrecisionLog2, DEFAULT_TUNING.blaPrecisionLog2, -24, -14, 1);
}

export const POINTER_RATIOS = [1, 2, 4, 8, 16] as const;
const LEGACY_POINTER_RATIOS = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64] as const;
function nearestPointerLevel(ratio:number):number {
  return POINTER_RATIOS.reduce((best,current,index)=>
    Math.abs(current-ratio)<Math.abs(POINTER_RATIOS[best]-ratio)?index:best,0);
}
function legacyPointerRatio(input:Partial<TuningSettings>):number {
  if(typeof input.pointerPriority==='number'&&Number.isFinite(input.pointerPriority))
    return LEGACY_POINTER_RATIOS[stepped(input.pointerPriority,2,0,LEGACY_POINTER_RATIOS.length-1,1)];
  const legacy=[input.pointerWeight,input.distributedWeight,input.oldestWeight];
  if(!legacy.some(value=>typeof value==='number'&&Number.isFinite(value)))return POINTER_RATIOS[DEFAULT_TUNING.pointerPriority];
  const pointer=stepped(input.pointerWeight,12,1,18,1);
  const distributed=stepped(input.distributedWeight,3,1,18,1);
  const oldest=stepped(input.oldestWeight,3,1,18,1);
  const share=pointer/(pointer+distributed+oldest);
  // Obsolete weight triples were limited to the original five levels.
  const level=LEGACY_POINTER_RATIOS.slice(0,5).reduce((best,ratio,index)=>
    Math.abs(ratio/(ratio+2)-share)<Math.abs(LEGACY_POINTER_RATIOS[best]/(LEGACY_POINTER_RATIOS[best]+2)-share)?index:best,0);
  return LEGACY_POINTER_RATIOS[level];
}
function pointerPriorityLevel(input: Partial<TuningSettings>): number {
  if(typeof input.pointerPriority==='number'&&Number.isFinite(input.pointerPriority))
    return stepped(input.pointerPriority,DEFAULT_TUNING.pointerPriority,0,POINTER_RATIOS.length-1,1);
  return nearestPointerLevel(legacyPointerRatio(input));
}

export function normalizeTuning(value: unknown): TuningSettings {
  const input = value && typeof value === 'object' ? value as Partial<TuningSettings> : {};
  const pointerPriority=pointerPriorityLevel(input),weightScale=pointerPriority===2?3:1;
  const throughput=stepped(input.throughput,DEFAULT_TUNING.throughput,0,THROUGHPUT_PRESETS.length-1,1);
  const preset=THROUGHPUT_PRESETS[throughput];
  const inwardWorkScale=preset.workScale;
  const gpuPassScale=inwardWorkScale;
  const next: TuningSettings = {
    ...DEFAULT_TUNING,
    throughput, inwardWorkScale, gpuPassScale,
    inwardWorkTargetMs: DELIVERY_BASE.inwardWorkTargetMs*inwardWorkScale,
    publicationTargetMs: DELIVERY_BASE.publicationTargetMs*gpuPassScale,
    minimumLogicalSamples: DELIVERY_BASE.minimumLogicalSamples*inwardWorkScale,
    minimumPassSamples: DELIVERY_BASE.minimumPassSamples*gpuPassScale,
    targetResidencyMs: preset.targetResidencyMs,
    pointerRefinement: typeof input.pointerRefinement==='boolean'?input.pointerRefinement:DEFAULT_TUNING.pointerRefinement,
    workgroupShape: DEFAULT_TUNING.workgroupShape,
    batchTargetMs: DEFAULT_TUNING.batchTargetMs,
    navigationTargetMs: DEFAULT_TUNING.navigationTargetMs,
    batchMultiplier: DEFAULT_TUNING.batchMultiplier,
    // These are fixed policy, including when reading obsolete stored controls.
    overscanBase: 64,
    overscanMax: 128,
    dynamicDepthGain: stepped(input.dynamicDepthGain, DEFAULT_TUNING.dynamicDepthGain, 0, 30000, 50),
    blaPrecisionLog2: mandelbrotBlaEpsilon(input),
    pointerPriority,
    pointerWeight: POINTER_RATIOS[pointerPriority]*weightScale,
    distributedWeight: weightScale,
    oldestWeight: weightScale,
  };
  return next;
}

export function modifiedTuningCount(settings: TuningSettings): number {
  return EDITABLE_TUNING_KEYS.filter(key => settings[key] !== DEFAULT_TUNING[key]).length;
}

/** Iteration-scaled starting workload before measured motion sizing takes over. */
export function startingBatchVisits(iterations: number, multiplier: number): number {
  return Math.max(64, Math.floor(16_384 * multiplier * Math.min(1, 10_000 / iterations) / 64) * 64);
}

/** Soften the navigation floor while preserving the time allowance.
 * The existing measured cost drives this rule; it does not infer GPU occupancy.
 * Call only for established, timed perturbation work during actual zoom input.
 */
export function navigationBatchMinimum(minimum:number, zoom:number, msPerVisit:number):number {
  if(!Number.isFinite(msPerVisit)||msPerVisit<=0||!Number.isFinite(zoom)||zoom===0)return minimum;
  const predictedMs=minimum*msPerVisit;
  // Hold the accepted default guard independent of both workload and target.
  const toleranceMs=zoom<0?64:128;
  const factor=Math.max(.5,Math.min(1,toleranceMs/predictedMs));
  return Math.min(minimum,Math.max(64,Math.ceil(minimum*factor/64)*64));
}

export function perturbationAllowanceMs(targetMs:number, directionScale:number, crossover:boolean):number {
  return (crossover?Math.min(1,targetMs):targetMs)*directionScale;
}

/** Requested margin is symmetric in CSS pixels and linear in the speed setting. */
export function overscanCssPx(speed: number, base: number, max: number): number {
  const t = Math.max(0, Math.min(1, (speed - 0.2) / 2.8));
  return base + (max - base) * t;
}

/** Unversioned durable defaults identify the new format by its throughput field. */
export function migrateSavedTuning(value:unknown,version?:2|3|4):TuningSettings {
  const input=value&&typeof value==='object'?value as Partial<TuningSettings>:{};
  if(version===4||version===undefined&&'throughput' in input)return normalizeTuning(input);
  let throughput=DEFAULT_TUNING.throughput;
  const hasSizing=['inwardWorkScale','gpuPassScale','inwardWorkTargetMs','publicationTargetMs','targetResidencyMs']
    .some(key=>key in input);
  if(hasSizing){
    const work='inwardWorkScale' in input?finite(input.inwardWorkScale,NaN):
      'inwardWorkTargetMs' in input?finite(input.inwardWorkTargetMs,NaN)/DELIVERY_BASE.inwardWorkTargetMs:1;
    const pass='gpuPassScale' in input?finite(input.gpuPassScale,NaN):
      'publicationTargetMs' in input?finite(input.publicationTargetMs,NaN)/DELIVERY_BASE.publicationTargetMs:work;
    const residency='targetResidencyMs' in input?finite(input.targetResidencyMs,NaN):64;
    const matched=THROUGHPUT_PRESETS.findIndex(preset=>
      preset.workScale===work&&preset.workScale===pass&&preset.targetResidencyMs===residency);
    if(matched>=0)throughput=matched;
  }
  return normalizeTuning({...input,throughput,pointerPriority:nearestPointerLevel(legacyPointerRatio(input))});
}

export function loadTuning(storage?: Pick<Storage, 'getItem'>): TuningSettings {
  try {
    const source = storage ?? localStorage;
    for(const version of [4,3,2] as const){
      const stored=source.getItem(`gpu-zoomer-navigation-tuning-v${version}`);
      if(!stored)continue;
      const parsed:unknown=JSON.parse(stored);
      if(!parsed||typeof parsed!=='object'||(parsed as {version?:unknown}).version!==version)return {...DEFAULT_TUNING};
      return migrateSavedTuning((parsed as {settings?:unknown}).settings,version);
    }
    return {...DEFAULT_TUNING};
  } catch { return { ...DEFAULT_TUNING }; }
}

export function saveTuning(settings: TuningSettings, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const values = Object.fromEntries(EDITABLE_TUNING_KEYS.map(key => [key, settings[key]]));
    (storage ?? localStorage).setItem(TUNING_STORAGE_KEY, JSON.stringify({version: 4, settings: values}));
    return true;
  } catch { return false; }
}
