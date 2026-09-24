/** Local rendering experiments. This object is deliberately separate from SavedView. */
export interface TuningSettings {
  directExponent: number;
  batchTargetMs: number;
  batchMultiplier: number;
  hdrExponent: number;
  pointerWeight: number;
  distributedWeight: number;
  oldestWeight: number;
  pointerRadius: number;
  hardPixelBudget: number;
  blaRebuildPercent: number;
  blaChunkMs: number;
}

export const DEFAULT_TUNING: Readonly<TuningSettings> = Object.freeze({
  directExponent: 5, batchTargetMs: 8, batchMultiplier: 1, hdrExponent: 25,
  pointerWeight: 8, distributedWeight: 4, oldestWeight: 4, pointerRadius: 64,
  hardPixelBudget: 0, blaRebuildPercent: 100, blaChunkMs: 0,
});

export const TUNING_STORAGE_KEY = 'gpu-zoomer-tuning-v1';
export const HARD_PIXEL_BUDGETS = [0, 256, 512, 1024, 2048, 4096, 8192, 16384] as const;

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const stepped = (value: unknown, fallback: number, min: number, max: number, step: number) =>
  Math.min(max, Math.max(min, Math.round((finite(value, fallback) - min) / step) * step + min));

export function normalizeTuning(value: unknown, changed?: keyof TuningSettings): TuningSettings {
  const input = value && typeof value === 'object' ? value as Partial<TuningSettings> : {};
  const next: TuningSettings = {
    directExponent: stepped(input.directExponent, 5, 2, 18, .25),
    batchTargetMs: stepped(input.batchTargetMs, 8, 2, 16, 1),
    batchMultiplier: stepped(input.batchMultiplier, 1, .25, 4, .25),
    hdrExponent: stepped(input.hdrExponent, 25, 6, 80, .5),
    pointerWeight: stepped(input.pointerWeight, 8, 0, 16, 1),
    distributedWeight: stepped(input.distributedWeight, 4, 0, 16, 1),
    oldestWeight: stepped(input.oldestWeight, 4, 0, 16, 1),
    pointerRadius: 64,
    hardPixelBudget: HARD_PIXEL_BUDGETS.includes(input.hardPixelBudget as typeof HARD_PIXEL_BUDGETS[number]) ? input.hardPixelBudget! : 0,
    blaRebuildPercent: stepped(input.blaRebuildPercent, 100, 10, 100, 5),
    blaChunkMs: stepped(input.blaChunkMs, 0, 0, 8, 1),
  };
  const radius = Math.min(512, Math.max(16, finite(input.pointerRadius, 64)));
  next.pointerRadius = Math.round(2 ** (Math.round(Math.log2(radius) * 4) / 4));
  if (next.hdrExponent <= next.directExponent) {
    if (changed === 'hdrExponent') next.directExponent = next.hdrExponent - .25;
    else next.hdrExponent = Math.ceil((next.directExponent + .25) * 2) / 2;
  }
  if (!next.pointerWeight && !next.distributedWeight && !next.oldestWeight) {
    const attempted = changed === 'pointerWeight' ? 'pointerWeight' : changed === 'distributedWeight' ? 'distributedWeight' : 'oldestWeight';
    next[attempted] = 1;
  }
  return next;
}

export function modifiedTuningCount(settings: TuningSettings): number {
  return (Object.keys(DEFAULT_TUNING) as (keyof TuningSettings)[])
    .filter(key => settings[key] !== DEFAULT_TUNING[key]).length;
}

/** Matches the 5183 seed alignment at multiplier 1. */
export function startingBatchVisits(iterations: number, multiplier: number): number {
  return Math.max(64, Math.floor(16_384 * multiplier * Math.min(1, 10_000 / iterations) / 64) * 64);
}

export function loadTuning(storage?: Pick<Storage, 'getItem'>): TuningSettings {
  try {
    const stored = (storage ?? localStorage).getItem(TUNING_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_TUNING };
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || (parsed as {version?: unknown}).version !== 1) return { ...DEFAULT_TUNING };
    return normalizeTuning((parsed as {settings?: unknown}).settings);
  } catch { return { ...DEFAULT_TUNING }; }
}

export function saveTuning(settings: TuningSettings, storage?: Pick<Storage, 'setItem'>): boolean {
  try { (storage ?? localStorage).setItem(TUNING_STORAGE_KEY, JSON.stringify({version: 1, settings})); return true; }
  catch { return false; }
}
