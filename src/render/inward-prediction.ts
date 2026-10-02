import Decimal from 'decimal.js';
import { rotationBasis } from '../rotation';
import type { FrameView } from './reprojection';

export interface PredictedGridDemand {
  x:number;y:number;width:number;height:number;spacing:number;
}

/** Ranking geometry in an existing unrotated field. Presentation reuse cutoffs
 * do not apply: a narrow future viewport still identifies useful pending work. */
export function predictedGridDemand(field:FrameView,forecast:FrameView):PredictedGridDemand|null {
  for(const view of [field,forecast]){
    if((view.angle??0)!==0||!Number.isSafeInteger(view.width)||view.width<=0||
        !Number.isSafeInteger(view.height)||view.height<=0||!view.centerX.isFinite()||
        !view.centerY.isFinite()||!view.unitsPerPixel.isFinite()||view.unitsPerPixel.lte(0))return null;
  }
  const precision=Math.max(100,Decimal.precision,
    ...[field,forecast].flatMap(view=>[view.centerX.sd()+32,view.centerY.sd()+32,view.unitsPerPixel.sd()+32]),
    Math.max(0,field.centerX.e,field.centerY.e,forecast.centerX.e,forecast.centerY.e)-
      Math.min(field.unitsPerPixel.e,forecast.unitsPerPixel.e)+85);
  if(!Number.isSafeInteger(precision)||precision>1e9)return null;
  const D=Decimal.clone({precision,rounding:Decimal.ROUND_HALF_UP});
  const spacing=new D(forecast.unitsPerPixel).div(field.unitsPerPixel);
  const width=spacing.times(forecast.width),height=spacing.times(forecast.height);
  const x=new D(forecast.centerX).minus(field.centerX).div(field.unitsPerPixel).plus(field.width/2).minus(width.div(2));
  const y=new D(field.centerY).minus(forecast.centerY).div(field.unitsPerPixel).plus(field.height/2).minus(height.div(2));
  const rectangle={x:x.toNumber(),y:y.toNumber(),width:width.toNumber(),height:height.toNumber(),spacing:spacing.toNumber()};
  return Object.values(rectangle).every(Number.isFinite)&&rectangle.width>0&&rectangle.height>0&&rectangle.spacing>0
    ?rectangle:null;
}

/** Forecast geometry only. The caller owns held-zoom eligibility and stability;
 * neither the camera nor the numerical field is advanced by this prediction. */
export function predictInwardView(view:FrameView,focus:{x:number;y:number},
  ratePerSecond:number,completionMs:number,multiplier:number):FrameView|null {
  if(!Number.isFinite(ratePerSecond)||ratePerSecond<=0||
      !Number.isFinite(completionMs)||completionMs<=0||
      !Number.isFinite(multiplier)||multiplier<=0||
      !Number.isFinite(focus.x)||focus.x<0||focus.x>1||
      !Number.isFinite(focus.y)||focus.y<0||focus.y>1||
      !Number.isSafeInteger(view.width)||view.width<=0||
      !Number.isSafeInteger(view.height)||view.height<=0||
      !Number.isFinite(view.angle??0)||!view.centerX.isFinite()||!view.centerY.isFinite()||
      !view.unitsPerPixel.isFinite()||view.unitsPerPixel.lte(0))return null;
  const horizonMs=Math.min(2000,completionMs*Math.min(16,multiplier));
  // Camera.zoom uses this same natural-exponential span ratio.
  const factor=Math.exp(-ratePerSecond*horizonMs/1000);
  if(!(factor>0&&factor<1))return null;
  // Keep all supplied centre digits and enough absolute precision to add a
  // sub-pixel displacement at deep zoom, independent of shared Decimal state.
  const precision=Math.max(100,Decimal.precision,view.centerX.sd()+32,view.centerY.sd()+32,
    view.unitsPerPixel.sd()+32,Math.max(0,view.centerX.e,view.centerY.e)-view.unitsPerPixel.e+85);
  if(!Number.isSafeInteger(precision)||precision>1e9)return null;
  const D=Decimal.clone({precision,rounding:Decimal.ROUND_HALF_UP});
  const unitsPerPixel=new D(view.unitsPerPixel).times(factor);
  const displacement=new D(view.unitsPerPixel).minus(unitsPerPixel);
  const dx=new D(focus.x).minus(.5).times(view.width);
  const dy=new D(.5).minus(focus.y).times(view.height);
  const {c,s}=rotationBasis(view.angle??0);
  return {...view,unitsPerPixel,
    centerX:new D(view.centerX).plus(displacement.times(dx.times(c).minus(dy.times(s)))),
    centerY:new D(view.centerY).plus(displacement.times(dx.times(s).plus(dy.times(c))))};
}
