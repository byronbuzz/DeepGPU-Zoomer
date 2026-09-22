import { describe, it, expect } from 'vitest';
import { PendingRegions, coverageDeficit, positionalWeight, type Demand } from '../../src/render/regions';

const demand: Demand = {x:180,y:80,zoom:1,covered:[]};
describe('exact pending regions',()=>{
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
  it('keeps a small remaining coverage gap eligible',()=>{
    const queue=new PendingRegions();queue.reset(512,512,4);
    const next=queue.take(16384,{...demand,covered:[{x:0,y:0,width:510,height:512}]})!;
    expect(next.x+next.width).toBeGreaterThan(510);
  });
  it('integrates overlapping densities without inventing known area',()=>{
    const r={x:0,y:0,width:100,height:100,stride:1,order:0};
    expect(coverageDeficit(r,[{...r,width:50},{...r,width:50},{...r,width:50}])).toBe(.5);
    expect(coverageDeficit(r,[{...r,spacing:4},{...r,width:50,spacing:2},{...r,width:25,spacing:1}])).toBe(.5);
  });
  it('uses explicit bounded weights for inward, hover and outward demand',()=>{
    const r={x:448,y:448,width:128,height:128,stride:1,order:0},base={...demand,x:512,y:512};
    expect(positionalWeight(r,{...base,zoom:3},1024,1024)).toBeCloseTo(8,10);
    expect(positionalWeight(r,{...base,zoom:0},1024,1024)).toBeCloseTo(1.25,10);
    expect(positionalWeight(r,{...base,zoom:-3},1024,1024)).toBeCloseTo(1/3,10);
    const edge={...r,x:0,y:0};expect(positionalWeight(edge,{...base,zoom:3},1024,1024)).toBeGreaterThan(1);
    expect(positionalWeight(edge,{...base,zoom:3},1024,1024)).toBeLessThan(8);
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
  it('does not invent missing benefit when the view is already covered',()=>{
    const queue=new PendingRegions(); queue.reset(256,256);
    const next=queue.take(1024,{...demand,zoom:-1,covered:[{x:0,y:0,width:256,height:256}]})!;
    expect(next.stride).toBe(1);
  });
});
