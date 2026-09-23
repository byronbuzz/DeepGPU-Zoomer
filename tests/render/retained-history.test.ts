import Decimal from 'decimal.js';
import {describe,expect,it,vi} from 'vitest';
import {WebGpuRenderer} from '../../src/render/webgpu-renderer';
import {CoverageRegions} from '../../src/render/regions';
import {DEFAULT_COLORS} from '../../src/logic/colorSettings';

function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const frame=()=>({family:'mandelbrot',centerX:new Decimal('-.6'),centerY:new Decimal(0),unitsPerPixel:new Decimal('.00099'),
  width:5120,height:2880,angle:0,maxIterations:100,useApprox:true,method:0,grid:1,colors:DEFAULT_COLORS});
function fixture(){
  vi.stubGlobal('GPUTextureUsage',{TEXTURE_BINDING:4,RENDER_ATTACHMENT:16,COPY_SRC:1,COPY_DST:2});
  const validation=deferred<any>(),textures:any[]=[],old={destroy:vi.fn()};
  const device={limits:{maxTextureDimension2D:8192},pushErrorScope:vi.fn(),popErrorScope:()=>validation.promise,
    createTexture:(d:any)=>{const t={...d,width:d.size.width??d.size[0],height:d.size.height??d.size[1],destroy:vi.fn()};textures.push(t);return t;},
    createCommandEncoder:()=>({finish:()=>({})}),queue:{submit:vi.fn()}};
  const r:any=Object.create(WebGpuRenderer.prototype),f=frame();
  Object.assign(r,{ctx:{device},publicationEpoch:1,pendingRetain:null,currentView:f,incomingFrame:f,target:{},partialRegions:1,
    retainedAnchor:null,lastFrame:{...f,unitsPerPixel:new Decimal('.001'),snapshotComplete:true},history:old,historyValid:true,
    coverageFrame:null,coverageHistory:null,determined:new CoverageRegions(),encodeBlit:vi.fn()});
  r.determined.add({x:0,y:0,width:128,height:128,spacing:1});
  return {r,f,old,device,validation,textures};
}

describe('bounded retained history lifecycle (GPU validation mocked)',()=>{
  it('keeps old history until validation, coalesces allocations and never declares proxy completion',async()=>{
    const {r,f,old,validation,textures}=fixture();
    const publication=r.retainDisplayedPartial(f,true);
    expect(r.history).toBe(old);expect(old.destroy).not.toHaveBeenCalled();
    const second=r.retainDisplayedPartial(f,true);
    expect(textures).toHaveLength(1);
    expect(textures[0].size[0]).toBeLessThanOrEqual(2560);expect(textures[0].size[1]).toBeLessThanOrEqual(1440);
    validation.resolve(null);expect(await publication).toBe(true);expect(await second).toBe(true);
    expect(r.history).toBe(textures[0]);expect(r.coverageHistory).toBe(old);expect(r.lastFrame.proxy).toBe(true);
    expect(r.isComplete(f)).toBeFalsy();expect(r.pendingRetain).toBeNull();
  });
  it.each(['validation','out of memory','internal'])('preserves old valid history on %s failure',async(message)=>{
    const {r,f,old,validation,textures}=fixture();
    const publication=r.retainDisplayedPartial(f);
    validation.resolve({message});expect(await publication).toBe(false);
    expect(r.history).toBe(old);expect(r.historyValid).toBe(true);expect(r.incomingFrame).toBe(f);
    expect(old.destroy).not.toHaveBeenCalled();expect(textures[0].destroy).toHaveBeenCalledOnce();
  });
  it.each(['epoch','incoming','history','appearance','device'])('discards a stale %s replacement',async(kind)=>{
    const {r,f,old,validation,textures}=fixture();
    r.retainPartial();const pending=r.pendingRetain;
    if(kind==='epoch')r.publicationEpoch++;
    if(kind==='incoming')r.incomingFrame={...f};
    if(kind==='history')r.history={destroy:vi.fn()};
    if(kind==='appearance')r.currentView={...f,colors:{...f.colors,cycle:99}};
    if(kind==='device')r.deviceLost=true;
    const kept=r.history;validation.resolve(null);expect(await pending).toBe(false);
    expect(r.history).toBe(kept);expect(old.destroy).not.toHaveBeenCalled();expect(textures[0].destroy).toHaveBeenCalledOnce();
  });
  it('bounds rotated and completed history while exact completion belongs only to the full target',async()=>{
    const {r,f,validation,textures}=fixture();f.angle=37;
    const retained=r.snapshotFrame(f);
    expect(retained.width).toBeLessThanOrEqual(2560);expect(retained.height).toBeLessThanOrEqual(1440);
    expect(retained.proxy).toBe(true);
    const pending=r.retainDisplayedPartial(f);validation.resolve(null);await pending;
    expect(textures[0].size[0]).toBeLessThanOrEqual(2560);expect(textures[0].size[1]).toBeLessThanOrEqual(1440);
    Object.assign(r,{fieldComplete:true,completedFrame:f,currentImageValid:true,lastFrame:retained});
    expect(r.isComplete(f)).toBe(true);r.currentImageValid=false;expect(r.isComplete(f)).toBe(false);
    r.currentImageValid=true;r.completedFrame=retained;expect(r.isComplete(f)).toBe(false);
  });
  it('does not return cached completion after a stale recolour overwrites the current target',async()=>{
    const {r,f}=fixture();
    const request={...f,isCurrent:()=>true};
    Object.assign(r,{cachedRequest:[f.centerX,f.centerY,f.unitsPerPixel,f.width,f.height,0,f.family,undefined,undefined,f.maxIterations,undefined,true,JSON.stringify(f.colors)].join('|'),
      cachedStats:{completed:true},fieldComplete:true,completedFrame:f,currentImageValid:false,
      directPipeline:{},shadePipeline:{},reusePipeline:{},blitPipeline:{},recolorCompleted:vi.fn(async()=>{throw Error('rebuild required');})});
    r.ctx.device.limits.maxBufferSize=r.ctx.device.limits.maxStorageBufferBindingSize=1e9;
    await expect(r.renderTarget(request)).rejects.toThrow('rebuild required');
    expect(r.recolorCompleted).toHaveBeenCalledOnce();
  });
  it('bounds aggregate retained textures across completed, partial and concurrent stale replacements',async()=>{
    const {r,f,validation,textures}=fixture();validation.resolve(null);
    let peak=0;
    const inventory=()=>{
      const live=textures.filter(t=>t.destroy.mock.calls.length===0);
      peak=Math.max(peak,live.length);
      expect(live.length).toBeLessThanOrEqual(4);
      for(const t of live){expect(t.width).toBeLessThanOrEqual(2560);expect(t.height).toBeLessThanOrEqual(1440);}
    };
    for(let i=0;i<40;i++){
      const frame={...f,centerX:f.centerX.plus(i*.0001)},retained=r.snapshotFrame(frame);
      const candidate=r.candidateTexture(retained.width,retained.height);inventory();
      r.commitHistory(retained,candidate);r.lastFrame=retained;inventory();
      r.incomingFrame=frame;r.currentView=frame;
      const partial=r.retainDisplayedPartial(frame,true);inventory();
      if(i%2){
        const next=r.candidateTexture(retained.width,retained.height);inventory();
        r.commitHistory(retained,next);r.lastFrame=retained;inventory();
      }
      await partial;inventory();
    }
    expect(peak).toBeLessThanOrEqual(4);
  });
});
