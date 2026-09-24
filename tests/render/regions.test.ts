import { describe, it, expect } from 'vitest';
import { PendingRegions, coverageDeficit, schedulerService, type Demand, type Region, type RegionTuning } from '../../src/render/regions';

const demand: Demand = {x:180,y:80,zoom:1,covered:[]};
const defaultTuning: RegionTuning={pointer:8,distributed:4,oldest:4,pointerRadius:64};
describe('exact pending regions',()=>{
  it('allocates eight turns 4 pointer, 2 distributed, 2 oldest',()=>{
    expect(Array.from({length:8},(_,i)=>schedulerService(i+1,true))).toEqual([
      'pointer','distributed','pointer','oldest','pointer','distributed','pointer','oldest',
    ]);
  });
  it('keeps the incumbent service sequence and selections at 5183 defaults',()=>{
    for(const distributed of [false,true])for(const rows of [false,true])
      for(let turn=1;turn<=64;turn++)
        expect(schedulerService(turn,distributed,rows,defaultTuning))
          .toBe(schedulerService(turn,distributed,rows));
    const incumbent=new PendingRegions(),tuned=new PendingRegions();
    incumbent.reset(512,512,4);tuned.reset(512,512,4);
    for(let i=0;i<12;i++){
      const target={...demand,x:(i*37)%512,y:(i*73)%512};
      expect(tuned.take(1024,target,undefined,defaultTuning)).toEqual(incumbent.take(1024,target));
    }
  });
  it('interleaves modified weights smoothly and accepts zero weights',()=>{
    const tuning={...defaultTuning,pointer:6,distributed:4,oldest:2};
    const sequence=Array.from({length:12},(_,i)=>schedulerService(i+1,true,false,tuning));
    expect(sequence.filter(s=>s==='pointer')).toHaveLength(6);
    expect(sequence.filter(s=>s==='distributed')).toHaveLength(4);
    expect(sequence.filter(s=>s==='oldest')).toHaveLength(2);
    expect(sequence.join(',')).not.toMatch(/(pointer,){3}|(distributed,){3}|(oldest,){3}/);
    expect(Array.from({length:8},(_,i)=>schedulerService(i+1,true,false,{...defaultTuning,pointer:0,distributed:0,oldest:8})))
      .toEqual(Array(8).fill('oldest'));
  });
  it('never schedules structurally unavailable distributed work',()=>{
    const onlyDistributed={...defaultTuning,pointer:0,distributed:8,oldest:0};
    for(const distributed of [false,true])for(const rows of [false,true]){
      const sequence=Array.from({length:16},(_,i)=>schedulerService(i+1,distributed,rows,onlyDistributed));
      expect(sequence).toEqual(Array(16).fill(distributed&&!rows?'distributed':'pointer'));
    }
    const zero={...defaultTuning,pointer:0,distributed:0,oldest:0};
    expect(schedulerService(1,true,false,zero)).toBe('pointer');
  });
  it('uses pointer radius only for pointer service scoring',()=>{
    const near:Region={x:0,y:0,width:32,height:32,order:0,stride:1};
    const far:Region={x:160,y:0,width:32,height:32,order:0,stride:1};
    const select=(radius:number)=>{
      const queue=new PendingRegions();queue.reset(192,32);
      // Give each radius the same two pending rectangles so this isolates the
      // proximity score from subdivision and previous service decisions.
      Reflect.set(queue,'pending',[near,far]);
      return queue.take(1024,{x:0,y:0,zoom:1,covered:[{x:0,y:0,width:7,height:32}]},undefined,
        {...defaultTuning,pointerRadius:radius});
    };
    expect(select(16)).toEqual(near);
    expect(select(512)).toEqual(far);
  });
  it('reaches an off-centre focus before the far corner and responds to a new focus',()=>{
    const queue=new PendingRegions(); queue.reset(256,256);
    const first=queue.take(1024,demand)!;
    expect(first.x<=180&&first.x+first.width>180&&first.y<=80&&first.y+first.height>80).toBe(true);
    const next=queue.take(1024,{...demand,x:8,y:240})!;
    expect(next.x<=8&&next.x+next.width>8&&next.y<=240&&next.y+next.height>240).toBe(true);
  });
  it('chooses coverage by visible density and useful cost, not input direction or turn',()=>{
    const inward=new PendingRegions();inward.reset(512,512,4);
    const coverage=inward.take(16384,demand)!;
    expect(coverage.stride).toBe(4);
    expect(Math.ceil(coverage.width/4)*Math.ceil(coverage.height/4)).toBeLessThanOrEqual(16384);
    expect(inward.take(16384,demand)!.stride).toBe(2);
    for(const zoom of [-1,1]) {
      const covered=[{x:0,y:0,width:512,height:512,spacing:2}];
      const queue=new PendingRegions();queue.reset(512,512,4);
      expect(queue.take(16384,{...demand,zoom,covered})!.stride).toBe(1);
      expect(queue.take(16384,{...demand,zoom,covered})!.stride).toBe(1);
      const magnified=new PendingRegions();magnified.reset(512,512,4);
      expect(magnified.take(16384,{...demand,zoom,covered:[{...covered[0],spacing:100}]})!.stride).toBe(4);
    }
  });
  it('keeps focus eligible when only a small coverage gap remains',()=>{
    const queue=new PendingRegions();queue.reset(512,512,4);
    expect(queue.take(16384,{...demand,covered:[{x:0,y:0,width:510,height:512}]})!.stride).toBe(1);
  });
  it('integrates overlapping densities without inventing known area',()=>{
    const r={x:0,y:0,width:100,height:100,stride:1,order:0};
    expect(coverageDeficit(r,[{...r,width:50},{...r,width:50},{...r,width:50}])).toBe(.5);
    expect(coverageDeficit(r,[{...r,spacing:4},{...r,width:50,spacing:2},{...r,width:25,spacing:1}])).toBe(.5);
  });
  it('services different spatial strata across compatible retargets',()=>{
    const queue=new PendingRegions(),positions=new Set<string>();
    for(let i=0;i<32;i++){
      queue.reset(1024,1024,16,true);
      const r=queue.take(1024,{...demand,covered:[{x:0,y:0,width:1024,height:1024,spacing:16}]})!;
      positions.add(`${r.x},${r.y}`);
    }
    expect(positions.size).toBeGreaterThan(8);
  });
  it('keeps subdivided sparse work aligned to its actual shading anchors',()=>{
    const queue=new PendingRegions();queue.reset(1024,768,16);
    const r=queue.take(512,demand)!;
    expect(r.stride).toBe(16);
    expect(r.x%16).toBe(0);expect(r.y%16).toBe(0);
    expect(Math.ceil(r.width/16)*Math.ceil(r.height/16)).toBeLessThanOrEqual(512);
  });
  it('finishes every exact pixel once despite a continuously moving focus',()=>{
    const queue=new PendingRegions(); queue.reset(317,193);
    const visits=new Uint8Array(317*193); let turn=0;
    while(queue.size){
      const region=queue.take(1024,{...demand,x:(turn*73)%317,y:(turn*37)%193})!;
      expect(region.width*region.height).toBeLessThanOrEqual(1024);
      for(let y=region.y;y<region.y+region.height;y++)for(let x=region.x;x<region.x+region.width;x++)visits[y*317+x]++;
      turn++; expect(turn).toBeLessThan(200);
    }
    expect([...visits].every(n=>n===1)).toBe(true);
  });
  it.each([-1,0])('prefers an exposed strip during outward zoom or pan (%s)',zoom=>{
    const queue=new PendingRegions(); queue.reset(256,256);
    const next=queue.take(1024,{x:16,y:128,zoom,covered:[{x:0,y:0,width:224,height:256}]})!;
    expect(next.x).toBeGreaterThanOrEqual(224);
  });
  it('does not prefer an already covered edge on zoom-out',()=>{
    const queue=new PendingRegions(); queue.reset(256,256);
    const next=queue.take(1024,{...demand,zoom:-1,covered:[{x:0,y:0,width:256,height:256}]})!;
    expect(next.x<=180&&next.x+next.width>180&&next.y<=80&&next.y+next.height>80).toBe(true);
  });
});
