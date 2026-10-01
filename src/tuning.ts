/** Local navigation controls are deliberately separate from saved views. */
export interface TuningSettings {
  batchTargetMs: number;
  /** Internal starting allowance for adaptive motion sizing. */
  navigationTargetMs: number;
  /** Internal starting scale; measured motion costs select the operating size. */
  batchMultiplier: number;
  motionPreference: number;
  hardPixelBudget: number;
  overscanBase: number;
  overscanMax: number;
  dynamicDepthGain: number;

  /** Fixed, user-selected rendering policy, retained in requests for clarity. */
  directExponent: number;
  hdrExponent: number;
  pointerPriority: number;
  pointerWeight: number;
  distributedWeight: number;
  oldestWeight: number;
  pointerRadius: number;
  blaRebuildPercent: number;
  blaChunkMs: number;
  /** Mandelbrot linear BLA local tolerance; other approximation policies are fixed. */
  blaPrecisionLog2: number;
}

export const DEFAULT_TUNING: Readonly<TuningSettings> = Object.freeze({
  motionPreference: 50, batchMultiplier: 16, navigationTargetMs: 16, hardPixelBudget: 0,
  overscanBase: 64, overscanMax: 128,
  dynamicDepthGain: 3000,
  // Preserve 5345's qualified Direct crossover and its deep-transition batching.
  directExponent: 14.75, hdrExponent: 25, batchTargetMs: 8,
  pointerPriority: 2, pointerWeight: 12, distributedWeight: 3, oldestWeight: 3,
  pointerRadius: 32, blaRebuildPercent: 100, blaChunkMs: 0, blaPrecisionLog2: -16,
});

export const TUNING_STORAGE_KEY = 'gpu-zoomer-navigation-tuning-v3';
const PREVIOUS_TUNING_STORAGE_KEY = 'gpu-zoomer-navigation-tuning-v2';
export const HARD_PIXEL_BUDGETS = [0, 128, 256, 512, 1024, 2048, 4096, 8192, 16384] as const;
export const EDITABLE_TUNING_KEYS = [
  'dynamicDepthGain',
  'blaPrecisionLog2',
  'pointerPriority',
] as const;
export type EditableTuningKey = typeof EDITABLE_TUNING_KEYS[number];

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const stepped = (value: unknown, fallback: number, min: number, max: number, step: number) =>
  Math.min(max, Math.max(min, Math.round((finite(value, fallback) - min) / step) * step + min));

export function mandelbrotBlaEpsilon(tuning?: Partial<TuningSettings>): number {
  return stepped(tuning?.blaPrecisionLog2, DEFAULT_TUNING.blaPrecisionLog2, -32, -14, 1);
}

/** Five user-facing levels; preserve the incumbent default scheduling sequence. */
const POINTER_RATIOS = [1, 2, 4, 6, 8] as const;
function pointerPriorityLevel(input: Partial<TuningSettings>): number {
  if(typeof input.pointerPriority==='number'&&Number.isFinite(input.pointerPriority))
    return stepped(input.pointerPriority,DEFAULT_TUNING.pointerPriority,0,4,1);
  const legacy=[input.pointerWeight,input.distributedWeight,input.oldestWeight];
  if(!legacy.some(value=>typeof value==='number'&&Number.isFinite(value)))return DEFAULT_TUNING.pointerPriority;
  const pointer=stepped(input.pointerWeight,DEFAULT_TUNING.pointerWeight,1,18,1);
  const distributed=stepped(input.distributedWeight,DEFAULT_TUNING.distributedWeight,1,18,1);
  const oldest=stepped(input.oldestWeight,DEFAULT_TUNING.oldestWeight,1,18,1);
  const share=pointer/(pointer+distributed+oldest);
  return POINTER_RATIOS.reduce((best,ratio,index)=>
    Math.abs(ratio/(ratio+2)-share)<Math.abs(POINTER_RATIOS[best]/(POINTER_RATIOS[best]+2)-share)?index:best,0);
}

export function normalizeTuning(value: unknown): TuningSettings {
  const input = value && typeof value === 'object' ? value as Partial<TuningSettings> : {};
  const pointerPriority=pointerPriorityLevel(input),weightScale=pointerPriority===2?3:1;
  const next: TuningSettings = {
    ...DEFAULT_TUNING,
    motionPreference: stepped(input.motionPreference, DEFAULT_TUNING.motionPreference, 0, 100, 1),
    batchTargetMs: DEFAULT_TUNING.batchTargetMs,
    navigationTargetMs: DEFAULT_TUNING.navigationTargetMs,
    batchMultiplier: DEFAULT_TUNING.batchMultiplier,
    // These are fixed policy, including when reading obsolete stored controls.
    hardPixelBudget: 0,
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

/** Bounded navigation experiment: soften only the floor, never the time allowance.
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

/** Obsolete manual sizing values must not silently override the adaptive starting policy. */
export function migrateSavedTuning(value:unknown):TuningSettings {
    return normalizeTuning(value);
}

export function loadTuning(storage?: Pick<Storage, 'getItem'>): TuningSettings {
  try {
    const source = storage ?? localStorage;
    const stored = source.getItem(TUNING_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object' || (parsed as {version?: unknown}).version !== 3) return { ...DEFAULT_TUNING };
      return migrateSavedTuning((parsed as {settings?: unknown}).settings);
    }
    const previous = source.getItem(PREVIOUS_TUNING_STORAGE_KEY);
    if (!previous) return { ...DEFAULT_TUNING };
    const parsed: unknown = JSON.parse(previous);
    if (!parsed || typeof parsed !== 'object' || (parsed as {version?: unknown}).version !== 2) return { ...DEFAULT_TUNING };
    const old = (parsed as {settings?: unknown}).settings;
    const settings = old && typeof old === 'object' ? old as Partial<TuningSettings> : {};
    // Saved values have no factory/explicit provenance. Preserve every supported
    // choice; only absent/invalid fields adopt current defaults.
    return migrateSavedTuning(settings);
  } catch { return { ...DEFAULT_TUNING }; }
}

export function saveTuning(settings: TuningSettings, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const values = Object.fromEntries(EDITABLE_TUNING_KEYS.map(key => [key, settings[key]]));
    (storage ?? localStorage).setItem(TUNING_STORAGE_KEY, JSON.stringify({version: 3, settings: values}));
    return true;
  } catch { return false; }
}
