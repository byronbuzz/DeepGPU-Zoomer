import {describe,expect,it} from 'vitest';
import {continuationOperations,resumedContinuationOperations,continuationLaneLimit,measuredContinuationBudget,
  continuationRegion,CONTINUATION_HEADER_BYTES,CONTINUATION_STATE_BYTES,CONTINUATION_DISPATCH_OPERATIONS} from '../../src/render/continuation';
import {PendingRegions} from '../../src/render/regions';

describe('first difficult dispatch admission',()=>{
  it('bounds a cold million-iteration sample even when the optional control is Off',()=>{
    for(const estimate of [0,NaN,Infinity,-1])
      expect(continuationOperations(1_000_000,0,estimate,2624,8)).toBe(4096);
    expect(continuationOperations(1_000_000,16384,0,2624,8)).toBe(4096);
    expect(continuationOperations(1_000_000,128,0,2624,8)).toBe(128);
  });
  it('preserves ordinary bulk rendering after a cheap observation and for already bounded caps',()=>{
    expect(continuationOperations(100_000,0,.00001,65536,8)).toBe(0);
    expect(continuationOperations(4096,0,0,65536,8)).toBe(0);
    expect(continuationOperations(128,0,1,65536,8)).toBe(0);
  });
  it('returns warm cheap work to ordinary bulk even when its historical minimum is expensive',()=>{
    expect(continuationOperations(100_000,0,.01,65536,8)).toBe(0);
    expect(continuationOperations(298640,0,.18,35072,8)).toBe(0);
    expect(continuationOperations(100_000,4096,.01,65536,8)).toBe(4096);
    expect(continuationOperations(100_000,0,8.01,65536,8)).toBe(4096);
  });
  it('caps warm automatic work by the measured allowance without resurrecting the expensive floor',()=>{
    const budget=measuredContinuationBudget(.18,32)!;
    expect(budget).toBeCloseTo(177.7777777778);
    expect(budget*.18).toBeCloseTo(32);
    expect(budget).toBeLessThan(35072);
    expect(measuredContinuationBudget(.001,32)).toBe(32000);
    expect(measuredContinuationBudget(.2,8)).toBe(40);
    for(const invalid of [0,-1,NaN,Infinity]){
      expect(measuredContinuationBudget(invalid,8)).toBeUndefined();
      expect(measuredContinuationBudget(.18,invalid)).toBeUndefined();
    }
  });
  it('admits measured ordinary regions after the observed near-edge probe without reusing the 35072-visit floor',()=>{
    for(const cost of [.18,.002]){
      const pending=new PendingRegions();pending.reset(1600,900);
      const budget=measuredContinuationBudget(cost,32)!;
      const region=pending.take(budget,{x:1568,y:450,zoom:0,covered:[]})!;
      const visits=Math.ceil(region.width/region.stride)*Math.ceil(region.height/region.stride);
      expect(visits).toBeGreaterThanOrEqual(64);
      expect(visits).toBeLessThanOrEqual(budget);
      expect(visits*cost).toBeLessThanOrEqual(32);
      expect(continuationOperations(298640,0,cost,35072,8)).toBe(0);
    }
  });
  it('never turns Off into an unsliced drain or raises an admitted cold budget',()=>{
    expect(resumedContinuationOperations(0,4096,1)).toBe(4096);
    expect(resumedContinuationOperations(16384,4096,1)).toBe(4096);
    expect(resumedContinuationOperations(128,4096,1)).toBe(128);
    expect(resumedContinuationOperations(0,4096,4096)).toBe(256);
  });
  it('avoids tiny single-pixel slices while bounding aggregate admitted loop work',()=>{
    for(const lanes of [1,2,31,64,128,256,512,1024,2048,4096]){
      const operations=resumedContinuationOperations(0,4096,lanes);
      expect(operations).toBeGreaterThan(0);
      expect(operations).toBeLessThanOrEqual(4096);
      expect(operations*lanes).toBeLessThanOrEqual(CONTINUATION_DISPATCH_OPERATIONS);
    }
  });
  it('increases resumed work only for the fenced unfinished lanes while retaining the aggregate bound',()=>{
    const active=[4096,2048,1024,512,256,1];
    const operations=active.map(lanes=>resumedContinuationOperations(0,4096,lanes));
    expect(operations).toEqual([256,512,1024,2048,4096,4096]);
    operations.forEach((count,i)=>expect(count*active[i]).toBeLessThanOrEqual(CONTINUATION_DISPATCH_OPERATIONS));
  });
  it('bounds scratch lanes and rejects oversized regions instead of silently using an ordinary pass',()=>{
    expect(continuationLaneLimit(128*1024*1024)).toBe(4096);
    const capacity=CONTINUATION_HEADER_BYTES+128*CONTINUATION_STATE_BYTES;
    expect(continuationLaneLimit(capacity)).toBe(128);
    expect(continuationLaneLimit(CONTINUATION_HEADER_BYTES-1)).toBe(0);
    expect(continuationRegion(8,16,1,capacity).lanes).toBe(128);
    expect(()=>continuationRegion(8,20,1,capacity)).toThrow('capacity');
    expect(()=>continuationRegion(128,64,1,128*1024*1024)).toThrow('capacity');
  });
});
