import type { ColorSettings } from './logic/colorSettings';

export const DEFAULT_ROTATION_SECONDS=10;
export const PALETTE_ROTATION_MULTIPLIER=4;
export function normalizeRotationSeconds(value:unknown){return typeof value==='number'&&Number.isFinite(value)?Math.max(1,Math.min(60,value)):DEFAULT_ROTATION_SECONDS;}
export function rotationSecondsFromSlider(value:number){return 60**(1-Math.max(0,Math.min(1,value)));}
export function rotationSecondsToSlider(seconds:number){return 1-Math.log(normalizeRotationSeconds(seconds))/Math.log(60);}
export function rotationDurationLabel(seconds:number){
  const rounded=Math.round(seconds*10)/10;
  if(rounded<60)return `${rounded} s`;
  const minutes=Math.floor(rounded/60),remainder=Math.round((rounded-minutes*60)*10)/10;
  return `${minutes} min${remainder?` ${remainder} s`:''}`;
}
/** The slider sets the light's period; a full palette cycle takes four times longer. */
export function advanceColourRotation(colors:ColorSettings,elapsedSeconds:number,period:number,palette:boolean,light:boolean,reverse=false):ColorSettings{
  if(!(elapsedSeconds>0)||(!palette&&!light))return colors;
  const turns=elapsedSeconds/normalizeRotationSeconds(period)*(reverse?-1:1);
  const wrap=(value:number,period:number)=>((value%period)+period)%period;
  return {...colors,...(palette?{offset:wrap(colors.offset+turns/PALETTE_ROTATION_MULTIPLIER,1)}:{}),...(light?{lightAngle:wrap(colors.lightAngle+turns*360,360)}:{})};
}
