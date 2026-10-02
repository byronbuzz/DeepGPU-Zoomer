import {describe,it,expect} from 'vitest';
import {DEFAULTS_STORAGE_KEY,readDefaults,saveDefaults,validateDefaults,type SavedDefaults} from '../src/defaults';
import {DEFAULT_COLORS} from '../src/logic/colorSettings';
import {DEFAULT_TUNING} from '../src/tuning';
import {normalizePanelSettings} from '../src/panels';

const fixture=():SavedDefaults=>({appearance:{...DEFAULT_COLORS,stops:[...DEFAULT_COLORS.stops]},tuning:{...DEFAULT_TUNING},speed:1.3,
  baseIterations:12000,dynamicEnabled:false,profilingEnabled:true,randomStyle:'unrestricted',
  panels:normalizePanelSettings({positions:{controls:{x:20,y:30,width:360,height:600}},accent:'#abcdef',opacity:.6,
    activeTab:'tab-colouring',details:{'edit-palette':true},controlsHidden:true})});
describe('explicit durable defaults',()=>{
  it('round trips durable choices without camera geometry and remains isolated from ordinary storage',()=>{
    const entries=new Map<string,string>();const storage={getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>{entries.set(key,value);}};
    const settings=fixture();
    expect(saveDefaults({...settings,...{x:'1e-200',span:'1e-300',family:'julia'}},storage)).toEqual({error:null});
    const saved=entries.get(DEFAULTS_STORAGE_KEY)!;
    expect(JSON.parse(saved).settings).not.toHaveProperty('span');
    expect(JSON.parse(saved).settings).not.toHaveProperty('family');
    storage.setItem('gpu-zoomer-view','{}');storage.setItem('gpu-zoomer-layout','{}');
    expect(readDefaults(storage)).toEqual({value:validateDefaults(settings),error:null});
    expect(entries.get(DEFAULTS_STORAGE_KEY)).toBe(saved);
    settings.appearance.stops[0]='#ffffff';
    expect(readDefaults(storage).value!.appearance.stops).not.toEqual(settings.appearance.stops);
  });
  it('fails cleanly for malformed versions, invalid controls and inaccessible storage',()=>{
    expect(readDefaults({getItem:()=>null})).toEqual({value:null,error:null});
    for(const raw of ['{',JSON.stringify({version:9}),JSON.stringify({version:1,settings:{...fixture(),speed:Infinity}})]){
      const result=readDefaults({getItem:()=>raw});expect(result.value).toBeNull();expect(result.error).toBeTruthy();
    }
    expect(readDefaults({getItem:()=>{throw new Error('SecurityError');}}).error).toBeTruthy();
    expect(saveDefaults(fixture(),{setItem:()=>{throw new Error('QuotaExceededError');}}).error).toBeTruthy();
  });
  it('sanitizes panel IDs, positions and styles without retaining arbitrary properties',()=>{
    expect(normalizePanelSettings({positions:{controls:{x:NaN,y:8},'png-export':{x:20,y:30,width:500},unexpected:{x:0,y:0}},
      opacity:8,accent:'url(evil)',activeTab:'unknown',details:{lighting:true,unexpected:true},controlsHidden:'true'}))
      .toEqual({positions:{'png-export':{x:20,y:30}},opacity:1,accent:'#eba046',activeTab:'tab-main',
        details:{'edit-palette':false,lighting:true},controlsHidden:false,hideStatusWithMenu:false});
  });
  it('preserves both resizable panels and bounds malformed saved dimensions',()=>{
    const positions=normalizePanelSettings({positions:{
      controls:{x:8,y:16,width:480,height:640},
      'julia-preview':{x:20,y:40,width:720,height:560},
    }}).positions;
    expect(positions.controls).toEqual({x:8,y:16,width:480,height:640});
    expect(positions['julia-preview']).toEqual({x:20,y:40,width:720,height:560});
    expect(normalizePanelSettings({positions:{'julia-preview':{x:8,y:8,width:Infinity,height:-1}}}).positions['julia-preview']).toEqual({x:8,y:8});
    expect(normalizePanelSettings({positions:{controls:{x:8,y:8,width:1e9,height:.5}}}).positions.controls).toEqual({x:8,y:8,width:32768,height:1});
  });
});
