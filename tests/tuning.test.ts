import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, TUNING_STORAGE_KEY, loadTuning, modifiedTuningCount, normalizeTuning, saveTuning, startingBatchVisits } from '../src/tuning';

describe('5183 tuning defaults', () => {
  it('keeps the incumbent aligned starting batch formula', () => {
    expect(startingBatchVisits(5_000, 1)).toBe(16_384);
    expect(startingBatchVisits(10_000, 1)).toBe(16_384);
    expect(startingBatchVisits(100_000, 1)).toBe(1_600);
    expect(modifiedTuningCount({ ...DEFAULT_TUNING })).toBe(0);
  });

  it('persists separately with a version and normalizes incompatible values', () => {
    expect(loadTuning()).toEqual(DEFAULT_TUNING);
    const entries = new Map<string,string>();
    const storage = { getItem: (key:string) => entries.get(key) ?? null, setItem: (key:string,value:string) => { entries.set(key,value); } };
    expect(loadTuning(storage)).toEqual(DEFAULT_TUNING);
    const changed = normalizeTuning({ ...DEFAULT_TUNING, batchMultiplier: 1.5, hardPixelBudget: 1024 });
    expect(saveTuning(changed,storage)).toBe(true);
    expect(loadTuning(storage)).toEqual(changed);
    expect(modifiedTuningCount(changed)).toBe(2);
    entries.set(TUNING_STORAGE_KEY,JSON.stringify({version:2,settings:changed}));
    expect(loadTuning(storage)).toEqual(DEFAULT_TUNING);
  });

  it('keeps a method interval and at least one priority service', () => {
    const direct = normalizeTuning({ ...DEFAULT_TUNING, directExponent: 18, hdrExponent: 6 }, 'directExponent');
    expect(direct.directExponent).toBe(18);
    expect(direct.hdrExponent).toBeGreaterThan(direct.directExponent);
    const hdr = normalizeTuning({ ...DEFAULT_TUNING, directExponent: 18, hdrExponent: 6 }, 'hdrExponent');
    expect(hdr.hdrExponent).toBe(6);
    expect(hdr.directExponent).toBe(5.75);
    const weights = normalizeTuning({ ...DEFAULT_TUNING, pointerWeight: 0, distributedWeight: 0, oldestWeight: 0 }, 'oldestWeight');
    expect(weights.pointerWeight + weights.distributedWeight + weights.oldestWeight).toBe(1);
  });
});
