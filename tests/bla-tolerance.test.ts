import {describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {WebGpuRenderer,Method,appearanceUpgradeCompatible,blaTableEpsilon,linearBlaPolicy,
  type RenderRequest} from '../src/render/webgpu-renderer';
import {DEFAULT_COLORS} from '../src/logic/colorSettings';
import {DEFAULT_TUNING,loadTuning,saveTuning,normalizeTuning,modifiedTuningCount} from '../src/tuning';
import {RANGE_DEFAULTS} from '../src/range-controls';
import {snapshotExportRequest} from '../src/export/render';
import {PendingContinuationSlot} from '../src/render/pending-continuation';

const request=(epsilon=-16,extra:Partial<RenderRequest>={}):RenderRequest=>({
  centerX:new Decimal('-.7'),centerY:new Decimal('.1'),unitsPerPixel:new Decimal('1e-20'),
  width:64,height:64,maxIterations:10000,family:'mandelbrot',useApprox:true,forceMethod:Method.Hdr,
  colors:{...DEFAULT_COLORS,mode:0,capped:0,effect:0,supersample:1,postAntialias:false},
  tuning:{...DEFAULT_TUNING,blaPrecisionLog2:epsilon},followView:true,workView:true,isCurrent:()=>true,...extra,
});
function owner(q=request()):any{
  const method=q.forceMethod??Method.Hdr,frame={...q,useApprox:q.useApprox===true,method,grid:1,proxy:false};
  return Object.assign(Object.create(WebGpuRenderer.prototype),{
    ctx:{device:{limits:{maxStorageBufferBindingSize:256*1024*1024,maxBufferSize:256*1024*1024,maxTextureDimension2D:8192}}},
    publicationEpoch:1,refLength:10001,refLimbs:8,refSamples:{},orbitBuffer:{},laBuffer:{},laIndexBuffer:{},
    fieldView:q,fieldComplete:true,currentImageValid:true,currentView:q,completedFrame:frame,
    historyValid:true,fieldUniforms:new ArrayBuffer(416),fieldStats:{},target:{},fieldBuffer:{},endpointBuffer:{},
    retainEndpoints:false,fieldKey:'complete',
    fieldDescriptor:{family:q.family,constant:q.family==='julia'?`${q.juliaX},${q.juliaY}`:'',maxIterations:q.maxIterations,
      mode:q.colors.mode,grid:1,method,useApprox:q.useApprox===true,retainEndpoints:false,interiorEndpoints:false,
      linearBlaEpsilon:linearBlaPolicy(q,method)},
  });
}
const sampleKey=(r:any,q:RenderRequest)=>r.sampleIdentity(q,q.family??'mandelbrot','',q.forceMethod??Method.Hdr,1,8,20);
const fieldKey=(r:any,q:RenderRequest)=>r.fieldIdentity(q,q.family??'mandelbrot','',q.forceMethod??Method.Hdr,1,false,20);

describe('Mandelbrot linear BLA precision control',()=>{
  it('keeps the common default and full precision range through normalization and local persistence',()=>{
    expect(DEFAULT_TUNING.blaPrecisionLog2).toBe(-14);
    expect(RANGE_DEFAULTS['tuning-bla-epsilon']).toBe(14);
    expect(normalizeTuning({}).blaPrecisionLog2).toBe(-14);
    for(const epsilon of [-24,-23,-21,-16,-15,-14]){
      const tuning=normalizeTuning({blaPrecisionLog2:epsilon});
      expect(tuning.blaPrecisionLog2).toBe(epsilon);
      expect(tuning.directExponent).toBe(14.75);expect(tuning.hardPixelBudget).toBe(0);
      const storage=new Map<string,string>();
      expect(saveTuning(tuning,{setItem:(key,value)=>{storage.set(key,value);}})).toBe(true);
      expect(loadTuning({getItem:key=>storage.get(key)??null}).blaPrecisionLog2).toBe(epsilon);
      expect(modifiedTuningCount(tuning)).toBe(epsilon===-14?0:1);
    }
    expect(normalizeTuning({blaPrecisionLog2:-100}).blaPrecisionLog2).toBe(-24);
    expect(normalizeTuning({blaPrecisionLog2:3}).blaPrecisionLog2).toBe(-14);
    expect(normalizeTuning({blaPrecisionLog2:NaN}).blaPrecisionLog2).toBe(-14);
  });

  it('ignores both removed controls while preserving unrelated saved tuning',()=>{
    const legacy={blaEpsilonLog2:-30,blaZoomEpsilonLog2:-1,pointerWeight:7,dynamicDepthGain:7500};
    const normalized=normalizeTuning(legacy);
    expect(normalized).toMatchObject({blaPrecisionLog2:-14,pointerPriority:1,pointerWeight:2,distributedWeight:1,oldestWeight:1,dynamicDepthGain:7500});
    expect(normalized).not.toHaveProperty('blaEpsilonLog2');expect(normalized).not.toHaveProperty('blaZoomEpsilonLog2');
    const restored=loadTuning({getItem:key=>key==='gpu-zoomer-navigation-tuning-v3'?JSON.stringify({version:3,settings:legacy}):null});
    expect(restored).toMatchObject({blaPrecisionLog2:-14,pointerPriority:1,pointerWeight:2,distributedWeight:1,oldestWeight:1,dynamicDepthGain:7500});
    expect(normalizeTuning({...legacy,blaPrecisionLog2:-24}).blaPrecisionLog2).toBe(-24);
  });

  it('keeps the fixed Julia and quadratic tolerances independent of this control',()=>{
    for(const epsilon of [-24,-23,-16,-14]){
      expect(blaTableEpsilon(request(epsilon))).toBe(epsilon);
      expect(blaTableEpsilon(request(epsilon,{family:'julia'}))).toBe(-40);
      expect(blaTableEpsilon(request(epsilon),true)).toBe(-29);
      expect(blaTableEpsilon(request(epsilon,{family:'julia'}),true)).toBe(-29);
    }
  });

  it('does not reuse completed, retained, appearance or cap-upgrade fields from another tolerance',async()=>{
    const before=request(),after=request(-23),r=owner(before);
    expect(sampleKey(r,before)).not.toBe(sampleKey(r,after));
    expect(fieldKey(r,before)).not.toBe(fieldKey(r,after));
    expect(r.isComplete(before)).toBe(true);expect(r.isComplete(after)).toBe(false);
    expect(r.samePresentation(r.completedFrame,after)).toBe(false);
    expect(r.stalePresentationCompatible(r.completedFrame,after)).toBe(false);
    expect(r.fieldSupportsAppearance(after,Method.Hdr,1)).toBe(false);
    expect(r.appearanceCompatible(before,after,Method.Hdr,1,false)).toBe(false);
    expect(appearanceUpgradeCompatible(r.completedFrame,after,Method.Hdr,1)).toBe(false);
    expect(r.capUpgradeBase({...after,dynamicIterations:true,maxIterations:11000})).toBeNull();
    r.fieldDescriptor={...r.fieldDescriptor,mode:1,retainEndpoints:true};r.retainEndpoints=true;
    expect(await r.convertDistanceToIteration(after,Method.Hdr,1)).toBe(false);
  });

  it.each(['direct','no-approximation','julia','quadratic'] as const)('does not change %s numerical identity',kind=>{
    const extra:Partial<RenderRequest>=kind==='direct'?{forceMethod:Method.Direct}:kind==='no-approximation'?{useApprox:false}:
      kind==='julia'?{family:'julia',juliaX:new Decimal('-.8'),juliaY:new Decimal('.156')}:{};
    const before=request(-16,extra),after=request(-32,extra),r=owner(before);
    if(kind==='quadratic'){r.wantsQuadratic=()=>true;r.fieldDescriptor.linearBlaEpsilon=undefined;}
    expect(sampleKey(r,before)).toBe(sampleKey(r,after));
    expect(fieldKey(r,before)).toBe(fieldKey(r,after));
    expect(r.isComplete(after)).toBe(true);
    expect(r.fieldSupportsAppearance(after,before.forceMethod,1)).toBe(true);
    r.currentView=after;expect(()=>r.requireLiveMethod(before)).not.toThrow();
  });

  it('retargets live calculation while keeping otherwise compatible reference preparation',()=>{
    const before=request(),after=request(-26),r=owner(before),demand=r.referenceDemand(before,8);
    r.currentView=after;
    expect(()=>r.requireLiveMethod(before)).toThrow();
    expect(r.referenceDemandCompatible(demand,after)).toBe(true);
  });

  it('retires carried scratch when its actual sample policy changes',()=>{
    const before=request(),after=request(-23),r=owner(before),slot=new PendingContinuationSlot(),destroy=vi.fn();
    const identity={epoch:1,policy:sampleKey(r,before),reference:r.refSamples,orbit:r.orbitBuffer,table:r.laBuffer,index:r.laIndexBuffer};
    slot.park({scratch:{destroy} as any,capacity:832,region:{x:0,y:0,width:1,height:1,stride:1,order:0},view:before,identity,unfinished:1,operations:256});
    expect(slot.claim({...identity,policy:sampleKey(r,after)},after)).toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();expect(slot.size).toBe(0);
  });

  it('freezes the selected tolerance into an export without altering live controls',()=>{
    const q=request(-24),exported=snapshotExportRequest(q);
    (q.tuning as any).blaPrecisionLog2=-16;
    expect(exported.tuning?.blaPrecisionLog2).toBe(-24);
    expect(blaTableEpsilon(exported)).toBe(-24);expect(exported.followView).toBe(false);
  });

  it('rebuilds a changed table policy using the admitted reference rather than generating it again',async()=>{
    const q=request(-23),r=owner(request()),stop=new Error('stop after table rebuild admission');
    const reference=r.refSamples,orbit=r.orbitBuffer;
    Object.assign(r,{batchFeedback:{enterTarget:()=>{}},disposed:false,deviceLost:false,numericalQuadratic:null,
      cachedRequest:'',pendingRetain:Promise.resolve(),currentView:q,directPipeline:{},shadePipeline:{},reusePipeline:{},blitPipeline:{},
      validateCoordinates:()=>{},recolorCompleted:async()=>null,beginAppearanceHold:()=>false,convertDistanceToIteration:async()=>false,
      refValid:true,refEscaped:true,refFamily:'mandelbrot',refConstant:'',refIterations:q.maxIterations,
      refX:q.centerX,refY:q.centerY,tableQuadratic:false,tableEpsilonLog2:-16,tableMaxDelta:new Decimal(1),laHasUsableMultiStep:true,
      generateOrbit:vi.fn(async()=>{throw Error('Reference must remain reusable');}),
      buildApproxTable:vi.fn(async(received:RenderRequest)=>{
        expect(blaTableEpsilon(received)).toBe(-23);expect(r.refSamples).toBe(reference);expect(r.orbitBuffer).toBe(orbit);throw stop;
      }),
    });
    await expect(r.renderTarget(q)).rejects.toBe(stop);
    expect(r.buildApproxTable).toHaveBeenCalledOnce();expect(r.generateOrbit).not.toHaveBeenCalled();
  });
});
