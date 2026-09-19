import Decimal from 'decimal.js';

export type Family = 'mandelbrot' | 'julia';
export interface SavedView { family: Family; x: string; y: string; span: string; jx: string; jy: string; iterations: number }
export const HOME: SavedView = {family:'mandelbrot',x:'-0.6',y:'0',span:'2.8',jx:'-0.8',jy:'0.156',iterations:1000};
export function validateView(value: unknown): SavedView {
  const v = value as SavedView;
  if (!v || !['mandelbrot','julia'].includes(v.family)) throw Error('Invalid fractal');
  for (const k of ['x','y','span','jx','jy'] as const) {
    if (typeof v[k] !== 'string' || v[k].length>12000 || !/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(v[k]) || !new Decimal(v[k]).isFinite()) throw Error(`Invalid ${k}`);
  }
  if(new Decimal(v.span).lte(0) || new Decimal(v.span).gt(8)) throw Error('Span must be positive and at most 8');
  // 256 u32 limbs provide 8160 fractional bits. Leave room for pixels and
  // the orbit guard precision before allocating decimal camera arithmetic.
  if(new Decimal(v.span).e < -2400) throw Error('This view exceeds the current GPU precision profiles');
  if(!Number.isInteger(v.iterations)||v.iterations<32||v.iterations>200000) throw Error('Iteration limit must be 32–200000');
  for(const k of ['x','y','jx','jy'] as const) if(new Decimal(v[k]).abs().gt(16)) throw Error('Coordinates must be within ±16');
  return {family:v.family,x:v.x,y:v.y,span:v.span,jx:v.jx,jy:v.jy,iterations:v.iterations};
}
export function encodeView(v: SavedView): string { return encodeURIComponent(JSON.stringify(validateView(v))); }
export function decodeView(s: string): SavedView { return validateView(JSON.parse(decodeURIComponent(s))); }
export class Camera {
  x = new Decimal(HOME.x); y = new Decimal(HOME.y); span = new Decimal(HOME.span);
  revision = 0;
  load(v: SavedView) { this.x=new Decimal(v.x);this.y=new Decimal(v.y);this.span=new Decimal(v.span);this.precision();this.revision++; }
  precision() { Decimal.set({precision:Math.max(100,-this.span.e+85)}); }
  point(px:number,py:number,width:number,height:number) {const u=this.span.div(height);return {x:this.x.plus(u.times(px-width/2)),y:this.y.plus(u.times(height/2-py))};}
  zoom(logFactor:number,px:number,py:number,width:number,height:number) {
    this.precision();const next=this.span.times(Math.exp(logFactor));if(next.gt(8))return;
    const before=this.point(px,py,width,height);this.span=next;
    const after=this.point(px,py,width,height);this.x=this.x.plus(before.x.minus(after.x));this.y=this.y.plus(before.y.minus(after.y));this.revision++;
  }
  pan(dx:number,dy:number,height:number) {this.precision();const u=this.span.div(height);this.x=this.x.minus(u.times(dx));this.y=this.y.plus(u.times(dy));this.revision++;}
}
