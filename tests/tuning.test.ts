import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, TUNING_STORAGE_KEY, loadTuning, modifiedTuningCount, normalizeTuning, overscanCssPx, saveTuning, startingBatchVisits } from '../src/tuning';

describe('navigation tuning contracts', () => {
  it('retains iteration-scaled batch seeds and linear CSS overscan endpoints', () => {
    expect(startingBatchVisits(5_000, 4)).toBe(65_536);
    expect(startingBatchVisits(100_000, 4)).toBe(6_528);
    expect(overscanCssPx(.2, 64, 192)).toBe(64);
    expect(overscanCssPx(3, 64, 192)).toBe(192);
    expect(modifiedTuningCount({...DEFAULT_TUNING})).toBe(0);
  });

  it('stores only six controls under the new version', () => {
    const entries = new Map<string,string>();
    const storage = { getItem: (key:string) => entries.get(key) ?? null, setItem: (key:string,value:string) => { entries.set(key,value); } };
    const changed=normalizeTuning({...DEFAULT_TUNING,batchMultiplier:8,hardPixelBudget:1024});
    expect(saveTuning(changed,storage)).toBe(true);
    expect(loadTuning(storage)).toEqual(changed);
    expect(modifiedTuningCount(changed)).toBe(2);
    entries.set(TUNING_STORAGE_KEY,JSON.stringify({version:1,settings:changed}));
    expect(loadTuning(storage)).toEqual(DEFAULT_TUNING);
  });

  it('keeps fixed policy fixed and the overscan endpoints ordered', () => {
    const changed=normalizeTuning({...DEFAULT_TUNING,directExponent:5,pointerRadius:64,overscanBase:128,overscanMax:64},'overscanBase');
    expect(changed.directExponent).toBe(14.75);
    expect(changed.pointerRadius).toBe(32);
    expect(changed.overscanMax).toBe(128);
  });
});
