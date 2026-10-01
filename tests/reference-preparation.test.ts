import {describe, expect, it, vi} from 'vitest';
import {generatePackedReference, type PackedReferenceOrbit, type ReferenceOrbitInput} from '../src/render/reference-orbit';
import {prepareReference, referenceDecodeDispatch, REFERENCE_TRANSFER_FLOATS} from '../src/render/reference-preparation';

const input:ReferenceOrbitInput={family:'mandelbrot',centerX:'-.1',centerY:'.1',juliaX:'0',juliaY:'0',limbs:8,maxIterations:513};
const check=()=>{};
describe('bounded reference preparation',()=>{
  it('assembles the identical original trajectory and extends only the missing suffix',async()=>{
    const generate=async(q:ReferenceOrbitInput,resume?:Parameters<typeof generatePackedReference>[2])=>generatePackedReference(q,undefined,resume,73);
    const first=await prepareReference(input,generate,check);
    expect(first.samples).toEqual(new Float32Array(generatePackedReference(input).buffer));
    const extendedInput={...input,maxIterations:700};
    const extended=await prepareReference(extendedInput,generate,check,first);
    expect(extended.iterationsComputed).toBe(187);
    expect(extended.samples).toEqual(new Float32Array(generatePackedReference(extendedInput).buffer));
  });
  it('does not reuse a checkpoint across a different parameter',async()=>{
    const generate=async(q:ReferenceOrbitInput,resume?:Parameters<typeof generatePackedReference>[2])=>generatePackedReference(q,undefined,resume,73);
    const first=await prepareReference(input,generate,check);
    const next={...input,centerY:'.11'};
    const rebuilt=await prepareReference(next,generate,check,first);
    expect(rebuilt.iterationsComputed).toBe(input.maxIterations);
    expect(rebuilt.samples).toEqual(new Float32Array(generatePackedReference(next).buffer));
  });
  it('rejects a superseded suffix before publishing it',async()=>{
    let cancelled=false;
    const generate=async(q:ReferenceOrbitInput)=>{const chunk=generatePackedReference(q,undefined,undefined,32);cancelled=true;return chunk;};
    await expect(prepareReference(input,generate,()=>{if(cancelled)throw new DOMException('superseded','AbortError');})).rejects.toMatchObject({name:'AbortError'});
  });
  it('rejects a missing or mislabelled prefix',async()=>{
    const generate=async(q:ReferenceOrbitInput)=>({...generatePackedReference(q,undefined,undefined,32),startIndex:1});
    await expect(prepareReference(input,generate,check)).rejects.toThrow('incompatible suffix');
  });
  it.each([{formatVersion:1},{formatVersion:undefined},{sampleWords:20},{sampleWords:undefined}])('rejects incompatible packet metadata %j',async changed=>{
    const generate=async(q:ReferenceOrbitInput)=>({...generatePackedReference(q),...changed}) as PackedReferenceOrbit;
    await expect(prepareReference(input,generate,check)).rejects.toThrow('incompatible suffix');
  });
  it('regenerates a cached prefix whose packet version or stride does not match',async()=>{
    const generate=async(q:ReferenceOrbitInput,resume?:Parameters<typeof generatePackedReference>[2])=>generatePackedReference(q,undefined,resume,73);
    const first=await prepareReference(input,generate,check);
    for(const changed of [{formatVersion:1},{sampleWords:20}]){
      const previous={...first,...changed} as typeof first;
      const regenerated=await prepareReference(input,generate,check,previous);
      expect(regenerated.iterationsComputed).toBe(input.maxIterations);
      expect(regenerated.samples).toEqual(first.samples);
    }
  });
  it('reuses an already escaped reference without new work',async()=>{
    const q={...input,centerX:'2',centerY:'2'};
    const generate=async(q:ReferenceOrbitInput)=>generatePackedReference(q);
    const first=await prepareReference(q,generate,check);
    const next=await prepareReference({...q,maxIterations:10_000_000},async()=>{throw Error('unexpected generation');},check,first);
    expect(next.escaped).toBe(true);expect(next.iterationsComputed).toBe(0);expect(next.samples).toBe(first.samples);
  });
  it('bounds copies of a large reusable prefix and keeps every transported bit',async()=>{
    const q={...input,maxIterations:110_000};
    const generate=async(q:ReferenceOrbitInput,resume?:Parameters<typeof generatePackedReference>[2])=>generatePackedReference(q,undefined,resume);
    const first=await prepareReference(q,generate,check);
    const nextInput={...q,maxIterations:q.maxIterations+1};
    const expected=new Uint32Array(generatePackedReference(nextInput).buffer);
    const copiedLengths:number[]=[];
    const originalSet=Float32Array.prototype.set;
    const set=vi.spyOn(Float32Array.prototype,'set').mockImplementation(function(this:Float32Array,source:ArrayLike<number>,offset?:number){
      copiedLengths.push(source.length);return originalSet.call(this,source,offset);
    });
    const checkpoint=vi.fn(async()=>{});
    try{
      const next=await prepareReference(nextInput,generate,check,first,checkpoint);
      const actual=new Uint32Array(next.samples.buffer);
      expect(actual.length).toBe(expected.length);
      expect(actual.every((value,index)=>value===expected[index])).toBe(true);
      expect(Math.max(...copiedLengths)).toBeLessThanOrEqual(REFERENCE_TRANSFER_FLOATS);
      expect(next.timings.concatSlices).toBe(copiedLengths.length);
      expect(checkpoint).toHaveBeenCalledTimes(copiedLengths.length-1);
      expect(next.iterationsComputed).toBe(1);
    }finally{set.mockRestore();}
  });
  it('checks cancellation between copy slices before publishing an extension',async()=>{
    const q={...input,maxIterations:110_000};
    const generate=async(q:ReferenceOrbitInput,resume?:Parameters<typeof generatePackedReference>[2])=>generatePackedReference(q,undefined,resume);
    const first=await prepareReference(q,generate,check);
    const original=first.samples,terminal={...first.terminal};let cancelled=false;
    await expect(prepareReference({...q,maxIterations:q.maxIterations+1},generate,
      ()=>{if(cancelled)throw new DOMException('superseded during copy','AbortError');},first,
      async()=>{cancelled=true;})).rejects.toMatchObject({name:'AbortError'});
    expect(first.samples).toBe(original);expect(first.terminal).toEqual(terminal);
  });
});
describe('long reference decode dispatch',()=>{
  it.each([1,64,65,4_194_240,4_194_241,10_000_001,20_000_002])('covers %i reference components once using bounded axes',count=>{
    const [x,y]=referenceDecodeDispatch(count,65535);
    expect(x).toBeLessThanOrEqual(65535);expect(y).toBeLessThanOrEqual(65535);
    expect(x*y*64).toBeGreaterThanOrEqual(count);
    // The next row starts immediately after all invocations in the prior row.
    expect(x*64).toBe((x-1)*64+63+1);
  });
  it('refuses a grid that cannot fit',()=>expect(()=>referenceDecodeDispatch(257,2)).toThrow('capacity'));
});
