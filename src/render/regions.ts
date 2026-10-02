/** Pending exact pixel rectangles. Coordinates and splits are workgroup aligned. */
export interface Region { x: number; y: number; width: number; height: number; order: number; stride: number }
export interface Demand {
  x: number; y: number;
  /** Positive inward, negative outward; pan is represented by exposed bounds. */
  zoom: number;
  covered: { x: number; y: number; width: number; height: number; spacing?: number }[];
  /** Visible area inside an overscanned work field; deficits here take priority. */
  visible?: {x:number;y:number;width:number;height:number};
  /** Forecast changes ranking only; current coverage and sample ownership remain authoritative. */
  predicted?: {x:number;y:number;width:number;height:number;spacing:number};
}
export interface RegionTuning {
  pointer: number;
  distributed: number;
  oldest: number;
  pointerRadius: number;
  pointerRefinement?: boolean;
}
/** Flatten once per selection, so every candidate uses the same weighted union. */
function disjointCoverage(covered: Demand['covered']) {
  const pieces=covered.filter(c=>c.width>0&&c.height>0).map(c=>({...c,right:c.x+c.width,bottom:c.y+c.height,quality:1/(c.spacing??1)}));
  const xs=[...new Set(pieces.flatMap(c=>[c.x,c.right]))].sort((a,b)=>a-b);
  // Share stable y order across slabs; inactive pieces never change counts.
  const events=pieces.flatMap(c=>[{y:c.y,q:c.quality,delta:1,x:c.x,right:c.right},{y:c.bottom,q:c.quality,delta:-1,x:c.x,right:c.right}]).sort((a,b)=>a.y-b.y);
  const result:Demand['covered']=[];
  type Span={bottom:number;rectangle:Demand['covered'][number]};
  let previousSlab=new Map<number,Span>();
  for(let i=1;i<xs.length;i++){
    const counts=new Map<number,number>(),slab=new Map<number,Span>();
    let quality=0,start=events[0]?.y??0;
    for(let j=0;j<events.length;){
      const y=events[j].y,previousQuality=quality;
      do{
        const e=events[j++];
        if(!(e.x<xs[i]&&e.right>xs[i-1]))continue;
        const count=(counts.get(e.q)??0)+e.delta;
        if(count)counts.set(e.q,count);else counts.delete(e.q);
        if(e.delta>0)quality=Math.max(quality,e.q);
        else if(e.q===quality&&!count)quality=Math.max(0,...counts.keys());
      }while(j<events.length&&events[j].y===y);
      // Hidden coarse boundaries do not split the finest covered density.
      if(quality===previousQuality)continue;
      if(previousQuality>0&&y>start){
        const spacing=1/previousQuality,prior=previousSlab.get(start);
        // Join only exact adjacent intervals: no snapping or gap filling.
        if(prior&&prior.bottom===y&&prior.rectangle.spacing===spacing){
          prior.rectangle.width=xs[i]-prior.rectangle.x;slab.set(start,prior);
        }else{
          const rectangle={x:xs[i-1],y:start,width:xs[i]-xs[i-1],height:y-start,spacing};
          result.push(rectangle);slab.set(start,{bottom:y,rectangle});
        }
      }
      start=y;
    }
    previousSlab=slab;
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
export function schedulerService(turn:number,distributed:boolean,rows=false,tuning?:RegionTuning):'pointer'|'distributed'|'oldest'{
  // Keep two pointer selections between evenly spaced oldest/distributed turns.
  // Other weights and unavailable-distributed fallbacks retain their behaviour.
  if(tuning?.pointer===12 && tuning.distributed===3 && tuning.oldest===3 && distributed && !rows){
    const phase=(turn-1)%6;
    return phase===2?'oldest':phase===5?'distributed':'pointer';
  }
  // The incumbent 4:2:2 sequence is intentional, including its row fallback.
  if(!tuning || tuning.pointer===8 && tuning.distributed===4 && tuning.oldest===4)
    return turn%4===0?'oldest':distributed&&turn%2===0&&!rows?'distributed':'pointer';
  const weights=[tuning.pointer,distributed&&!rows?tuning.distributed:0,tuning.oldest]
    .map(n=>Number.isFinite(n)?Math.max(0,Math.min(64,Math.trunc(n))):0);
  // Distributed work cannot run in row mode or without sparse refinement.
  if(!weights.some(Boolean))weights[0]=1;
  const total=weights[0]+weights[1]+weights[2];
  const balance=[0,0,0];
  let chosen=0;
  // Smooth weighted round robin repeats within at most 192 turns. Deriving the
  // current turn avoids scheduler state changes across compatible retargets.
  for(let n=0;n<((turn-1)%total)+1;n++){
    for(let i=0;i<3;i++)balance[i]+=weights[i];
    chosen=0;
    for(let i=1;i<3;i++)if(balance[i]>balance[chosen])chosen=i;
    balance[chosen]-=total;
  }
  return (['pointer','distributed','oldest'] as const)[chosen];
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
  private distributedTurns=0;
  private deficits=new Map<Region,number>();
  private coverage:Demand['covered']=[];
  private previewStride=1;
  reset(width: number, height: number, previewStride=1, compatible=false, singlePreview=false) {
    this.width=width;this.height=height;
    this.previewStride=previewStride;
    this.distributed=previewStride>1;
    this.pending = width && height ? [{ x: 0, y: 0, width, height, order: 0, stride: 1 }] : [];
    if(!compatible){this.turns=0;this.distributedTurns=0;}
    for(let stride=2;width&&height&&stride<=previewStride;stride*=2)
      if(!singlePreview||stride===previewStride)
        this.pending.push({x:0,y:0,width,height,order:0,stride});
  }
  get size() { return this.pending.length; }
  /** Adopt the existing settled preview policy without restarting exact work. */
  settle(previewStride:number) {
    this.pending=this.pending.filter(r=>r.stride===1||r.stride===previewStride);
  }
  private deficit(r: Region, d: Demand) {
    let value=this.deficits.get(r);
    if(value===undefined){value=disjointDeficit(r,this.coverage);this.deficits.set(r,value);}
    return value;
  }
  private score(r: Region, d: Demand, pointerRadius=64) {
    const dx = Math.max(r.x - d.x, 0, d.x - r.x - r.width + 1);
    const dy = Math.max(r.y - d.y, 0, d.y - r.y - r.height + 1);
    const deficit=this.deficit(r,d);
    const v=d.visible;
    const visibleArea=v?Math.max(0,Math.min(r.x+r.width,v.x+v.width)-Math.max(r.x,v.x))*
      Math.max(0,Math.min(r.y+r.height,v.y+v.height)-Math.max(r.y,v.y)):0;
    const visiblePriority=deficit>0?8*visibleArea/(r.width*r.height):0;
    const p=d.predicted;
    const px=p?Math.max(r.x,p.x):0,py=p?Math.max(r.y,p.y):0;
    const pw=p?Math.max(0,Math.min(r.x+r.width,p.x+p.width)-px):0;
    const ph=p?Math.max(0,Math.min(r.y+r.height,p.y+p.height)-py):0;
    const predictedPriority=pw*ph>0?8*pw*ph/(r.width*r.height)*disjointDeficit(
      {...r,x:px,y:py,width:pw,height:ph,stride:Math.max(1,p!.spacing)},this.coverage):0;
    // Sparse samples cover stride squared pixels per calculation, but only
    // improve linear resolution by stride. Use that conservative cost benefit.
    if(r.stride>1) return deficit*4*Math.sqrt(r.stride) + visiblePriority + predictedPriority + .5 / (1 + Math.hypot(dx,dy) / pointerRadius);
    const focusWeight=this.distributed&&this.turns%2===1?4:1;
    return deficit * 4 + visiblePriority + predictedPriority + focusWeight / (1 + Math.hypot(dx,dy) / pointerRadius);
  }
  /** Only changes density inside the selected region; never chooses its priority. */
  private nextStride(r:Region,d:Demand,levels:number):number {
    const v=d.visible;
    const x=Math.max(r.x,v?.x??r.x),y=Math.max(r.y,v?.y??r.y);
    const right=Math.min(r.x+r.width,v?v.x+v.width:r.x+r.width);
    const bottom=Math.min(r.y+r.height,v?v.y+v.height:r.y+r.height);
    if(right<=x||bottom<=y)return r.stride;
    let area=0,spacing=1;
    for(const c of this.coverage){
      const w=Math.min(right,c.x+c.width)-Math.max(x,c.x);
      const h=Math.min(bottom,c.y+c.height)-Math.max(y,c.y);
      if(w>0&&h>0){area+=w*h;spacing=Math.max(spacing,c.spacing??1);}
    }
    // Missing coverage gets the incumbent preview, not invented sample validity.
    let next=area<(right-x)*(bottom-y)-1e-6 ? this.previewStride :
      Math.min(this.previewStride,2**Math.max(0,Math.ceil(Math.log2(spacing))-levels));
    // Shading addresses anchors on the global power-of-two lattice. A region
    // previously split at a finer density must not introduce shifted anchors.
    while(next>r.stride&&(r.x%next!==0||r.y%next!==0))next/=2;
    return Math.max(r.stride,next);
  }
  take(budget: number, demand: Demand, rows?: number, tuning?: RegionTuning, gradual=false): Region | undefined {
    this.deficits.clear();
    this.coverage=disjointCoverage(demand.covered);
    this.pending=this.pending.filter(r=>r.stride===1 || this.deficit(r,demand)>0);
    if (!this.pending.length) return;
    // Two oldest turns per eight prevent a moving focus from starving gaps.
    const service=schedulerService(++this.turns,this.distributed,!!rows,tuning);
    // Pointer turns favour navigable detail; other turns retain broad progress.
    const refinementLevels=service==='pointer'&&tuning?.pointerRefinement!==false?2:1;
    const oldest=service==='oldest';
    const pointerRadius=service==='pointer' && tuning && Number.isFinite(tuning.pointerRadius)
      ? Math.max(16,Math.min(512,tuning.pointerRadius)) : 64;
    // Deterministic spatial service survives compatible retargets. The pointer
    // retains alternate turns; broad refinement is never gated on a full stage.
    if(service==='distributed'){
      const incumbentWeights=!tuning || tuning.pointer===8 && tuning.distributed===4 && tuning.oldest===4;
      const k=incumbentWeights?((this.turns-2)/4)%16:this.distributedTurns++%16;
      const x=((k&1)<<1)|((k>>2)&1), y=(((k>>1)&1)<<1)|((k>>3)&1);
      demand={...demand,x:(x+.5)*this.width/4,y:(y+.5)*this.height/4};
    }
    let index = 0;
    for (let i=1; i<this.pending.length; i++) {
      if (oldest ? this.pending[i].order < this.pending[index].order :
        this.score(this.pending[i],demand,pointerRadius) > this.score(this.pending[index],demand,pointerRadius)) index=i;
    }
    let region = this.pending.splice(index,1)[0];
    const originalStride=region.stride;
    if(gradual&&!rows)region={...region,stride:this.nextStride(region,demand,refinementLevels)};
    while (Math.ceil(region.width/region.stride)*Math.ceil(region.height/region.stride) > budget || rows && region.height > rows) {
      const horizontal = rows ? false : region.width >= region.height;
      const length = horizontal ? region.width : region.height;
      const alignment=Math.max(8,region.stride);
      if (length <= alignment) break;
      const half = rows ? Math.min(rows,length-1) : Math.max(alignment,Math.floor(length/(alignment*2))*alignment);
      const a = {...region}, b = {...region};
      if (horizontal) { a.width=half; b.x+=half; b.width-=half; }
      else { a.height=half; b.y+=half; b.height-=half; }
      const first = rows || oldest || this.score(a.stride===originalStride?a:{...a,stride:originalStride},demand,pointerRadius) >=
        this.score(b.stride===originalStride?b:{...b,stride:originalStride},demand,pointerRadius);
      region = first ? a : b;
      this.pending.push({...(first ? b : a),stride:originalStride, order:this.turns});
      // A coarse neighbour may have determined the parent's density. Once the
      // incumbent spatial selection isolates a finer child, use that child's
      // own next level and recheck the same budget before dispatching it.
      if(gradual&&!rows)region={...region,stride:this.nextStride({...region,stride:originalStride},demand,refinementLevels)};
    }
    // This coarse visit supplements, rather than consumes, the selected work.
    // Exact obligations remain disjoint and survive release to stationary mode.
    if(region.stride!==originalStride)this.pending.push({...region,stride:originalStride});
    return region;
  }
}
