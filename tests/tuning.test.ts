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

  it('stores only seven controls under the new version', () => {
    const entries = new Map<string,string>();
    const storage = { getItem: (key:string) => entries.get(key) ?? null, setItem: (key:string,value:string) => { entries.set(key,value); } };
    const changed=normalizeTuning({...DEFAULT_TUNING,batchMultiplier:8,hardPixelBudget:1024});
    expect(saveTuning(changed,storage)).toBe(true);
    expect(Object.keys(JSON.parse(entries.get(TUNING_STORAGE_KEY)!).settings)).toHaveLength(7);
    expect(loadTuning(storage)).toEqual(changed);
    expect(modifiedTuningCount(changed)).toBe(2);
    entries.set(TUNING_STORAGE_KEY,JSON.stringify({version:1,settings:changed}));
    expect(loadTuning(storage)).toEqual(DEFAULT_TUNING);
  });

  it('preserves supported saved choices without guessing whether factory values were explicit', () => {
    const entries = new Map<string,string>();
    const storage = { getItem: (key:string) => entries.get(key) ?? null };
    entries.set('gpu-zoomer-navigation-tuning-v2',JSON.stringify({version:2,settings:{
      batchMultiplier:8,hardPixelBudget:32,overscanBase:64,overscanMax:192,
      dynamicDepthGain:2000,dynamicCapGain:1000,
    }}));
    expect(loadTuning(storage)).toEqual({...DEFAULT_TUNING,batchMultiplier:8,hardPixelBudget:128,
      overscanBase:64,overscanMax:192,dynamicDepthGain:2000,dynamicCapGain:1000});
    expect(normalizeTuning({...DEFAULT_TUNING,hardPixelBudget:16}).hardPixelBudget).toBe(128);
    entries.set(TUNING_STORAGE_KEY,JSON.stringify({version:3,settings:{hardPixelBudget:256,overscanBase:0,overscanMax:0}}));
    expect(loadTuning(storage)).toMatchObject({hardPixelBudget:256,overscanBase:0,overscanMax:0});
  });

  it('uses Off and 64/128 for missing or invalid settings', () => {
    expect(loadTuning({getItem:()=>null})).toMatchObject({hardPixelBudget:0,overscanBase:64,overscanMax:128});
    expect(normalizeTuning({hardPixelBudget:'256',overscanBase:NaN,overscanMax:null}))
      .toMatchObject({hardPixelBudget:0,overscanBase:64,overscanMax:128});
  });

  it('uses the expanded defaults and bounds while retaining explicit older preferences',()=>{
    expect(loadTuning({getItem:()=>null})).toMatchObject({batchMultiplier:16,dynamicDepthGain:1000,dynamicCapGain:1500});
    expect(normalizeTuning({batchMultiplier:100,dynamicDepthGain:9000,dynamicCapGain:20000}))
      .toMatchObject({batchMultiplier:64,dynamicDepthGain:5000,dynamicCapGain:10000});
    expect(normalizeTuning({batchMultiplier:4,dynamicDepthGain:1000,dynamicCapGain:0}))
      .toMatchObject({batchMultiplier:4,dynamicDepthGain:1000,dynamicCapGain:0});
    expect(startingBatchVisits(1000,16)).toBe(262144);
    expect(startingBatchVisits(1000,64)).toBe(1048576);
  });

  it('keeps fixed policy fixed and the overscan endpoints ordered', () => {
    const changed=normalizeTuning({...DEFAULT_TUNING,directExponent:5,pointerRadius:64,overscanBase:128,overscanMax:64},'overscanBase');
    expect(changed.directExponent).toBe(14.75);
    expect(changed.hdrExponent).toBe(25);
    expect(changed.pointerRadius).toBe(32);
    expect(changed.overscanMax).toBe(128);
  });
});
