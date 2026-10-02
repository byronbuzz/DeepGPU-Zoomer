import {describe,expect,it} from 'vitest';
import shader from '../../src/render/perturbation.wgsl?raw';
import continuationShader from '../../src/render/continuation.wgsl?raw';
import {COLD_CONTINUATION_OPERATIONS,CONTINUATION_DISPATCH_OPERATIONS,CONTINUATION_HEADER_BYTES,
  CONTINUATION_STATE_BYTES,DEFERRED_MAX_LANES,DEFERRED_HEADER_BYTES,DEFERRED_MAX_DISPATCH_OPERATIONS,continuationLaneLimit,
  continuationRegion,continuationEntry,continuationShaderSource,deferredLaneLimit,deferredRegion,
  deferredContinuationOperations,learnDeferredOperationCost} from '../../src/render/continuation';

describe('bounded hard-pixel deferral',()=>{
  it('reaches the high first cutoff cumulatively without admitting a long dispatch',()=>{
    for(const lanes of [1,4096,DEFERRED_MAX_LANES]){
      const cutoff=1048576;
      let executed=0,slices=0;
      while(executed<cutoff){
        const operations=deferredContinuationOperations(cutoff,executed,lanes);
        expect(operations).toBeGreaterThan(0);
        expect(operations).toBeLessThanOrEqual(COLD_CONTINUATION_OPERATIONS);
        expect(operations*lanes).toBeLessThanOrEqual(CONTINUATION_DISPATCH_OPERATIONS);
        executed+=operations;slices++;
      }
      expect(executed).toBe(cutoff);
      expect(slices).toBeGreaterThan(1);
    }
  });
  it('ends the first stage exactly at its cutoff and separates later slices from it',()=>{
    expect(deferredContinuationOperations(128,120,1)).toBe(8);
    expect(deferredContinuationOperations(128,128,1,true)).toBe(4096);
    expect(deferredContinuationOperations(1048576,1048575,65536)).toBe(1);
    for(const lanes of [1,31,64,256,4096,65536]){
      const count=deferredContinuationOperations(128,128,lanes,true);
      expect(count*lanes).toBeLessThanOrEqual(CONTINUATION_DISPATCH_OPERATIONS);
      expect(count).toBeLessThanOrEqual(4096);
    }
  });
  it('switching Off never converts saved work into an unbounded drain',()=>{
    expect(deferredContinuationOperations(0,128,1)).toBe(4096);
    expect(deferredContinuationOperations(0,128,65536)).toBe(16);
    expect(deferredContinuationOperations(0,128,65536,true)).toBe(16);
    for(const lanes of [0,-1,1.5,65537,NaN,Infinity])
      expect(()=>deferredContinuationOperations(4096,0,lanes)).toThrow('capacity');
  });
  it('uses measured aggregate allowances without exceeding either work bound',()=>{
    for(const lanes of [1,31,4096,DEFERRED_MAX_LANES]){
      for(const allowance of [1,65536,2*CONTINUATION_DISPATCH_OPERATIONS,DEFERRED_MAX_DISPATCH_OPERATIONS,
          100*DEFERRED_MAX_DISPATCH_OPERATIONS]){
        const operations=deferredContinuationOperations(1048576,0,lanes,false,allowance);
        expect(operations).toBeGreaterThanOrEqual(1);
        expect(operations).toBeLessThanOrEqual(COLD_CONTINUATION_OPERATIONS);
        expect(operations*lanes).toBeLessThanOrEqual(Math.max(lanes,Math.min(allowance,DEFERRED_MAX_DISPATCH_OPERATIONS)));
      }
    }
    expect(deferredContinuationOperations(1048576,0,65536,false,2*CONTINUATION_DISPATCH_OPERATIONS)).toBe(32);
    expect(deferredContinuationOperations(1048576,0,65536,false,DEFERRED_MAX_DISPATCH_OPERATIONS)).toBe(512);
    expect(deferredContinuationOperations(1048576,0,1,false,DEFERRED_MAX_DISPATCH_OPERATIONS)).toBe(4096);
  });
  it('keeps a high first cutoff cumulative and its final slice exact with a larger allowance',()=>{
    const cutoff=1048576,lanes=65536;
    let executed=0,slices=0;
    while(executed<cutoff){
      const operations=deferredContinuationOperations(cutoff,executed,lanes,false,DEFERRED_MAX_DISPATCH_OPERATIONS);
      expect(operations*lanes).toBeLessThanOrEqual(DEFERRED_MAX_DISPATCH_OPERATIONS);
      executed+=operations;slices++;
    }
    expect(executed).toBe(cutoff);expect(slices).toBe(2048);
    expect(deferredContinuationOperations(cutoff,cutoff-7,lanes,false,DEFERRED_MAX_DISPATCH_OPERATIONS)).toBe(7);
    expect(deferredContinuationOperations(128,120,lanes,false,DEFERRED_MAX_DISPATCH_OPERATIONS)).toBe(8);
  });
  it('keeps measured Off resumes bounded and rejects invalid feedback by falling back',()=>{
    expect(deferredContinuationOperations(0,128,65536,true,DEFERRED_MAX_DISPATCH_OPERATIONS)).toBe(512);
    expect(deferredContinuationOperations(0,128,1,true,DEFERRED_MAX_DISPATCH_OPERATIONS)).toBe(4096);
    for(const allowance of [NaN,Infinity,-Infinity])
      expect(deferredContinuationOperations(0,128,65536,true,allowance)).toBe(16);
    for(const allowance of [-100,0,.5,1])
      expect(deferredContinuationOperations(0,128,65536,true,allowance)).toBe(1);
    expect(deferredContinuationOperations(0,128,1,true,23.9)).toBe(23);
  });
  it('keeps cold buffer sizing intact and separately bounds deferred storage',()=>{
    const storage=128*1024*1024;
    expect(continuationLaneLimit(storage)).toBe(4096);
    expect(CONTINUATION_HEADER_BYTES).toBe(528);
    expect(()=>continuationRegion(256,256,1,storage)).toThrow('capacity');
    expect(deferredLaneLimit(storage)).toBe(65536);
    expect(DEFERRED_HEADER_BYTES).toBe(8208);
    const region=deferredRegion(256,256,1,storage);
    expect(region).toEqual({columns:256,rows:256,lanes:65536,bytes:19931152});
    expect(deferredLaneLimit(region.bytes)).toBe(region.lanes);
    expect(deferredLaneLimit(region.bytes-1)).toBe(region.lanes-1);
    expect(deferredLaneLimit(DEFERRED_HEADER_BYTES-1)).toBe(0);
    expect(deferredLaneLimit(NaN)).toBe(0);
    expect(()=>deferredRegion(257,256,1,storage)).toThrow('capacity');
    expect(()=>deferredRegion(256,256,1,region.bytes-1)).toThrow('capacity');
    expect(deferredRegion(512,512,2,storage)).toEqual(region);
    expect(deferredRegion(513,3,2,storage).bytes).toBe(DEFERRED_HEADER_BYTES+257*2*CONTINUATION_STATE_BYTES);
    for(const geometry of [[-8,-8,-1],[8,8,0],[NaN,8,1],[8,8,1.5]])
      expect(()=>deferredRegion(...geometry as [number,number,number],storage)).toThrow('capacity');
  });
  it('uses distinct bitset layouts without changing the cold shader source',()=>{
    expect(continuationShaderSource(continuationShader)).toBe(continuationShader);
    const deferred=continuationShaderSource(continuationShader,true);
    expect(deferred).toContain('pendingBits: array<atomic<u32>, 2048>,');
    expect(deferred.replace('pendingBits: array<atomic<u32>, 2048>,','pendingBits: array<atomic<u32>, 128>,'))
      .toBe(continuationShader);
    expect(()=>continuationShaderSource(deferred,true)).toThrow('header');
  });
});

