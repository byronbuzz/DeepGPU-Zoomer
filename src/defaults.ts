import { validateColors, type ColorSettings } from './logic/colorSettings';
import { normalizeTuning, migrateSavedTuning, type TuningSettings } from './tuning';
import { normalizePanelSettings, type PanelSettings } from './panels';
import { normalizeRotationSeconds } from './colour-rotation';

export const DEFAULTS_STORAGE_KEY='gpu-zoomer-defaults-v1';
/** Deliberately excludes camera geometry, family and Julia constants. */
export interface SavedDefaults {
  appearance:ColorSettings;
  tuning:TuningSettings;
  speed:number;
  baseIterations:number;
  dynamicEnabled:boolean;
  rotationSeconds:number;rotatePalette:boolean;rotateLight:boolean;reverseRotation:boolean;
  panels:PanelSettings;
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validateDefaults(value:unknown):SavedDefaults {
  if(!object(value)||!object(value.appearance)||!object(value.tuning)||!object(value.panels)||
    typeof value.speed!=='number'||!Number.isFinite(value.speed)||value.speed<.2||value.speed>3||
    typeof value.baseIterations!=='number'||!Number.isInteger(value.baseIterations)||value.baseIterations<1||value.baseIterations>10_000_000||
    typeof value.dynamicEnabled!=='boolean')throw new Error('Saved defaults are invalid.');
  return {appearance:validateColors(value.appearance),tuning:normalizeTuning(value.tuning),speed:value.speed,
    baseIterations:value.baseIterations,dynamicEnabled:value.dynamicEnabled,panels:normalizePanelSettings(value.panels),
    rotationSeconds:normalizeRotationSeconds(value.rotationSeconds),rotatePalette:value.rotatePalette===true,rotateLight:value.rotateLight===true,reverseRotation:value.reverseRotation===true};
}
export function readDefaults(storage?:Pick<Storage,'getItem'>):{value:SavedDefaults|null;error:string|null}{
  try{
    const raw=(storage??localStorage).getItem(DEFAULTS_STORAGE_KEY);
    if(raw===null)return {value:null,error:null};
    const parsed:unknown=JSON.parse(raw);
    if(!object(parsed)||parsed.version!==1)throw new Error('Unsupported saved defaults.');
    const defaults=validateDefaults(parsed.settings);
    return {value:{...defaults,tuning:migrateSavedTuning((parsed.settings as Record<string,unknown>).tuning)},error:null};
  }catch{return {value:null,error:'Saved defaults could not be read. Factory settings will be used.'};}
}
export function saveDefaults(value:SavedDefaults,storage?:Pick<Storage,'setItem'>):{error:string|null}{
  try{const settings=validateDefaults(value);(storage??localStorage).setItem(DEFAULTS_STORAGE_KEY,JSON.stringify({version:1,settings}));return {error:null};}
  catch{return {error:'This browser could not save defaults locally. Previous saved defaults were kept.'};}
}
