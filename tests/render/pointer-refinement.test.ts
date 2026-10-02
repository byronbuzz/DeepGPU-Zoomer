import {describe,expect,it} from 'vitest';
import {PendingRegions,schedulerService,type Demand,type Region,type RegionTuning} from '../../src/render/regions';

const tuning:RegionTuning={pointer:12,distributed:3,oldest:3,pointerRadius:32};
const demand:Demand={x:24,y:40,zoom:1,covered:[{x:0,y:0,width:256,height:256,spacing:16}]};

function exactQueue(width=256,height=256){
  const queue=new PendingRegions();queue.reset(width,height,16);
  // Keep only exact obligations to isolate refinement from preview selection.
  queue.settle(1);return queue;
}

describe('pointer refinement control',()=>{
  it('keeps the accepted P P O P P D sequence in either state',()=>{
    const expected=['pointer','pointer','oldest','pointer','pointer','distributed'];
    for(const pointerRefinement of [undefined,true,false])
      expect(Array.from({length:18},(_,i)=>schedulerService(i+1,true,false,{...tuning,pointerRefinement})))
        .toEqual([...expected,...expected,...expected]);
  });

  it('changes pointer density from two levels to one without changing other services',()=>{
    for(const pointerRefinement of [undefined,true,false]){
      const queue=exactQueue(),strides:number[]=[];
      for(let turn=0;turn<6;turn++){
        strides.push(queue.take(65536,demand,undefined,{...tuning,pointerRefinement},true)!.stride);
        expect(queue.size).toBe(1);
      }
      expect(strides).toEqual(pointerRefinement===false?[8,8,8,8,8,8]:[4,4,8,4,4,8]);
    }
  });

  it('does not invent fine coverage when the initial preview is missing',()=>{
    for(const pointerRefinement of [true,false]){
      const queue=exactQueue();
      expect(queue.take(65536,{...demand,covered:[]},undefined,{...tuning,pointerRefinement},true)!.stride).toBe(16);
      expect(queue.size).toBe(1);
    }
  });

  it('leaves every exact pixel owned once after coarse visits and release',()=>{
    for(const pointerRefinement of [true,false]){
      const width=137,height=91,queue=exactQueue(width,height),visits=new Uint8Array(width*height);
      const target={...demand,covered:[{x:0,y:0,width,height,spacing:16}]};
      const record=(region:Region)=>{
        if(region.stride!==1)return;
        for(let y=region.y;y<region.y+region.height;y++)for(let x=region.x;x<region.x+region.width;x++)visits[y*width+x]++;
      };
      for(let turn=0;turn<24&&queue.size;turn++){
        const region=queue.take(128,{...target,x:(turn*37)%width,y:(turn*19)%height},undefined,{...tuning,pointerRefinement},true)!;
        expect(region.x%region.stride).toBe(0);expect(region.y%region.stride).toBe(0);record(region);
      }
      let remainingTurns=0;
      while(queue.size){
        const region=queue.take(1024,target,undefined,{...tuning,pointerRefinement},false)!;
        expect(region.stride).toBe(1);record(region);
        expect(++remainingTurns).toBeLessThan(100);
      }
      expect(visits.every(count=>count===1)).toBe(true);
    }
  });

  it('preserves both minority services at the new 64:1:1 weight extreme',()=>{
    for(const pointerRefinement of [true,false]){
      const weights={...tuning,pointer:64,distributed:1,oldest:1,pointerRefinement};
      const sequence=Array.from({length:132},(_,i)=>schedulerService(i+1,true,false,weights));
      for(let cycle=0;cycle<2;cycle++){
        const turns=sequence.slice(cycle*66,(cycle+1)*66);
        expect(turns.filter(s=>s==='pointer')).toHaveLength(64);
        expect(turns.filter(s=>s==='distributed')).toHaveLength(1);
        expect(turns.filter(s=>s==='oldest')).toHaveLength(1);
      }
    }
  });

  it('never enables distributed service when it is structurally unavailable',()=>{
    for(const pointerRefinement of [true,false])for(const [distributed,rows] of [[false,false],[false,true],[true,true]]){
      const weights={...tuning,pointer:0,distributed:64,oldest:0,pointerRefinement};
      expect(Array.from({length:66},(_,i)=>schedulerService(i+1,distributed,rows,weights))).toEqual(Array(66).fill('pointer'));
    }
  });
});
