import Decimal from 'decimal.js';
import {describe,expect,it,vi} from 'vitest';
import {WebGpuRenderer} from '../../src/render/webgpu-renderer';

const view=()=>({centerX:new Decimal('-.749112272377808777993'),centerY:new Decimal('.049338112885249255'),
  unitsPerPixel:new Decimal('1e-16'),width:1600,height:900,followView:true,interacting:true,zoom:1});

describe('inward demand after asynchronous preparation',()=>{
  it('rejects an expired numerical grid but keeps camera movement within that same grid',()=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype),prepared=view();
    const live={...prepared,unitsPerPixel:prepared.unitsPerPixel.div(1.2)};
    renderer.currentView=live;renderer.workRequest=vi.fn(()=>prepared);
    expect(()=>renderer.requirePreparedInwardView(prepared)).not.toThrow();
    renderer.workRequest=vi.fn(()=>({...prepared,unitsPerPixel:prepared.unitsPerPixel.div(2)}));
    expect(()=>renderer.requirePreparedInwardView(prepared)).toThrow();
  });

  it('leaves outward, stationary and independent renders on their existing paths',()=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype),prepared=view();
    renderer.workRequest=vi.fn(()=>{throw Error('must not replan');});
    for(const live of [{...prepared,zoom:-1},{...prepared,zoom:0},{...prepared,interacting:false}]){
      renderer.currentView=live;
      expect(()=>renderer.requirePreparedInwardView(prepared)).not.toThrow();
    }
    renderer.currentView=prepared;
    expect(()=>renderer.requirePreparedInwardView({...prepared,followView:false})).not.toThrow();
    expect(()=>renderer.requirePreparedInwardView({...prepared,family:'julia'})).not.toThrow();
    expect(renderer.workRequest).not.toHaveBeenCalled();
  });
});
