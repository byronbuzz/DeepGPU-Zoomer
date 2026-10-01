import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {WebGpuRenderer,Method,methodForScale,type RenderRequest} from '../src/render/webgpu-renderer';
import {dynamicLimitForZoom} from '../src/dynamic';
import {snapshotExportRequest} from '../src/export/render';
import {DEFAULT_COLORS} from '../src/logic/colorSettings';
import {DEFAULT_TUNING} from '../src/tuning';
import {createSampleGridAnchor} from '../src/render/sample-grid';

const request=(extra:Partial<RenderRequest>={}):RenderRequest=>({
  centerX:new Decimal('-.7'),centerY:new Decimal('.1'),unitsPerPixel:new Decimal('1e-20'),
  width:64,height:64,maxIterations:64000,family:'mandelbrot',useApprox:true,forceMethod:Method.Hdr,
  colors:{...DEFAULT_COLORS,mode:0,capped:0,effect:0,supersample:1,postAntialias:false},
  tuning:{...DEFAULT_TUNING},followView:true,workView:true,interacting:true,zoom:1,dynamicIterations:true,
  isCurrent:()=>true,...extra,
});
function owner(q:RenderRequest):any{
  return Object.assign(Object.create(WebGpuRenderer.prototype),{
    ctx:{device:{limits:{maxStorageBufferBindingSize:256*1024*1024,maxBufferSize:256*1024*1024,maxTextureDimension2D:8192}}},
    currentView:q,refValid:true,refEscaped:false,refFamily:'mandelbrot',refConstant:'',refLimbs:8,refIterations:65536,refLength:65537,
    refX:q.centerX,refY:q.centerY,tableMaxDelta:new Decimal(1),tableQuadratic:false,tableEpsilonLog2:-16,laHasUsableMultiStep:true,
  });
}
const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
// These routing bodies contain plain JavaScript. Evaluate production's actual
// gates without booting the DOM, renderer, timers or a WebGPU device.
function functionBody(name:string){
  const start=source.indexOf(`function ${name}(`),brace=source.indexOf('{',start),end=source.indexOf('\n}',brace);
  if(start<0||brace<0||end<0)throw Error(`Missing production routing function ${name}`);
  return source.slice(brace+1,end);
}

