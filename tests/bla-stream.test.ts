import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import Decimal from 'decimal.js';
import {buildBla,buildBlaAsync} from '../src/render/bla';
import {cases,syntheticOrbit} from './bla-stream-fixtures';
import goldens from './bla-stream-goldens.json';

const hash=(data:ArrayBufferView)=>createHash('sha256').update(new Uint8Array(data.buffer,data.byteOffset,data.byteLength)).digest('hex');

describe('streamed full-precision BLA levels',()=>{
  it.each(cases)('matches frozen packed bytes and metadata: $name',test=>{
    const orbit=syntheticOrbit(test.length,test.words),before=hash(orbit);
    const {data,...metadata}=buildBla(orbit,test.length,new Decimal(test.radius),{...test.options,sampleWords:test.words});
    const expected=goldens.find(golden=>golden.name===test.name)!;
    expect(hash(data)).toBe(expected.sha256);
    const {name:_,sha256:__,...expectedMetadata}=expected;
    expect(metadata).toEqual(expectedMetadata);expect(hash(orbit)).toBe(before);
  });

  it('yields during preparation and produces identical sync and async transport',async()=>{
    const test=cases.find(test=>test.name==='larger-compact')!;
    const orbit=syntheticOrbit(test.length,test.words);let checkpoints=0;
    const result=await buildBlaAsync(orbit,test.length,new Decimal(test.radius),async()=>{checkpoints++;},
      {...test.options,sampleWords:test.words});
    expect(checkpoints).toBeGreaterThan(10);
    expect(hash(result.data)).toBe(goldens.find(golden=>golden.name===test.name)!.sha256);
  });

  it.each([1,4,8])('stops at cancellation checkpoint %i without changing source samples',async stopAt=>{
    const orbit=syntheticOrbit(8195,10),before=hash(orbit);let checkpoints=0;
    await expect(buildBlaAsync(orbit,8195,new Decimal('1e-90'),async()=>{
      if(++checkpoints===stopAt)throw new DOMException('canceled preparation','AbortError');
    },{sampleWords:10,omitSingleStep:true})).rejects.toMatchObject({name:'AbortError'});
    expect(checkpoints).toBe(stopAt);expect(hash(orbit)).toBe(before);
  });
});
