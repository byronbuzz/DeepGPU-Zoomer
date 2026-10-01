import {describe,expect,it} from 'vitest';
import {coverageDeficit,PendingRegions,type Demand,type Region} from '../../src/render/regions';

type Covered=Demand['covered'];
type Internals={coverage:Covered;deficit:(r:Region,d:Demand)=>number;
  nextStride:(r:Region,d:Demand,levels:number)=>number};

// Frozen pre-compaction sweep: an independent reference for the existing
// weighted union and selection semantics, including arbitrary float edges.
function incumbentUnion(covered:Covered):Covered{
  const pieces=covered.filter(c=>c.width>0&&c.height>0).map(c=>({...c,right:c.x+c.width,bottom:c.y+c.height,quality:1/(c.spacing??1)}));
  const xs=[...new Set(pieces.flatMap(c=>[c.x,c.right]))].sort((a,b)=>a-b),result:Covered=[];
  for(let i=1;i<xs.length;i++){
    const active=pieces.filter(c=>c.x<xs[i]&&c.right>xs[i-1]);
    const events=active.flatMap(c=>[{y:c.y,q:c.quality,delta:1},{y:c.bottom,q:c.quality,delta:-1}]).sort((a,b)=>a.y-b.y);
    const counts=new Map<number,number>();let quality=0,previous=events[0]?.y??0;
    for(const e of events){
      if(quality>0&&e.y>previous)result.push({x:xs[i-1],y:previous,width:xs[i]-xs[i-1],height:e.y-previous,spacing:1/quality});
      previous=e.y;
      const count=(counts.get(e.q)??0)+e.delta;
      if(count)counts.set(e.q,count);else counts.delete(e.q);
      if(e.delta>0)quality=Math.max(quality,e.q);
      else if(e.q===quality&&!count)quality=Math.max(0,...counts.keys());
    }
  }
  return result;
}
function compact(covered:Covered):Covered{
  const pending=new PendingRegions();
  pending.take(1,{x:0,y:0,zoom:0,covered});
  return (pending as unknown as Internals).coverage;
}
function deficit(r:Region,covered:Covered):number{
  let area=0;
  for(const c of covered){
    const width=Math.min(r.x+r.width,c.x+c.width)-Math.max(r.x,c.x);
    const height=Math.min(r.y+r.height,c.y+c.height)-Math.max(r.y,c.y);
    if(width>0&&height>0)area+=width*height*Math.min(1,r.stride/(c.spacing??1));
  }
  return Math.max(0,1-area/(r.width*r.height));
}
function random(seed:number){
  return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
}
function densityAt(covered:Covered,x:number,y:number):number{
  return Math.max(0,...covered.filter(c=>x>=c.x&&x<c.x+c.width&&y>=c.y&&y<c.y+c.height).map(c=>1/(c.spacing??1)));
}

