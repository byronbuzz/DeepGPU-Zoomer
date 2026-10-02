import {describe,expect,it} from 'vitest';
import {PendingRegions,type Demand,type Region,type RegionTuning} from '../../src/render/regions';

const tuning:RegionTuning={pointer:12,distributed:3,oldest:3,pointerRadius:32};
const left:Region={x:0,y:0,width:32,height:32,stride:1,order:0};
const right:Region={...left,x:96};
const demand:Demand={x:63.5,y:15.5,zoom:1,covered:[]};
const forecast={x:96,y:0,width:32,height:32,spacing:1};

function candidates(){
  const queue=new PendingRegions();queue.reset(128,32,16);
  // Isolate the forecast ranking from preview stages and prior subdivisions.
  Reflect.set(queue,'pending',[{...left},{...right}]);return queue;
}

describe('inward forecast priority',()=>{
  it('prefers future overlap when current demand and coverage are otherwise equal',()=>{
    expect(candidates().take(1024,demand,undefined,tuning)).toEqual(left);
    expect(candidates().take(1024,{...demand,predicted:forecast},undefined,tuning)).toEqual(right);
  });

  it('cannot create coverage or consume the underlying exact obligation',()=>{
    for(const spacing of [undefined,16]){
      const queue=new PendingRegions();queue.reset(128,64,16);queue.settle(1);
      const covered=spacing?[{x:0,y:0,width:128,height:64,spacing}]:[];
      const original=covered.map(rectangle=>({...rectangle}));
      const next=queue.take(8192,{...demand,covered,predicted:{x:0,y:0,width:128,height:64,spacing:1}},undefined,tuning,true)!;
      expect(next.stride).toBe(spacing?4:16);
      expect(covered).toEqual(original);expect(queue.size).toBe(1);
      const exact=queue.take(8192,{...demand,covered},undefined,tuning,false)!;
      expect(exact).toMatchObject({x:0,y:0,width:128,height:64,stride:1});
      expect(queue.size).toBe(0);
    }
  });

  it('keeps oldest service outside the predicted view eligible',()=>{
    const queue=candidates();
    Reflect.set(queue,'turns',2);
    Reflect.set(queue,'pending',[{...right,order:20},{...left,order:0}]);
    expect(queue.take(1024,{...demand,predicted:forecast},undefined,tuning)).toEqual(left);
  });

  it('matches the existing selection sequence when prediction is absent',()=>{
    const baseline=new PendingRegions(),disabled=new PendingRegions();
    baseline.reset(317,193,16);disabled.reset(317,193,16);
    for(let turn=0;turn<32;turn++){
      const current={...demand,x:(turn*37)%317,y:(turn*19)%193};
      expect(disabled.take(512,{...current,predicted:undefined},undefined,tuning,true))
        .toEqual(baseline.take(512,current,undefined,tuning,true));
    }
  });

  it('finishes every exact pixel once while the forecast keeps changing',()=>{
    const width=317,height=193,queue=new PendingRegions();queue.reset(width,height);
    const visits=new Uint8Array(width*height);
    let turn=0;
    while(queue.size){
      const region=queue.take(512,{...demand,x:(turn*37)%width,y:(turn*19)%height,
        predicted:{x:(turn*73)%width,y:(turn*47)%height,width:64,height:48,spacing:1+(turn%8)}},undefined,tuning)!;
      expect(region.stride).toBe(1);
      for(let y=region.y;y<region.y+region.height;y++)for(let x=region.x;x<region.x+region.width;x++)visits[y*width+x]++;
      expect(++turn).toBeLessThan(300);
    }
    expect(visits.every(count=>count===1)).toBe(true);
  });
});
