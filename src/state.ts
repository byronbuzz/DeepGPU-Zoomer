import Decimal from 'decimal.js';
import { validateColors, type ColorSettings } from './logic/colorSettings';
import { rotationBasis } from './rotation';
import { parseCoordinateInput } from './coordinate';

export type Family = 'mandelbrot' | 'julia';
export interface SavedView { family: Family; x: string; y: string; span: string; jx: string; jy: string; iterations: number; angle?: number; appearance?: ColorSettings }
export const MAX_ITERATIONS=1_000_000;
export function iterationFromSlider(value:number){return Math.round(Math.pow(MAX_ITERATIONS,Math.max(0,Math.min(1,value))));}
export function iterationToSlider(value:number){return Math.log(value)/Math.log(MAX_ITERATIONS);}
export function depthLabel(span:Decimal){const ratio=new Decimal(2.8).div(span);return `10^${(ratio.e+Math.log10(Number(ratio.toExponential(14).split('e')[0]))).toFixed(2)}×`;}
export const HOME: SavedView = {family:'mandelbrot',x:'-0.6',y:'0',span:'2.8',jx:'-0.8',jy:'0.156',iterations:5000,angle:0};
export function homePosition(view:SavedView):SavedView {
  return {...view,x:view.family==='julia'?'0':HOME.x,y:'0',span:HOME.span};
}
export function validateView(value: unknown): SavedView {
  const v = value as SavedView;
  if (!v || !['mandelbrot','julia'].includes(v.family)) throw Error('Invalid fractal');
  for (const k of ['x','y','span','jx','jy'] as const) parseCoordinateInput(v[k], k);
  if(new Decimal(v.span).lte(0) || new Decimal(v.span).gt(8)) throw Error('Span must be positive and at most 8');
  // 256 u32 limbs provide 8160 fractional bits. Leave room for pixels and
  // the orbit guard precision before allocating decimal camera arithmetic.
  if(new Decimal(v.span).e < -2400) throw Error('This view exceeds the current GPU precision profiles');
  if(!Number.isInteger(v.iterations)||v.iterations<1||v.iterations>MAX_ITERATIONS) throw Error('Iteration limit must be 1–1000000');
  if(v.angle!==undefined&&(!Number.isFinite(v.angle)||v.angle < -180||v.angle > 180))throw Error('Rotation must be between −180° and 180°');
  for(const k of ['x','y','jx','jy'] as const) if(new Decimal(v[k]).abs().gt(16)) throw Error('Coordinates must be within ±16');
  // Old links may contain iterationMode; fixed limits are now the only policy.
  return {family:v.family,x:v.x,y:v.y,span:v.span,jx:v.jx,jy:v.jy,iterations:v.iterations,angle:v.angle??0,...(v.appearance?{appearance:validateColors(v.appearance)}:{})};
}
export function encodeView(v: SavedView): string { return encodeURIComponent(JSON.stringify(validateView(v))); }
export function decodeView(s: string): SavedView { return validateView(JSON.parse(decodeURIComponent(s))); }
export class Camera {
  x = new Decimal(HOME.x); y = new Decimal(HOME.y); span = new Decimal(HOME.span);
  angle = 0;
  revision = 0;
  load(v: SavedView) { this.x=new Decimal(v.x);this.y=new Decimal(v.y);this.span=new Decimal(v.span);this.angle=v.angle??0;this.precision();this.revision++; }
  precision() { Decimal.set({precision:Math.max(100,-this.span.e+85)}); }
  point(px:number,py:number,width:number,height:number) {
    const u=this.span.div(height),dx=px-width/2,dy=height/2-py;
    if(this.angle===0)return {x:this.x.plus(u.times(dx)),y:this.y.plus(u.times(dy))};
    const {c,s}=rotationBasis(this.angle);
    return {x:this.x.plus(u.times(new Decimal(dx).times(c).minus(new Decimal(dy).times(s)))),
      y:this.y.plus(u.times(new Decimal(dx).times(s).plus(new Decimal(dy).times(c))))};
  }
  setAngle(angle:number){if(!Number.isFinite(angle))throw Error('Invalid rotation');while(angle>180)angle-=360;while(angle< -180)angle+=360;if(angle!==this.angle){this.angle=angle;this.revision++;}}
  rotate(delta:number){this.setAngle(this.angle+delta);}
  zoom(logFactor:number,px:number,py:number,width:number,height:number) {
    this.precision();const next=this.span.times(Math.exp(logFactor));if(next.gt(8))return;
    const before=this.point(px,py,width,height);this.span=next;
    const after=this.point(px,py,width,height);this.x=this.x.plus(before.x.minus(after.x));this.y=this.y.plus(before.y.minus(after.y));this.revision++;
  }
  pan(dx:number,dy:number,height:number) {this.precision();const u=this.span.div(height);
    if(this.angle===0){this.x=this.x.minus(u.times(dx));this.y=this.y.plus(u.times(dy));}
    else {const {c,s}=rotationBasis(this.angle);
      this.x=this.x.minus(u.times(new Decimal(dx).times(c).plus(new Decimal(dy).times(s))));
      this.y=this.y.minus(u.times(new Decimal(dx).times(s).minus(new Decimal(dy).times(c))));}
    this.revision++;}
}
