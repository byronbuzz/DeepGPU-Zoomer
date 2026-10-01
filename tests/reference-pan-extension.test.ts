import {describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {WebGpuRenderer,Method,approximationDeltaBound,type RenderRequest} from '../src/render/webgpu-renderer';
import {generatePackedReference,type ReferenceOrbitInput,type ReferenceResumeState} from '../src/render/reference-orbit';
import {prepareReference} from '../src/render/reference-preparation';
import {DEFAULT_COLORS} from '../src/logic/colorSettings';
import {DEFAULT_TUNING} from '../src/tuning';

Decimal.set({precision:240});
const initial:ReferenceOrbitInput={family:'mandelbrot',centerX:'-0.1',centerY:'0.2',juliaX:'0',juliaY:'0',limbs:8,maxIterations:13};
function fixture(){
  const first=generatePackedReference(initial);
  const request:RenderRequest={family:'mandelbrot',centerX:new Decimal('-0.09999'),centerY:new Decimal('0.2'),
    unitsPerPixel:new Decimal('1e-6'),width:64,height:64,maxIterations:27,
    forceMethod:Method.Hdr,useApprox:true,colors:{...DEFAULT_COLORS,supersample:1},tuning:{...DEFAULT_TUNING},
    followView:true,workView:true,isCurrent:()=>true};
  const owner:any=Object.assign(Object.create(WebGpuRenderer.prototype),{
    ctx:{device:{limits:{maxStorageBufferBindingSize:256*1024*1024,maxBufferSize:256*1024*1024,maxTextureDimension2D:8192}}},
    refValid:true,refEscaped:false,refFamily:'mandelbrot',refConstant:'',refLimbs:8,refIterations:13,
    refX:new Decimal(initial.centerX),refY:new Decimal(initial.centerY),
    refSamples:new Float32Array(first.buffer),refTerminal:first.terminal,
    refFormatVersion:first.formatVersion,refSampleWords:first.sampleWords,refLength:first.length,
  });
  return {owner,request,first};
}
function prepare(owner:any,demand:any,check=()=>{}){
  const calls:{input:ReferenceOrbitInput;resume?:ReferenceResumeState}[]=[];
  const result=prepareReference(demand.input,async(input,resume)=>{
    calls.push({input,resume});return generatePackedReference(input,undefined,resume,7);
  },check,{samples:owner.refSamples,terminal:owner.refTerminal,formatVersion:owner.refFormatVersion,sampleWords:owner.refSampleWords});
  return {calls,result};
}

describe('cap extension after compatible camera motion',()=>{
  it('extends the admitted trajectory by its missing suffix while keeping camera ownership separate',async()=>{
    const {owner,request,first}=fixture(),demand=owner.referenceDemand(request,8);
    expect(demand.centerX.eq(request.centerX)).toBe(true);
    expect(demand.referenceX.eq(initial.centerX)).toBe(true);
    expect(demand.input.centerX).toBe(initial.centerX);
    const {calls,result}=prepare(owner,demand),next=await result;
    expect(calls[0].resume).toBe(first.terminal);
    expect(next.iterationsComputed).toBe(14);
    const complete=generatePackedReference({...initial,maxIterations:27});
    expect(next.samples).toEqual(new Float32Array(complete.buffer));
    expect(next.terminal).toEqual(complete.terminal);
    expect(owner.refTerminal).toBe(first.terminal);
    expect(owner.refSamples).toEqual(new Float32Array(first.buffer));
  });

  it('starts a new trajectory when the camera leaves the admitted reuse bound',async()=>{
    const {owner,request}=fixture();request.centerX=new Decimal('-0.09998');
    const demand=owner.referenceDemand(request,8),{calls,result}=prepare(owner,demand),next=await result;
    expect(demand.referenceX.eq(request.centerX)).toBe(true);
    expect(calls[0].resume).toBeUndefined();expect(next.iterationsComputed).toBe(27);
    expect(next.terminal.identity).not.toBe(owner.refTerminal.identity);
  });

  it('checks later camera motion against the retained reference, not the extension-request camera',()=>{
    const {owner,request}=fixture(),demand=owner.referenceDemand(request,8);
    expect(owner.referenceDemandCompatible(demand,request)).toBe(true);
    const moved={...request,centerX:new Decimal('-0.099979')};
    // 11 pixels from the extension camera, but 21 from the actual reference;
    // the existing L1 reuse allowance for this viewport is only 16 pixels.
    expect(owner.referenceDemandCompatible(demand,moved)).toBe(false);
  });

  it.each(['family','precision','terminal-identity','same-budget'] as const)('does not alias another reference identity: %s',reason=>{
    const {owner,request}=fixture();let limbs=8;
    if(reason==='family')request.family='julia';
    if(reason==='precision')limbs=16;
    if(reason==='terminal-identity')owner.refTerminal={...owner.refTerminal,identity:'different trajectory'};
    if(reason==='same-budget')request.maxIterations=13;
    const demand=owner.referenceDemand(request,limbs);
    expect(demand.referenceX.eq(request.centerX)).toBe(true);
  });

  it('extends a matching Julia initial point, but not a changed Julia constant',async()=>{
    const {owner,request}=fixture();
    const juliaInput={...initial,family:'julia' as const,juliaX:'-0.1',juliaY:'0.2'};
    const first=generatePackedReference(juliaInput);
    Object.assign(owner,{refFamily:'julia',refConstant:'-0.1,0.2',refSamples:new Float32Array(first.buffer),
      refTerminal:first.terminal,refSampleWords:first.sampleWords});
    Object.assign(request,{family:'julia',juliaX:new Decimal('-0.1'),juliaY:new Decimal('0.2')});
    const demand=owner.referenceDemand(request,8),next=await prepare(owner,demand).result;
    expect(demand.referenceX.toString()).toBe(initial.centerX);
    expect(next.iterationsComputed).toBe(14);
    expect(next.samples).toEqual(new Float32Array(generatePackedReference({...juliaInput,maxIterations:27}).buffer));
    request.juliaX=new Decimal('-0.2');
    expect(owner.referenceDemand(request,8).referenceX.eq(request.centerX)).toBe(true);
  });

  it('captures coordinates and rejects cancellation without modifying the admitted prefix',async()=>{
    const {owner,request,first}=fixture(),prefix=owner.refSamples,demand=owner.referenceDemand(request,8);
    request.centerX=new Decimal('0.9');
    expect(demand.input.centerX).toBe(initial.centerX);
    expect(demand.centerX.toString()).toBe('-0.09999');
    let checks=0;
    const {result}=prepare(owner,demand,()=>{if(++checks===2)throw new DOMException('canceled extension','AbortError');});
    await expect(result).rejects.toMatchObject({name:'AbortError'});
    expect(owner.refSamples).toBe(prefix);expect(owner.refTerminal).toBe(first.terminal);
    expect(owner.refX.toString()).toBe(initial.centerX);expect(owner.refIterations).toBe(13);
  });

  it('commits the actual orbit origin before building its new BLA domain',async()=>{
    const {owner,request}=fixture(),stop=new Error('stop after reference admission');
    Object.assign(owner,{batchFeedback:{enterTarget:()=>{}},publicationEpoch:0,disposed:false,deviceLost:false,
      numericalQuadratic:null,cachedRequest:'',currentView:request,pendingRetain:Promise.resolve(),
      directPipeline:{},shadePipeline:{},reusePipeline:{},blitPipeline:{},
      validateCoordinates:()=>{},recolorCompleted:async()=>null,beginAppearanceHold:()=>false,
      convertDistanceToIteration:async()=>false});
    owner.generateOrbit=async(q:RenderRequest,limbs:number)=>{
      const demand=owner.referenceDemand(q,limbs),prepared=await prepare(owner,demand).result;
      return {...prepared,ms:1,referenceX:demand.referenceX,referenceY:demand.referenceY};
    };
    owner.buildApproxTable=vi.fn(async()=>{
      expect(owner.refX.toString()).toBe(initial.centerX);
      expect(owner.refY.toString()).toBe(initial.centerY);
      expect(owner.refTerminal.identity).toBe(generatePackedReference({...initial,maxIterations:27}).terminal.identity);
      const actual=approximationDeltaBound('mandelbrot',request,owner.refX,owner.refY);
      const incorrectlyRecentered=approximationDeltaBound('mandelbrot',request,request.centerX,request.centerY);
      expect(actual.gt(incorrectlyRecentered)).toBe(true);
      throw stop;
    });
    await expect(owner.renderTarget(request)).rejects.toBe(stop);
    expect(owner.buildApproxTable).toHaveBeenCalledOnce();expect(owner.refIterations).toBe(27);
  });
});
