import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, EDITABLE_TUNING_KEYS, TUNING_STORAGE_KEY, loadTuning, modifiedTuningCount, normalizeTuning, overscanCssPx, saveTuning, startingBatchVisits } from '../src/tuning';

describe('navigation tuning contracts', () => {
  it('retains iteration-scaled batch seeds and linear CSS overscan endpoints', () => {
    expect(startingBatchVisits(5_000, 4)).toBe(65_536);
    expect(startingBatchVisits(100_000, 4)).toBe(6_528);
    expect(overscanCssPx(.2, 64, 192)).toBe(64);
    expect(overscanCssPx(3, 64, 192)).toBe(192);
    expect(modifiedTuningCount({...DEFAULT_TUNING})).toBe(0);
  });

  it('stores only the five adjustable tuning controls', () => {
    const entries = new Map<string,string>();
    const storage = { getItem: (key:string) => entries.get(key) ?? null, setItem: (key:string,value:string) => { entries.set(key,value); } };
    const changed=normalizeTuning({...DEFAULT_TUNING,throughput:2,batchMultiplier:8,hardPixelBudget:1024});
    expect(saveTuning(changed,storage)).toBe(true);
    const payload=JSON.parse(entries.get(TUNING_STORAGE_KEY)!).settings;
    expect(Object.keys(payload).sort()).toEqual([...EDITABLE_TUNING_KEYS].sort());
    expect(Object.keys(payload)).toHaveLength(5);
    expect(payload).not.toHaveProperty('batchMultiplier');expect(payload).not.toHaveProperty('hardPixelBudget');
    expect(loadTuning(storage)).toEqual(changed);
    expect(modifiedTuningCount(changed)).toBe(1);
    entries.set(TUNING_STORAGE_KEY,JSON.stringify({version:1,settings:changed}));
    expect(loadTuning(storage)).toEqual(DEFAULT_TUNING);
  });

  it('preserves supported saved choices while retiring legacy sizing and overscan overrides', () => {
    const entries = new Map<string,string>();
    const storage = { getItem: (key:string) => entries.get(key) ?? null };
    entries.set('gpu-zoomer-navigation-tuning-v2',JSON.stringify({version:2,settings:{
      batchMultiplier:8,hardPixelBudget:32,overscanBase:64,overscanMax:192,
      dynamicDepthGain:2000,dynamicCapGain:1000,
    }}));
    expect(loadTuning(storage)).toEqual({...DEFAULT_TUNING,dynamicDepthGain:2000});
    expect(normalizeTuning({...DEFAULT_TUNING,hardPixelBudget:16}).hardPixelBudget).toBe(0);
    entries.set(TUNING_STORAGE_KEY,JSON.stringify({version:4,settings:{hardPixelBudget:256,overscanBase:0,overscanMax:0}}));
    expect(loadTuning(storage)).toMatchObject({hardPixelBudget:0,overscanBase:64,overscanMax:128});
  });

  it('uses Off and 64/128 for missing or invalid settings', () => {
    expect(loadTuning({getItem:()=>null})).toMatchObject({hardPixelBudget:0,overscanBase:64,overscanMax:128});
    expect(normalizeTuning({hardPixelBudget:'256',overscanBase:NaN,overscanMax:null}))
      .toMatchObject({hardPixelBudget:0,overscanBase:64,overscanMax:128});
  });

  it('retains the fixed batch seed and bounds the supported dynamic-depth preference',()=>{
    expect(loadTuning({getItem:()=>null})).toMatchObject({batchMultiplier:16,dynamicDepthGain:3000});
    expect(normalizeTuning({batchMultiplier:100,dynamicDepthGain:9000,dynamicCapGain:20000}))
      .toMatchObject({batchMultiplier:16,dynamicDepthGain:9000});
    expect(normalizeTuning({batchMultiplier:4,dynamicDepthGain:1000,dynamicCapGain:0}))
      .toMatchObject({batchMultiplier:16,dynamicDepthGain:1000});
    expect(normalizeTuning({dynamicCapGain:1000})).not.toHaveProperty('dynamicCapGain');
    expect(normalizeTuning({dynamicDepthGain:1e6}).dynamicDepthGain).toBe(30000);
    expect(normalizeTuning({dynamicDepthGain:-1}).dynamicDepthGain).toBe(0);
    expect(startingBatchVisits(1000,16)).toBe(262144);
    expect(startingBatchVisits(1000,64)).toBe(1048576);
  });

  it('keeps fixed policy fixed and the overscan endpoints ordered', () => {
    const changed=normalizeTuning({...DEFAULT_TUNING,directExponent:5,pointerRadius:64,overscanBase:128,overscanMax:64});
    expect(changed.directExponent).toBe(14.75);
    expect(changed.hdrExponent).toBe(25);
    expect(changed.pointerRadius).toBe(32);
    expect(changed.overscanMax).toBe(128);
  });
});
