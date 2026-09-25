/** Local navigation controls are deliberately separate from saved views. */
export interface TuningSettings {
  batchTargetMs: number;
  batchMultiplier: number;
  hardPixelBudget: number;
  overscanBase: number;
  overscanMax: number;
  dynamicDepthGain: number;
  dynamicCapGain: number;
  /** Fixed, user-selected rendering policy, retained in requests for clarity. */
  directExponent: number;
  hdrExponent: number;
  pointerWeight: number;
  distributedWeight: number;
  oldestWeight: number;
  pointerRadius: number;
  blaRebuildPercent: number;
  blaChunkMs: number;
}

export const DEFAULT_TUNING: Readonly<TuningSettings> = Object.freeze({
  batchMultiplier: 16, hardPixelBudget: 0,
  overscanBase: 64, overscanMax: 128,
  dynamicDepthGain: 1000, dynamicCapGain: 1500,
  directExponent: 14.75, hdrExponent: 25, batchTargetMs: 8,
  pointerWeight: 8, distributedWeight: 4, oldestWeight: 4,
  pointerRadius: 32, blaRebuildPercent: 100, blaChunkMs: 0,
});

export const TUNING_STORAGE_KEY = 'gpu-zoomer-navigation-tuning-v3';
const PREVIOUS_TUNING_STORAGE_KEY = 'gpu-zoomer-navigation-tuning-v2';
export const HARD_PIXEL_BUDGETS = [0, 128, 256, 512, 1024, 2048, 4096, 8192, 16384] as const;
export const EDITABLE_TUNING_KEYS = [
  'batchTargetMs', 'batchMultiplier', 'hardPixelBudget', 'overscanBase', 'overscanMax',
  'dynamicDepthGain', 'dynamicCapGain',
] as const;
export type EditableTuningKey = typeof EDITABLE_TUNING_KEYS[number];

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const stepped = (value: unknown, fallback: number, min: number, max: number, step: number) =>
  Math.min(max, Math.max(min, Math.round((finite(value, fallback) - min) / step) * step + min));
const hardBudget = (value: unknown) => {
  if (HARD_PIXEL_BUDGETS.includes(value as typeof HARD_PIXEL_BUDGETS[number])) return value as number;
  // Removed 16/32/64 choices migrate to the smallest supported nonzero slice.
  return typeof value === 'number' && value > 0 && value < 128 ? 128 : DEFAULT_TUNING.hardPixelBudget;
};

export function normalizeTuning(value: unknown, changed?: EditableTuningKey): TuningSettings {
  const input = value && typeof value === 'object' ? value as Partial<TuningSettings> : {};
  const next: TuningSettings = {
    ...DEFAULT_TUNING,
    batchTargetMs: stepped(input.batchTargetMs, 8, 2, 16, 1),
    batchMultiplier: stepped(input.batchMultiplier, DEFAULT_TUNING.batchMultiplier, 1, 64, 1),
    hardPixelBudget: hardBudget(input.hardPixelBudget),
    overscanBase: stepped(input.overscanBase, DEFAULT_TUNING.overscanBase, 0, 128, 1),
    overscanMax: stepped(input.overscanMax, DEFAULT_TUNING.overscanMax, 0, 256, 1),
    dynamicDepthGain: stepped(input.dynamicDepthGain, DEFAULT_TUNING.dynamicDepthGain, 0, 5000, 50),
    dynamicCapGain: stepped(input.dynamicCapGain, DEFAULT_TUNING.dynamicCapGain, 0, 10000, 50),
  };
  if (next.overscanBase > next.overscanMax) {
    if (changed === 'overscanBase') next.overscanMax = next.overscanBase;
    else next.overscanBase = next.overscanMax;
  }
  return next;
}

export function modifiedTuningCount(settings: TuningSettings): number {
  return EDITABLE_TUNING_KEYS.filter(key => settings[key] !== DEFAULT_TUNING[key]).length;
}

/** Retain the 5183 iteration scaling, with an adjustable initial multiplier. */
export function startingBatchVisits(iterations: number, multiplier: number): number {
  return Math.max(64, Math.floor(16_384 * multiplier * Math.min(1, 10_000 / iterations) / 64) * 64);
}

/** Requested margin is symmetric in CSS pixels and linear in the speed setting. */
export function overscanCssPx(speed: number, base: number, max: number): number {
  const t = Math.max(0, Math.min(1, (speed - 0.2) / 2.8));
  return base + (max - base) * t;
}

export function loadTuning(storage?: Pick<Storage, 'getItem'>): TuningSettings {
  try {
    const source = storage ?? localStorage;
    const stored = source.getItem(TUNING_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object' || (parsed as {version?: unknown}).version !== 3) return { ...DEFAULT_TUNING };
      return normalizeTuning((parsed as {settings?: unknown}).settings);
    }
    const previous = source.getItem(PREVIOUS_TUNING_STORAGE_KEY);
    if (!previous) return { ...DEFAULT_TUNING };
    const parsed: unknown = JSON.parse(previous);
    if (!parsed || typeof parsed !== 'object' || (parsed as {version?: unknown}).version !== 2) return { ...DEFAULT_TUNING };
    const old = (parsed as {settings?: unknown}).settings;
    const settings = old && typeof old === 'object' ? old as Partial<TuningSettings> : {};
    // Saved values have no factory/explicit provenance. Preserve every supported
    // choice; only absent/invalid fields adopt current defaults.
    return normalizeTuning(settings);
  } catch { return { ...DEFAULT_TUNING }; }
}

export function saveTuning(settings: TuningSettings, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const values = Object.fromEntries(EDITABLE_TUNING_KEYS.map(key => [key, settings[key]]));
    (storage ?? localStorage).setItem(TUNING_STORAGE_KEY, JSON.stringify({version: 3, settings: values}));
    return true;
  } catch { return false; }
}