describe('preparation-only Dynamic cap updates',()=>{
  it('keeps the Direct 499/500 ms cadence and allows immediate preparation proposals',()=>{
    const input={zoomDirection:1,time:1499,lastUpdate:1000,base:64000,current:64000,depthDelta:2,
      depthGain:5000,maximum:10000000,referencePreparing:false};
    expect(dynamicLimitForZoom(input)).toBeNull();
    expect(dynamicLimitForZoom({...input,time:1500})).toBe(73600);
    expect(dynamicLimitForZoom({...input,time:1000,updateIntervalMs:0})).toBe(73600);
    expect(dynamicLimitForZoom({...input,time:1e9,zoomDirection:0,updateIntervalMs:0})).toBeNull();
  });

  it('production zoom-event routing never falls back to a timed perturbation update',()=>{
    const apply=vi.fn();let q=request({forceMethod:undefined});const r=owner(q);
    const run=new Function('engine','request','Method','applyDynamicLimit','time','zoomDirection',functionBody('updateDynamicForZoom'));
    run(r,()=>q,Method,apply,1e9,1);
    expect(apply).not.toHaveBeenCalled();
    q={...q,unitsPerPixel:new Decimal('1e-3')};
    run(r,()=>q,Method,apply,1000,-1);
    expect(apply).toHaveBeenCalledOnce();expect(apply).toHaveBeenCalledWith(1000,-1,500);
  });

  it('uses the retained numerical grid at the Direct crossover without mutating planning state',()=>{
    const q=request({forceMethod:undefined,workView:false,unitsPerPixel:new Decimal('1.8e-15')}),r=owner(q);
    const anchor=createSampleGridAnchor({...q,unitsPerPixel:new Decimal('1.7e-15')});
    Object.assign(r,{numericalAnchor:anchor,numericalView:null,numericalGuardMs:0,outwardBatchDelayMs:0});
    expect(methodForScale(q.unitsPerPixel,q.tuning)).toBe(Method.Direct);
    expect(r.methodForRequest(q)).toBe(Method.Hdr);expect(r.methodForRequest(q)).toBe(Method.Hdr);
    expect(r.numericalAnchor).toBe(anchor);expect(r.numericalView).toBeNull();expect(r.numericalGuardMs).toBe(0);
    const outward={...q,unitsPerPixel:new Decimal('1.7e-15'),zoom:-1};
    r.numericalAnchor=null;
    expect(methodForScale(outward.unitsPerPixel,outward.tuning)).toBe(Method.Hdr);
    expect(r.methodForRequest(outward)).toBe(Method.Direct);
    expect(r.numericalAnchor).toBeNull();expect(r.numericalView).toBeNull();expect(r.numericalGuardMs).toBe(0);
  });

  it('production preparation routing reads the live direction instead of queuing an earlier one',()=>{
    let zoom=1;const proposal=vi.fn((_time:number,direction:number,interval:number)=>dynamicLimitForZoom({zoomDirection:direction,
      time:1000,lastUpdate:1000,base:64000,current:64000,depthDelta:2,depthGain:5000,maximum:10000000,referencePreparing:false,updateIntervalMs:interval}));
    const run=new Function('performance','request','applyDynamicLimit',functionBody('updateDynamicBeforePreparation'));
    expect(run({now:()=>1000},()=>({zoom}),proposal)).toBe(73600);
    zoom=0;expect(run({now:()=>1000},()=>({zoom}),proposal)).toBeNull();
    expect(proposal.mock.calls.map(call=>call.slice(1))).toEqual([[1,0],[0,0]]);
  });

  it('does not consult Dynamic while both reference and table remain reusable',()=>{
    const beforePreparation=vi.fn(()=>70000),q=request({beforePreparation}),r=owner(q);
    expect(r.referenceNeedsPreparation(q,8)).toBe(false);expect(r.approximationPreparation(q).needed).toBe(false);
    expect(r.preparationRequest(q,8)).toBe(q);expect(r.preparationRequest(q,8)).toBe(q);
    expect(beforePreparation).not.toHaveBeenCalled();expect(r.currentView.maxIterations).toBe(64000);
  });

  it.each(['reference','table'] as const)('makes one proposal at an independently stale %s boundary',kind=>{
    const beforePreparation=vi.fn(()=>65000),q=request({beforePreparation}),r=owner(q);
    if(kind==='reference')r.refValid=false;else r.tableEpsilonLog2=-21;
    const prepared=r.preparationRequest(q,8);
    expect(beforePreparation).toHaveBeenCalledOnce();expect(prepared).not.toBe(q);
    expect(prepared).toMatchObject({maxIterations:65000,provisionalNavigationCap:true});
    expect(r.currentView).toMatchObject({maxIterations:65000,provisionalNavigationCap:true});
    expect(q.maxIterations).toBe(64000);
  });

  it.each(['not-live','export','disabled','stale-owner'] as const)('does not propose for %s work',kind=>{
    const beforePreparation=vi.fn(()=>70000),q=request({beforePreparation});
    if(kind==='not-live')q.followView=false;
    if(kind==='export')q.exportDomain={width:64,height:64,x:0,y:0};
    if(kind==='disabled')q.dynamicIterations=false;
    if(kind==='stale-owner')q.isCurrent=()=>false;
    const r=owner(q);r.refValid=false;
    expect(r.preparationRequest(q,8)).toBe(q);expect(beforePreparation).not.toHaveBeenCalled();
  });

  it.each([null,64000])('does not replace request or live state for proposal %s',value=>{
    const q=request({beforePreparation:vi.fn(()=>value)}),r=owner(q);r.refValid=false;
    expect(r.preparationRequest(q,8)).toBe(q);expect(r.currentView).toBe(q);
  });

  it.each([0,10000001,1.5,NaN])('rejects invalid proposal %s without mutating live state',value=>{
    const q=request({beforePreparation:()=>value}),r=owner(q);r.refValid=false;
    expect(()=>r.preparationRequest(q,8)).toThrow('Invalid Dynamic preparation limit');
    expect(r.currentView).toBe(q);expect(q.maxIterations).toBe(64000);
  });

  it('removes the live preparation hook from an export snapshot',()=>{
    const beforePreparation=vi.fn(()=>70000),q=request({beforePreparation}),snapshot=snapshotExportRequest(q);
    expect(snapshot.beforePreparation).toBeUndefined();expect(snapshot.dynamicIterations).toBe(false);
    const r=owner(snapshot);r.refValid=false;expect(r.preparationRequest(snapshot,8)).toBe(snapshot);
    expect(beforePreparation).not.toHaveBeenCalled();
  });

  it('rechecks reference capacity after one table-triggered proposal crosses 65536',async()=>{
    const beforePreparation=vi.fn(()=>70000),q=request({beforePreparation}),r=owner(q),stop=new Error('bounded stop at reference extension');
    Object.assign(r,{publicationEpoch:1,batchFeedback:{enterTarget:()=>{}},disposed:false,deviceLost:false,numericalQuadratic:null,
      cachedRequest:'',pendingRetain:Promise.resolve(),directPipeline:{},shadePipeline:{},reusePipeline:{},blitPipeline:{},
      recolorCompleted:async()=>null,beginAppearanceHold:()=>false,convertDistanceToIteration:async()=>false,
      tableEpsilonLog2:-21,
      generateOrbit:vi.fn(async(received:RenderRequest,limbs:number)=>{
        expect(received.maxIterations).toBe(70000);expect(limbs).toBe(8);
        expect(r.referenceBudget(received.maxIterations,true,'mandelbrot')).toBe(131072);throw stop;
      }),buildApproxTable:vi.fn(),
    });
    expect(r.referenceNeedsPreparation(q,8)).toBe(false);expect(r.approximationPreparation(q).needed).toBe(true);
    await expect(r.renderTarget(q)).rejects.toBe(stop);
    expect(beforePreparation).toHaveBeenCalledOnce();expect(r.generateOrbit).toHaveBeenCalledOnce();
    expect(r.buildApproxTable).not.toHaveBeenCalled();expect(r.currentView.maxIterations).toBe(70000);
  });
});
