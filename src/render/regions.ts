/** Pending exact pixel rectangles. Coordinates and splits are workgroup aligned. */
export interface Region { x: number; y: number; width: number; height: number; order: number; stride: number }
export interface Demand {
  x: number; y: number;
  /** Positive inward, negative outward; pan is represented by exposed bounds. */
  zoom: number;
  covered: { x: number; y: number; width: number; height: number; spacing?: number }[];
}
/** Flatten once per selection, so every candidate uses the same weighted union. */
function disjointCoverage(covered: Demand['covered']) {
  const pieces=covered.filter(c=>c.width>0&&c.height>0).map(c=>({...c,right:c.x+c.width,bottom:c.y+c.height,quality:1/(c.spacing??1)}));
  const xs=[...new Set(pieces.flatMap(c=>[c.x,c.right]))].sort((a,b)=>a-b);
  const result:Demand['covered']=[];
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
function disjointDeficit(r:Region,covered:Demand['covered']){
  let area=0;
  for(const c of covered){const width=Math.min(r.x+r.width,c.x+c.width)-Math.max(r.x,c.x),height=Math.min(r.y+r.height,c.y+c.height)-Math.max(r.y,c.y);
    if(width>0&&height>0)area+=width*height*Math.min(1,r.stride/(c.spacing??1));}
  return Math.max(0,1-area/(r.width*r.height));
}
/** Integrate the finest density over a rectangle union. Overlaps never add area. */
export function coverageDeficit(r:Region,covered:Demand['covered']){
  return disjointDeficit(r,disjointCoverage(covered));
}
export function schedulerService(turn:number,distributed:boolean,rows=false):'pointer'|'distributed'|'oldest'{
  return turn%4===0?'oldest':distributed&&turn%2===0&&!rows?'distributed':'pointer';
}

/** Bounded, conservative presentation coverage; never establishes scalar validity. */
export class CoverageRegions {
  rectangles: Demand['covered']=[];
  add(c: Demand['covered'][number]) {
    const contains=(a:typeof c,b:typeof c)=>a.x<=b.x&&a.y<=b.y&&a.x+a.width>=b.x+b.width&&a.y+a.height>=b.y+b.height;
    if(this.rectangles.some(a=>contains(a,c)&&(a.spacing??1)<=(c.spacing??1)))return;
    this.rectangles=this.rectangles.filter(a=>!contains(c,a)||(c.spacing??1)>(a.spacing??1));
    this.rectangles.push(c);
    // Dropping older hints can only underestimate coverage, never invent it.
    if(this.rectangles.length>128)this.rectangles.shift();
  }
}
export class PendingRegions {
  private pending: Region[] = [];
  private turns = 0;
  private width=0;
  private height=0;
  private distributed=false;
  private deficits=new Map<Region,number>();
  private coverage:Demand['covered']=[];
  reset(width: number, height: number, previewStride=1, compatible=false) {
    this.width=width;this.height=height;
    this.distributed=previewStride>1;
    this.pending = width && height ? [{ x: 0, y: 0, width, height, order: 0, stride: 1 }] : [];
    if(!compatible)this.turns=0;
    for(let stride=2;width&&height&&stride<=previewStride;stride*=2)
      this.pending.push({x:0,y:0,width,height,order:0,stride});
  }
  get size() { return this.pending.length; }
  private deficit(r: Region, d: Demand) {
    let value=this.deficits.get(r);
    if(value===undefined){value=disjointDeficit(r,this.coverage);this.deficits.set(r,value);}
    return value;
  }
  private score(r: Region, d: Demand) {
    const dx = Math.max(r.x - d.x, 0, d.x - r.x - r.width + 1);
    const dy = Math.max(r.y - d.y, 0, d.y - r.y - r.height + 1);
    const deficit=this.deficit(r,d);
    // Sparse samples cover stride squared pixels per calculation, but only
    // improve linear resolution by stride. Use that conservative cost benefit.
    if(r.stride>1) return deficit*4*Math.sqrt(r.stride) + .5 / (1 + Math.hypot(dx,dy) / 64);
    const focusWeight=this.distributed&&this.turns%2===1?4:1;
    return deficit * 4 + focusWeight / (1 + Math.hypot(dx,dy) / 64);
  }
  take(budget: number, demand: Demand, rows?: number): Region | undefined {
    this.deficits.clear();
    this.coverage=disjointCoverage(demand.covered);
    this.pending=this.pending.filter(r=>r.stride===1 || this.deficit(r,demand)>0);
    if (!this.pending.length) return;
    // Two oldest turns per eight prevent a moving focus from starving gaps.
    const service=schedulerService(++this.turns,this.distributed,!!rows);
    const oldest=service==='oldest';
    // Deterministic spatial service survives compatible retargets. The pointer
    // retains alternate turns; broad refinement is never gated on a full stage.
    if(service==='distributed'){
      const k=((this.turns-2)/4)%16;
      const x=((k&1)<<1)|((k>>2)&1), y=(((k>>1)&1)<<1)|((k>>3)&1);
      demand={...demand,x:(x+.5)*this.width/4,y:(y+.5)*this.height/4};
    }
    let index = 0;
    for (let i=1; i<this.pending.length; i++) {
      if (oldest ? this.pending[i].order < this.pending[index].order :
        this.score(this.pending[i],demand) > this.score(this.pending[index],demand)) index=i;
    }
    let region = this.pending.splice(index,1)[0];
    while (Math.ceil(region.width/region.stride)*Math.ceil(region.height/region.stride) > budget || rows && region.height > rows) {
      const horizontal = rows ? false : region.width >= region.height;
      const length = horizontal ? region.width : region.height;
      const alignment=Math.max(8,region.stride);
      if (length <= alignment) break;
      const half = rows ? Math.min(rows,length-1) : Math.max(alignment,Math.floor(length/(alignment*2))*alignment);
      const a = {...region}, b = {...region};
      if (horizontal) { a.width=half; b.x+=half; b.width-=half; }
      else { a.height=half; b.y+=half; b.height-=half; }
      const first = rows || oldest || this.score(a,demand) >= this.score(b,demand);
      region = first ? a : b;
      this.pending.push({...(first ? b : a), order:this.turns});
    }
    return region;
  }
}
