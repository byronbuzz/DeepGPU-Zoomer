import {describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {PendingContinuationSlot,translatedContinuationRegion,type PendingContinuation,type ContinuationIdentity} from '../../src/render/pending-continuation';
import {WebGpuRenderer} from '../../src/render/webgpu-renderer';
import {createSampleGridAnchor} from '../../src/render/sample-grid';
const view=(extra:any={})=>({centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal('1e-40'),width:128,height:128,angle:0,...extra});
const identity=():ContinuationIdentity=>({epoch:7,policy:'mandelbrot|cap100000|wide8|plain',reference:{},orbit:{},table:{},index:{}});
function saved(extra:Partial<PendingContinuation>={}){
  const destroy=vi.fn();const value:PendingContinuation={scratch:{destroy} as any,capacity:200000,
    region:{x:32,y:32,width:32,height:32,stride:4,order:0},view:view(),identity:identity(),unfinished:12,operations:4096,...extra};
  return {value,destroy};
}
describe('one compatible unfinished region owner',()=>{
  it('maps every saved anchor to exactly the same complex point after an integer translation',()=>{
    for(const shift of [-8,8]){
      const {value}=saved(),next=view({centerX:new Decimal(shift).times('1e-40'),centerY:new Decimal(-shift).times('1e-40')});
      const region=translatedContinuationRegion(value,next)!;expect(region).not.toBeNull();
      const before=createSampleGridAnchor(value.view),after=createSampleGridAnchor(next);
      for(let y=0;y<value.region.height;y+=value.region.stride)for(let x=0;x<value.region.width;x+=value.region.stride){
        expect(before.originX.plus(value.view.unitsPerPixel.times(value.region.x+x)).eq(after.originX.plus(next.unitsPerPixel.times(region.x+x)))).toBe(true);
        expect(before.originY.minus(value.view.unitsPerPixel.times(value.region.y+y)).eq(after.originY.minus(next.unitsPerPixel.times(region.y+y)))).toBe(true);
      }
    }
  });
  it('rejects fractional, off-stride, scale, rotation, clipped and invisible mappings',()=>{
    const {value}=saved();
    for(const next of [view({centerX:new Decimal('0.5e-40')}),view({centerX:new Decimal('1e-40')}),
      view({unitsPerPixel:new Decimal('2e-40')}),view({angle:90}),view({centerX:new Decimal('40e-40')})])
      expect(translatedContinuationRegion(value,next)).toBeNull();
    expect(translatedContinuationRegion(value,view(),{x:100,y:100,width:28,height:28})).toBeNull();
  });
  it('accepts a centered 1-to-3 field translation without moving the original sample',()=>{
    const {value}=saved({view:view({width:1,height:1}),region:{x:0,y:0,width:1,height:1,stride:1,order:0},unfinished:1});
    expect(translatedContinuationRegion(value,view({width:3,height:1}))).toEqual({x:1,y:0,width:1,height:1,stride:1,order:0});
  });
  it('holds one resource and destroys a replaced owner exactly once',()=>{
    const slot=new PendingContinuationSlot(),a=saved(),b=saved();slot.park(a.value);slot.park(b.value);
    expect(slot.size).toBe(1);expect(a.destroy).toHaveBeenCalledTimes(1);expect(b.destroy).not.toHaveBeenCalled();
    slot.clear();slot.clear();expect(b.destroy).toHaveBeenCalledTimes(1);expect(slot.size).toBe(0);
  });
  it('claim transfers ownership and retains only the unfinished admission count',()=>{
    const slot=new PendingContinuationSlot(),a=saved();slot.park(a.value);
    const resumed=slot.claim(a.value.identity,view())!;expect(resumed.unfinished).toBe(12);expect(resumed.operations).toBe(4096);
    expect(slot.size).toBe(0);slot.clear();expect(a.destroy).not.toHaveBeenCalled();
    resumed.scratch.destroy();expect(a.destroy).toHaveBeenCalledTimes(1);
  });
  it('reference, table, precision, cap or epoch replacement invalidates parked ownership',()=>{
    for(const key of ['reference','orbit','table','index','policy','epoch'] as const){
      const slot=new PendingContinuationSlot(),a=saved();slot.park(a.value);
      const changed={...a.value.identity,[key]:key==='policy'?'different cap or precision':key==='epoch'?8:{}};
      expect(slot.claim(changed,view())).toBeUndefined();expect(a.destroy).toHaveBeenCalledTimes(1);expect(slot.size).toBe(0);
    }
  });
  it('rejecting geometry releases parked ownership',()=>{
    const slot=new PendingContinuationSlot(),a=saved();slot.park(a.value);
    expect(slot.claim(a.value.identity,view({angle:90}))).toBeUndefined();expect(a.destroy).toHaveBeenCalledTimes(1);
  });
  it('renderer cancellation clears the pending owner without a second destroy',()=>{
    const slot=new PendingContinuationSlot(),a=saved();slot.park(a.value);
    const renderer:any=Object.assign(Object.create(WebGpuRenderer.prototype),{pendingContinuation:slot,batchCostKey:'',cancelPendingReference:vi.fn()});
    renderer.abort();renderer.abort();expect(renderer.abortRequested).toBe(true);expect(a.destroy).toHaveBeenCalledTimes(1);
  });
  it('renderer disposal retires pending scratch even with no active target',async()=>{
    const slot=new PendingContinuationSlot(),a=saved();slot.park(a.value);
    const renderer:any=Object.assign(Object.create(WebGpuRenderer.prototype),{pendingContinuation:slot,batchCostKey:'',cancelPendingReference:vi.fn(),
      disposed:false,lossHook:{notify:null},publicationEpoch:7,referenceWorker:{cancel:vi.fn()},usedQuadraticWorkers:false,
      activeOperations:new Set(),pendingPipelines:new Map(),pendingRetain:null,ctx:{device:{queue:{onSubmittedWorkDone:async()=>{}}}},
      ordinaryShapePipelines:new Map(),deferredPipelines:new Map(),deferredModule:null,
      predictionCost:{reference:null,table:null},deferredPassEstimate:{reference:null,table:null},
      timing:{dispose:vi.fn()},context:{unconfigure:vi.fn()},pending:{reset:vi.fn()}});
    await renderer.dispose();await renderer.dispose();expect(a.destroy).toHaveBeenCalledTimes(1);expect(slot.size).toBe(0);
  });
});