describe('exact coverage union compaction',()=>{
  it('removes coarse event boundaries hidden under one finer rectangle',()=>{
    const covered:Covered=[{x:0,y:0,width:320,height:180,spacing:1}];
    for(let i=0;i<64;i++)covered.push({x:1+i*3,y:2+i*2,width:90,height:40,spacing:2+i%4});
    expect(incumbentUnion(covered).length).toBeGreaterThan(1000);
    expect(compact(covered)).toEqual([{x:0,y:0,width:320,height:180,spacing:1}]);
  });

  it('joins exact adjacency but preserves tiny gaps and density changes',()=>{
    const gap=2**-40;
    const covered:Covered=[
      {x:0,y:0,width:1,height:1,spacing:1},
      {x:1,y:0,width:1,height:1,spacing:1},
      {x:0,y:1+gap,width:2,height:1,spacing:1},
      {x:2+gap,y:0,width:1,height:1,spacing:1},
      {x:0,y:3,width:2,height:1,spacing:2},
      {x:0,y:4,width:2,height:1,spacing:1},
    ];
    expect(compact(covered)).toHaveLength(5);
    const actual=compact(covered);
    expect(densityAt(actual,1,1+gap/2)).toBe(0);
    expect(densityAt(actual,2+gap/2,.5)).toBe(0);
    expect(densityAt(actual,1,3.5)).toBe(.5);
    expect(densityAt(actual,1,4.5)).toBe(1);
  });

  it('ignores other slabs events and groups equal-y starts and ends',()=>{
    const covered:Covered=[
      {x:0,y:-10,width:.5,height:1,spacing:2},
      {x:1,y:0,width:5,height:4,spacing:8},
      {x:2,y:0,width:2,height:2,spacing:1},
      {x:2,y:2,width:2,height:2,spacing:1},
      {x:6,y:99,width:.5,height:1,spacing:2},
    ];
    expect(compact(covered)).toEqual([
      {x:0,y:-10,width:.5,height:1,spacing:2},
      {x:1,y:0,width:1,height:4,spacing:8},
      {x:2,y:0,width:2,height:4,spacing:1},
      {x:4,y:0,width:2,height:4,spacing:8},
      {x:6,y:99,width:.5,height:1,spacing:2},
    ]);
  });

  it('preserves random weighted deficits and pointwise finest density',()=>{
    const rng=random(0x814ac),spacings=[.25,.32905371199833205,1,1.0203645853,2,16];
    for(let trial=0;trial<96;trial++){
      const covered:Covered=Array.from({length:4+Math.floor(rng()*45)},()=>({
        x:rng()*240-20,y:rng()*160-20,width:1+rng()*150,height:1+rng()*100,
        spacing:spacings[Math.floor(rng()*spacings.length)],
      }));
      const before=incumbentUnion(covered),after=compact(covered);
      for(let j=0;j<12;j++){
        const r={x:rng()*256,y:rng()*192,width:1+rng()*128,height:1+rng()*96,order:0,stride:2**(j%5)};
        expect(deficit(r,after)).toBeCloseTo(deficit(r,before),12);
        expect(coverageDeficit(r,covered)).toBeCloseTo(deficit(r,before),12);
        expect(densityAt(after,r.x,r.y)).toBe(densityAt(covered,r.x,r.y));
      }
    }
  });

  it('preserves incumbent region choices and gradual refinement across service turns',()=>{
    const rng=random(0x759dcc);
    for(const gradual of [false,true])for(const rows of [undefined,16])for(let trial=0;trial<8;trial++){
      const actual=new PendingRegions(),reference=new PendingRegions();
      actual.reset(256,192,16);reference.reset(256,192,16);
      const internal=reference as unknown as Internals;
      const originalDeficit=internal.deficit,originalStride=internal.nextStride;
      let union:Covered=[];
      // Exercise the same selector with the frozen old partition, rather
      // than duplicating service, split, scoring or refinement policy.
      internal.deficit=function(r,d){this.coverage=union;return originalDeficit.call(this,r,d);};
      internal.nextStride=function(r,d,levels){this.coverage=union;return originalStride.call(this,r,d,levels);};
      for(let turn=0;turn<48;turn++){
        const covered:Covered=Array.from({length:24},()=>({
          x:Math.floor(rng()*32)*8,y:Math.floor(rng()*24)*8,
          width:(1+Math.floor(rng()*16))*8,height:(1+Math.floor(rng()*12))*8,
          spacing:2**(Math.floor(rng()*7)-2),
        }));
        const demand={x:rng()*256,y:rng()*192,zoom:turn%2?1:-1,covered,
          visible:{x:16,y:8,width:224,height:176}};
        union=incumbentUnion(covered);
        const budget=64+Math.floor(rng()*512);
        expect(actual.take(budget,demand,rows,undefined,gradual)).toEqual(reference.take(budget,demand,rows,undefined,gradual));
      }
    }
  });

  it('preserves refinement levels for fractional retained coverage',()=>{
    const rng=random(0x96ea4),pending=new PendingRegions();pending.reset(1600,900,64);
    const internal=pending as unknown as Internals;
    for(let trial=0;trial<128;trial++){
      const covered:Covered=[{x:0,y:0,width:1600,height:900,spacing:16}];
      for(let j=0;j<32;j++)covered.push({x:rng()*1200,y:rng()*650,width:50+rng()*350,height:30+rng()*200,spacing:1+rng()*12});
      const r={x:Math.floor(rng()*80)*8,y:Math.floor(rng()*50)*8,width:640,height:400,order:0,stride:1};
      const demand={x:800,y:450,zoom:-1,covered,visible:{x:0,y:0,width:1600,height:900}};
      for(const levels of [1,2]){
        internal.coverage=incumbentUnion(covered);const expected=internal.nextStride(r,demand,levels);
        internal.coverage=compact(covered);expect(internal.nextStride(r,demand,levels)).toBe(expected);
      }
    }
  });
});
