import {afterEach,describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {WebGpuRenderer,approximationDeltaBound,type RenderRequest} from '../src/render/webgpu-renderer';
import {generatePackedReference} from '../src/render/reference-orbit';
import {buildBla} from '../src/render/bla';
import {REFERENCE_TRANSFER_FLOATS} from '../src/render/reference-preparation';
import {DEFAULT_TUNING} from '../src/tuning';

afterEach(()=>vi.unstubAllGlobals());

function setup(family:'mandelbrot'|'julia',failure?:'abort'|'validation'|'tolerance'){
  vi.stubGlobal('GPUBufferUsage',{STORAGE:128,COPY_DST:8});
  const orbit=generatePackedReference({family,centerX:'-.1',centerY:'.1',juliaX:'-.1',juliaY:'.1',limbs:8,maxIterations:110_000});
  const request={family,centerX:new Decimal('-.1'),centerY:new Decimal('.1'),unitsPerPixel:new Decimal('1e-20'),
    width:1,height:1,colors:{mode:0},tuning:{blaChunkMs:0},isCurrent:()=>true} as unknown as RenderRequest;
  const oldTable={destroy:vi.fn()},oldIndex={destroy:vi.fn()};
  const created:any[]=[];const writes:{label:string;offset:number;bytes:number}[]=[];
  let validationFailure=false;
  const owner:any=Object.assign(Object.create(WebGpuRenderer.prototype),{refSamples:new Float32Array(orbit.buffer),refLength:orbit.length,refSampleWords:orbit.sampleWords,refX:request.centerX,refY:request.centerY,
    orbitBuffer:{},wantsQuadratic:()=>false,requireLiveMethod:()=>{},disposed:false,abortRequested:false,
    laBuffer:oldTable,laIndexBuffer:oldIndex,laLevels:3,laHasUsableMultiStep:false,
    tableMaxDelta:new Decimal(-1),tableQuadratic:false,tableEpsilonLog2:-16,tableMs:17,deferredBlaRetry:true,
    referencePreparationTimings:{},pendingContinuation:{clear:vi.fn()}});
  owner.ctx={device:{limits:{maxStorageBufferBindingSize:256*1024*1024,maxBufferSize:256*1024*1024},
    pushErrorScope:()=>{},popErrorScope:async()=>{if(validationFailure){validationFailure=false;return {message:'synthetic upload failure'};}return null;},
    createBuffer:({size,label}:{size:number;label:string})=>{const result={label,data:new Uint8Array(size),destroy:vi.fn()};created.push(result);return result;},
    queue:{writeBuffer:(buffer:any,offset:number,source:ArrayBufferView)=>{
      writes.push({label:buffer.label,offset,bytes:source.byteLength});
      buffer.data.set(new Uint8Array(source.buffer,source.byteOffset,source.byteLength),offset);
      if(buffer.label==='la-table'){
        if(failure==='abort')owner.abortRequested=true;
        if(failure==='validation')validationFailure=true;
        if(failure==='tolerance')owner.currentView={...request,tuning:{...DEFAULT_TUNING,blaPrecisionLog2:-23}};
      }
    }}}};
  return {owner,request,created,writes,oldTable,oldIndex};
}

const build=(WebGpuRenderer.prototype as unknown as {buildApproxTable(request:RenderRequest):Promise<void>}).buildApproxTable;

describe('bounded approximation table upload',()=>{
  it('uses family-specific decoded capacity without silently truncating a requested cap',()=>{
    const budget=(WebGpuRenderer.prototype as unknown as {referenceBudget(max:number,dynamic:boolean,family:'mandelbrot'|'julia'):number}).referenceBudget;
    const owner={ctx:{device:{limits:{maxStorageBufferBindingSize:9600,maxBufferSize:9600}}}};
    expect(budget.call(owner,80,true,'mandelbrot')).toBe(128);
    expect(budget.call(owner,80,true,'julia')).toBe(99);
    expect(budget.call(owner,250,false,'mandelbrot')).toBe(250);
    expect(budget.call(owner,250,false,'julia')).toBe(250);
  });
  it.each(['mandelbrot','julia'] as const)('uploads every %s table bit through bounded views',async family=>{
    const fixture=setup(family),{owner,request}=fixture;
    const expected=buildBla(owner.refSamples,owner.refLength,approximationDeltaBound(family,request,owner.refX,owner.refY),
      {sampleWords:owner.refSampleWords,epsilonLog2:family==='julia'?-40:DEFAULT_TUNING.blaPrecisionLog2,omitSingleStep:true});
    await build.call(owner,request);
    const uploaded=new Uint32Array(owner.laBuffer.data.buffer);
    const bits=new Uint32Array(expected.data.buffer);
    expect(uploaded.length).toBe(bits.length);expect(uploaded.every((value,index)=>value===bits[index])).toBe(true);
    const dataWrites=fixture.writes.filter(write=>write.label==='la-table');
    expect(dataWrites.length).toBeGreaterThan(1);
    expect(Math.max(...dataWrites.map(write=>write.bytes))).toBeLessThanOrEqual(REFERENCE_TRANSFER_FLOATS*4);
    expect(dataWrites.reduce((sum,write)=>sum+write.bytes,0)).toBe(expected.data.byteLength);
    expect(owner.referencePreparationTimings.tableCopyCpuMs).toBe(0);
    expect(fixture.oldTable.destroy).toHaveBeenCalledOnce();expect(fixture.oldIndex.destroy).toHaveBeenCalledOnce();
    expect(owner.pendingContinuation.clear).toHaveBeenCalledOnce();
  });

  it.each(['abort','validation'] as const)('keeps the prior admitted table after %s during upload',async failure=>{
    const {owner,request,oldTable,oldIndex,created}=setup('mandelbrot',failure);
    await expect(build.call(owner,request)).rejects.toThrow(failure==='abort'?'Superseded table':'synthetic upload failure');
    expect(owner.laBuffer).toBe(oldTable);expect(owner.laIndexBuffer).toBe(oldIndex);
    expect(oldTable.destroy).not.toHaveBeenCalled();expect(oldIndex.destroy).not.toHaveBeenCalled();
    expect(owner.pendingContinuation.clear).not.toHaveBeenCalled();
    expect(owner.laLevels).toBe(3);expect(owner.tableMaxDelta.eq(-1)).toBe(true);expect(owner.tableMs).toBe(17);
    expect(created).toHaveLength(2);for(const buffer of created)expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it.each([-32,-23,-16,-14])('uploads the selected Mandelbrot precision %s without changing its reference',async epsilon=>{
    const {owner,request}=setup('mandelbrot');request.tuning={...DEFAULT_TUNING,blaPrecisionLog2:epsilon};
    const reference=owner.refSamples,orbit=owner.orbitBuffer;
    const expected=buildBla(reference,owner.refLength,approximationDeltaBound('mandelbrot',request,owner.refX,owner.refY),
      {sampleWords:owner.refSampleWords,epsilonLog2:epsilon,omitSingleStep:true});
    await build.call(owner,request);
    expect(new Uint32Array(owner.laBuffer.data.buffer)).toEqual(new Uint32Array(expected.data.buffer));
    expect(owner.tableEpsilonLog2).toBe(epsilon);expect(owner.refSamples).toBe(reference);expect(owner.orbitBuffer).toBe(orbit);
  });

  it('does not admit or relabel a table when live tolerance changes during upload',async()=>{
    const {owner,request,oldTable,oldIndex,created}=setup('mandelbrot','tolerance');
    Object.assign(request,{tuning:{...DEFAULT_TUNING},followView:true,workView:true,useApprox:true});
    owner.currentView=request;owner.requireLiveMethod=(WebGpuRenderer.prototype as any).requireLiveMethod;
    await expect(build.call(owner,request)).rejects.toThrow();
    expect(owner.laBuffer).toBe(oldTable);expect(owner.laIndexBuffer).toBe(oldIndex);
    expect(owner.tableEpsilonLog2).toBe(-16);expect(owner.laLevels).toBe(3);
    expect(oldTable.destroy).not.toHaveBeenCalled();expect(oldIndex.destroy).not.toHaveBeenCalled();
    expect(owner.pendingContinuation.clear).not.toHaveBeenCalled();
    expect(created).toHaveLength(2);for(const buffer of created)expect(buffer.destroy).toHaveBeenCalledOnce();
  });
});
