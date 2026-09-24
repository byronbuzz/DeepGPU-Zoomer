/** Local navigation controls are deliberately separate from saved views. */
export interface TuningSettings {
  batchMultiplier: number;
  hardPixelBudget: number;
  overscanBase: number;
  overscanMax: number;
  dynamicDepthGain: number;
  dynamicCapGain: number;
  /** Fixed, user-selected rendering policy, retained in requests for clarity. */
  directExponent: number;
  hdrExponent: number;
  batchTargetMs: number;
  pointerWeight: number;
  distributedWeight: number;
  oldestWeight: number;
  pointerRadius: number;
  blaRebuildPercent: number;
  blaChunkMs: number;
}

export const DEFAULT_TUNING: Readonly<TuningSettings> = Object.freeze({
  batchMultiplier: 4, hardPixelBudget: 256,
  overscanBase: 64, overscanMax: 192,
  dynamicDepthGain: 2000, dynamicCapGain: 1000,
  directExponent: 14.75, hdrExponent: 31, batchTargetMs: 8,
  pointerWeight: 8, distributedWeight: 4, oldestWeight: 4,
  pointerRadius: 32, blaRebuildPercent: 100, blaChunkMs: 0,
});

export const TUNING_STORAGE_KEY = 'gpu-zoomer-navigation-tuning-v2';
export const HARD_PIXEL_BUDGETS = [0, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384] as const;
export const EDITABLE_TUNING_KEYS = [
  'batchMultiplier', 'hardPixelBudget', 'overscanBase', 'overscanMax',
  'dynamicDepthGain', 'dynamicCapGain',
] as const;
export type EditableTuningKey = typeof EDITABLE_TUNING_KEYS[number];

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const stepped = (value: unknown, fallback: number, min: number, max: number, step: number) =>
  Math.min(max, Math.max(min, Math.round((finite(value, fallback) - min) / step) * step + min));

export function normalizeTuning(value: unknown, changed?: EditableTuningKey): TuningSettings {
  const input = value && typeof value === 'object' ? value as Partial<TuningSettings> : {};
  const next: TuningSettings = {
    ...DEFAULT_TUNING,
    batchMultiplier: stepped(input.batchMultiplier, 4, 1, 16, 1),
    hardPixelBudget: HARD_PIXEL_BUDGETS.includes(input.hardPixelBudget as typeof HARD_PIXEL_BUDGETS[number]) ? input.hardPixelBudget! : 256,
    overscanBase: stepped(input.overscanBase, 64, 0, 128, 1),
    overscanMax: stepped(input.overscanMax, 192, 64, 256, 1),
    dynamicDepthGain: stepped(input.dynamicDepthGain, 2000, 0, 3000, 50),
    dynamicCapGain: stepped(input.dynamicCapGain, 1000, 0, 3000, 50),
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
    const stored = (storage ?? localStorage).getItem(TUNING_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_TUNING };
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || (parsed as {version?: unknown}).version !== 2) return { ...DEFAULT_TUNING };
    return normalizeTuning((parsed as {settings?: unknown}).settings);
  } catch { return { ...DEFAULT_TUNING }; }
}

export function saveTuning(settings: TuningSettings, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const values = Object.fromEntries(EDITABLE_TUNING_KEYS.map(key => [key, settings[key]]));
    (storage ?? localStorage).setItem(TUNING_STORAGE_KEY, JSON.stringify({version: 2, settings: values}));
    return true;
  } catch { return false; }
}