describe('deferred executed-work cost confidence',()=>{
  it('uses fully consumed survivor operations as a conservative denominator',()=>{
    const previous=.000001;
    expect(learnDeferredOperationCost(previous,4,128,8192,4096)).toBe(4/(128*4096));
    expect(learnDeferredOperationCost(previous,4,128,8192,8192)).toBe(4/(128*8192));
    expect(learnDeferredOperationCost(previous,4,128,8192,4096)).toBeGreaterThan(4/(128*8192));
  });
  it('does not let cheap completions or low occupancy underprice the next full pass',()=>{
    const previous=.001;
    for(const [before,survivors] of [[65536,0],[65536,32767],[4095,4095],[1024,1024]])
      expect(learnDeferredOperationCost(previous,.001,128,before,survivors)).toBe(previous);
    expect(learnDeferredOperationCost(previous,.001,128,4096,2048)).toBe(previous/2);
  });
  it('accepts only positive GPU time and valid integer operation and lane counts',()=>{
    const previous=.001;
    for(const ms of [-1,0,NaN,Infinity])
      expect(learnDeferredOperationCost(previous,ms,128,8192,8192)).toBe(previous);
    for(const operations of [-1,0,1.5,NaN,Infinity])
      expect(learnDeferredOperationCost(previous,1,operations,8192,8192)).toBe(previous);
    for(const [before,survivors] of [[8192,8193],[8192,4096.5],[8192,NaN],[Infinity,Infinity],[8192.5,8192]])
      expect(learnDeferredOperationCost(previous,1,128,before,survivors)).toBe(previous);
  });
  it('limits seeded cost reduction to twofold and reacts immediately to expensive work',()=>{
    const previous=12/CONTINUATION_DISPATCH_OPERATIONS;
    expect(learnDeferredOperationCost(previous,.01,16,65536,65536)).toBe(previous/2);
    expect(learnDeferredOperationCost(previous,48,16,65536,65536)).toBe(4*previous);
  });
});

