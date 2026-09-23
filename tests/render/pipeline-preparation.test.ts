import Decimal from 'decimal.js';
import {describe,expect,it,vi} from 'vitest';
import {DEFAULT_COLORS} from '../../src/logic/colorSettings';
import {approximationDeltaBound,limbsForScale,WebGpuRenderer} from '../../src/render/webgpu-renderer';

function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const request=()=>({family:'mandelbrot',centerX:new Decimal(0),centerY:new Decimal(0),
  unitsPerPixel:new Decimal('1e-30'),width:32,height:24,maxIterations:100,
  colors:{...DEFAULT_COLORS,mode:0},isCurrent:()=>true});
const limits={maxStorageBufferBindingSize:1e8,maxBufferSize:1e8,maxTextureDimension2D:8192};

describe('demand-specific pipeline preparation',()=>{
  it.each([
    ['mandelbrot','1e-1000',2,true,true],
    ['mandelbrot','1e-2400',2,true,true],
    ['mandelbrot','2e-324',2,true,true],
    ['mandelbrot','1e-2400',0.5,true,false],
    ['mandelbrot','1e-2400',0.5,false,true],
    ['julia','1e-2400',2,true,false],
  ] as const)('retains %s table-domain decisions at %s (scale %s, usable %s)',async(family,span,scale,usable,rebuild)=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype);
    const original={...request(),family,unitsPerPixel:new Decimal(span),useApprox:true};
    const r={...original,unitsPerPixel:original.unitsPerPixel.times(scale)};
    const build=vi.fn(async()=>{renderer.tableMaxDelta=approximationDeltaBound(family,r,r.centerX,r.centerY);renderer.laHasUsableMultiStep=true;});
    Object.assign(renderer,{ctx:{device:{limits}},publicationEpoch:0,directPipeline:{},shadePipeline:{},reusePipeline:{},blitPipeline:{},
      recolorCompleted:async()=>null,beginAppearanceHold:()=>false,convertDistanceToIteration:async()=>false,
      refValid:true,refX:r.centerX,refY:r.centerY,refFamily:family,refConstant:family==='julia'?'undefined,undefined':'',
      refLimbs:limbsForScale(r.unitsPerPixel,96),refIterations:100,
      tableMaxDelta:approximationDeltaBound(family,original,r.centerX,r.centerY),laHasUsableMultiStep:usable,laLevels:2,
      buildApproxTable:build,ensureOrbitCapacity:()=>{},laBuffer:{},laIndexBuffer:{},
      ensureComputePipeline:()=>Promise.resolve({}),ensureTarget:()=>{throw new Error('resource boundary');}});
    await expect(renderer.renderTarget(r)).rejects.toThrow('resource boundary');
    expect(build).toHaveBeenCalledTimes(rebuild?1:0);
  });

  it('starts decoding preparation before dispatching the worker and keeps a current preparation failure visible',async()=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype),worker=deferred<any>(),decode=deferred<any>();
    const events:string[]=[];
    Object.assign(renderer,{ctx:{device:{limits}},referenceDemandCompatible:()=>true,
      referenceWorker:{generate:()=>{events.push('worker');return worker.promise;}},
      ensureComputePipeline:(kind:string)=>{events.push(kind);return kind==='decode'?decode.promise:Promise.resolve({});}});
    const result=renderer.generateOrbit(request(),16);
    const observed=expect(result).rejects.toThrow('decode failed');
    expect(events.indexOf('decode')).toBeLessThan(events.indexOf('worker'));
    decode.reject(new Error('decode failed'));
    // Preparation can reject while CPU work is still outstanding.
    await new Promise(resolve=>setTimeout(resolve,0));
    worker.resolve({length:1,buffer:new Float32Array(20).buffer});
    await observed;
    expect(renderer.pendingReferenceDemand).toBeNull();
  });

  it('observes preparation rejection even if an obsolete worker exits before the preparation await',async()=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype),worker=deferred<any>(),decode=deferred<any>();
    Object.assign(renderer,{ctx:{device:{limits}},referenceDemandCompatible:()=>true,
      referenceWorker:{generate:()=>worker.promise},
      ensureComputePipeline:(kind:string)=>kind==='decode'?decode.promise:Promise.resolve({})});
    const result=renderer.generateOrbit({...request(),isCurrent:()=>false},16);
    const observed=expect(result).rejects.toMatchObject({name:'AbortError'});
    worker.resolve({length:1,buffer:new Float32Array(20).buffer});await observed;
    decode.reject(new Error('late decode failure'));
    await new Promise(resolve=>setTimeout(resolve,0));
  });

  it('deduplicates overlapping preparation and reuses a warm successful pipeline',async()=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype),built=deferred<any>(),pipeline={};
    const createComputePipelineAsync=vi.fn(()=>built.promise);
    Object.assign(renderer,{ctx:{device:{createComputePipelineAsync}},renderModule:{},pendingPipelines:new Map()});
    const a=renderer.ensureComputePipeline('decode'),b=renderer.ensureComputePipeline('decode');
    expect(createComputePipelineAsync).toHaveBeenCalledOnce();
    built.resolve(pipeline);
    expect(await a).toBe(pipeline);expect(await b).toBe(pipeline);
    expect(await renderer.ensureComputePipeline('decode')).toBe(pipeline);
    expect(createComputePipelineAsync).toHaveBeenCalledOnce();
  });

  it.each([
    ['mandelbrot',false,'plain'],['mandelbrot',true,'approx'],
    ['julia',false,'julia'],['julia',true,'juliaApprox'],
  ])('prepares only the selected %s/%s variant before resource validation',async(family,approx,kind)=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype),r={...request(),family,useApprox:true};
    const events:string[]=[];
    Object.assign(renderer,{ctx:{device:{limits}},publicationEpoch:0,directPipeline:{},shadePipeline:{},reusePipeline:{},blitPipeline:{},
      recolorCompleted:async()=>null,beginAppearanceHold:()=>false,convertDistanceToIteration:async()=>false,
      refValid:true,refX:r.centerX,refY:r.centerY,refFamily:family,refConstant:family==='julia'?'undefined,undefined':'',
      refLimbs:limbsForScale(r.unitsPerPixel,96),refIterations:100,tableMaxDelta:new Decimal(100),laHasUsableMultiStep:approx,laLevels:2,
      buildApproxTable:async()=>{events.push('table');},ensureOrbitCapacity:()=>{},laBuffer:{},laIndexBuffer:{},
      ensureComputePipeline:(selected:string)=>{events.push(selected);return Promise.reject(new Error('prepared pipeline failure'));},
      ensureTarget:async()=>{events.push('target');await new Promise(resolve=>setTimeout(resolve,0));throw new Error('resource boundary');}});
    await expect(renderer.renderTarget(r)).rejects.toThrow('resource boundary');
    expect(events.filter(event=>event!=='table')).toEqual([kind,'target']);
    if(events.includes('table'))expect(events.indexOf('table')).toBeLessThan(events.indexOf(kind as string));
  });
});
