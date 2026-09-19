/** Pending exact pixel rectangles. Coordinates and splits are workgroup aligned. */
export interface Region { x: number; y: number; width: number; height: number; order: number; stride: number }
export interface Demand {
  x: number; y: number;
  /** Positive inward, negative outward; pan is represented by exposed bounds. */
  zoom: number;
  covered: { x: number; y: number; width: number; height: number; spacing?: number }[];
}
export class PendingRegions {
  private pending: Region[] = [];
  private turns = 0;
  reset(width: number, height: number, previewStride=1) {
    this.pending = width && height ? [{ x: 0, y: 0, width, height, order: 0, stride: 1 }] : []; this.turns = 0;
    if(width && height && previewStride>1) this.pending.push({x:0,y:0,width,height,order:0,stride:previewStride});
  }
  get size() { return this.pending.length; }
  private deficit(r: Region, d: Demand) {
    // The renderer supplies at most two conservative source rectangles. Weight
    // their union by useful density, counting the finer source in the overlap.
    const intersection = (a: Demand['covered'][number], b: Demand['covered'][number]) => ({
      x:Math.max(a.x,b.x), y:Math.max(a.y,b.y),
      width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)),
      height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)),
    });
    const pieces=d.covered.map(c=>({...intersection(r,c), quality:Math.min(1,r.stride/(c.spacing??1))}));
    const overlap=pieces.length===2 ? intersection(pieces[0],pieces[1]) : {width:0,height:0};
    const covered=pieces.reduce((area,c)=>area+c.width*c.height*c.quality,0)-
      overlap.width*overlap.height*(pieces.length===2 ? Math.min(pieces[0].quality,pieces[1].quality) : 0);
    return Math.max(0,1-covered/(r.width*r.height));
  }
  private score(r: Region, d: Demand) {
    const dx = Math.max(r.x - d.x, 0, d.x - r.x - r.width + 1);
    const dy = Math.max(r.y - d.y, 0, d.y - r.y - r.height + 1);
    const deficit=this.deficit(r,d);
    // Sparse samples cover stride squared pixels per calculation, but only
    // improve linear resolution by stride. Use that conservative cost benefit.
    if(r.stride>1) return deficit*r.stride*(d.zoom<=0 ? 4 : 1);
    return (d.zoom <= 0 ? deficit * 4 : 0) + 1 / (1 + Math.hypot(dx,dy) / 64);
  }
  take(budget: number, demand: Demand, rows?: number): Region | undefined {
    this.pending=this.pending.filter(r=>r.stride===1 || this.deficit(r,demand)>0);
    if (!this.pending.length) return;
    // A regular oldest turn prevents a moving focus from starving other gaps.
    const oldest = ++this.turns % 8 === 0;
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