// Execute the actual retirement function's integer/atomic statements on CPU.
// This checks accounting only; it is not WGSL compilation or GPU validation.
const retirement=continuationShader.match(/fn retireContinuedSample\(stateIndex: u32\) \{([\s\S]*?)\r?\n\}\r?\n/)![1];
const retirementJs=retirement.replace(/\blet\b/g,'const').replace(/\bvar\b/g,'let')
  .replace(/\b(0x[0-9a-f]+|\d+)u\b/gi,'$1')
  .replace(/atomicAdd\(&stats\[(\d+)\],/g,'atomicAdd(stats,$1,')
  .replace(/atomicAnd\(&continuation\.pendingBits\[stateIndex \/ 32\],/g,
    'atomicAnd(continuation.pendingBits,Math.floor(stateIndex / 32),');
const retire=new Function('continuation','stats','DIRECT','stateIndex','atomicAdd','atomicAnd',retirementJs);
const add=(target:Uint32Array,index:number,value:number)=>{const before=target[index];target[index]=(before+value)>>>0;return before;};
const and=(target:Uint32Array,index:number,value:number)=>{const before=target[index];target[index]=(before&value)>>>0;return before;};

describe('overlapping sample retirement',()=>{
  it('records a Wide prefix once, including counter carries, without completing a computed sample',()=>{
    const stats=new Uint32Array(14);stats[0]=0xfffffff0;stats[1]=0xfffffffe;stats[2]=0xffffffff;stats[3]=0xfffffff8;
    stats[4]=11;stats[5]=12;stats[7]=13;stats[12]=14;stats[13]=15;
    const continuation={pendingBits:new Uint32Array([0xffffffff,3]),states:Array(34).fill({n:100,skipped:80,skips:5,rebases:2})};
    retire(continuation,stats,false,33,add,and);
    expect(Array.from(stats.slice(0,4))).toEqual([64,3,1,12]);
    expect(Array.from(stats.slice(8,12))).toEqual([1,1,1,1]);
    expect(stats[6]).toBe(1);expect(continuation.pendingBits[1]).toBe(1);
    expect([stats[4],stats[5],stats[7],stats[12],stats[13]]).toEqual([11,12,13,14,15]);
  });
  it('treats Direct checkpoint metadata as cycle state rather than BLA work',()=>{
    const stats=new Uint32Array(14);
    const continuation={pendingBits:new Uint32Array([1]),states:[{n:64,skipped:1000,skips:0,rebases:0}]};
    retire(continuation,stats,true,0,add,and);
    expect(Array.from(stats.slice(0,7))).toEqual([0,0,0,64,0,0,1]);
    expect(continuation.pendingBits[0]).toBe(0);
  });
  it('keeps checkpoint ownership spatial and retires only valid same-context field samples',()=>{
    const entry=continuationEntry(shader);
    expect(entry).toContain('let stateIndex = position.y * continuation.columns + position.x;');
    const guard=entry.indexOf('atomicLoad(&continuation.pendingBits');
    const retirement=entry.indexOf('retireContinuedSample(stateIndex);');
    expect(guard).toBeLessThan(retirement);
    expect(retirement).toBeLessThan(entry.indexOf('let s = iterateWideContinued'));
    const expression=entry.match(/if \((continuation.resume != 0u && determined &&.*?)\) \{\n        retireContinuedSample/)![1];
    const shouldRetire=new Function('continuation','determined','u','resolved','return '+expression.replace(/\b(\d+)u\b/g,'$1'));
    expect(shouldRetire({resume:1},true,{reuseField:2},false)).toBe(false);
    expect(shouldRetire({resume:1},true,{reuseField:2},true)).toBe(true);
    expect(shouldRetire({resume:1},true,{reuseField:0},false)).toBe(true);
    expect(shouldRetire({resume:1},false,{reuseField:1},true)).toBe(false);
    expect(shouldRetire({resume:0},true,{reuseField:1},true)).toBe(false);
    expect(()=>continuationEntry(shader.replace('if (skipKnown) {','if (skipKnown && true) {'))).toThrow('entry');
  });
});
