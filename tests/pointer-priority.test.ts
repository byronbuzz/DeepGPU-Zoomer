import {describe,expect,it,vi} from 'vitest';
import {DEFAULT_TUNING,EDITABLE_TUNING_KEYS,POINTER_RATIOS,TUNING_STORAGE_KEY,loadTuning,saveTuning,
  normalizeTuning,modifiedTuningCount,type TuningSettings} from '../src/tuning';
import {schedulerService,type RegionTuning} from '../src/render/regions';
import {RANGE_DEFAULTS,setupRangeControls} from '../src/range-controls';
import {DEFAULTS_STORAGE_KEY,readDefaults,saveDefaults,type SavedDefaults} from '../src/defaults';
import {DEFAULT_COLORS,validateColors} from '../src/logic/colorSettings';
import {normalizePanelSettings} from '../src/panels';

const ratios=POINTER_RATIOS;
const regionTuning=(t:TuningSettings):RegionTuning=>({pointer:t.pointerWeight,distributed:t.distributedWeight,
  oldest:t.oldestWeight,pointerRadius:t.pointerRadius});
const services=(count:number,t:TuningSettings,distributed=true,rows=false)=>Array.from({length:count},
  (_,i)=>schedulerService(i+1,distributed,rows,regionTuning(t)));
const counts=(values:string[])=>({pointer:values.filter(value=>value==='pointer').length,
  distributed:values.filter(value=>value==='distributed').length,oldest:values.filter(value=>value==='oldest').length});
const savedDefaults=(tuning:TuningSettings):SavedDefaults=>({appearance:validateColors(DEFAULT_COLORS),tuning,
  speed:.7,baseIterations:10000,dynamicEnabled:true,profilingEnabled:false,randomStyle:'unrestricted',
  panels:normalizePanelSettings({})});

describe('Pointer Priority',()=>{
  it.each(ratios.map((ratio,level)=>({ratio,level})))('selects the $ratio:1:1 service ratio at level $level',({ratio,level})=>{
    const tuning=normalizeTuning({pointerPriority:level});
    expect(tuning.pointerWeight/tuning.distributedWeight).toBe(ratio);
    expect(tuning.distributedWeight).toBe(tuning.oldestWeight);
    const period=tuning.pointerWeight+tuning.distributedWeight+tuning.oldestWeight;
    // Exercise the actual scheduler over several full periods, including the top setting.
    expect(counts(services(period*3,tuning))).toEqual({pointer:tuning.pointerWeight*3,
      distributed:tuning.distributedWeight*3,oldest:tuning.oldestWeight*3});
    expect(modifiedTuningCount(tuning)).toBe(level===1?0:1);
  });

  it('uses the default 2:1:1 weights and four-turn sequence',()=>{
    expect(DEFAULT_TUNING).toMatchObject({pointerPriority:1,pointerWeight:2,distributedWeight:1,oldestWeight:1});
    expect(normalizeTuning({})).toEqual(DEFAULT_TUNING);
    expect(services(12,normalizeTuning({}))).toEqual([
      'pointer','distributed','oldest','pointer',
      'pointer','distributed','oldest','pointer',
      'pointer','distributed','oldest','pointer',
    ]);
  });

  it('keeps oldest work served when distributed work is unavailable',()=>{
    for(let level=0;level<ratios.length;level++){
      const tuning=normalizeTuning({pointerPriority:level}),period=tuning.pointerWeight+tuning.oldestWeight;
      for(const [distributed,rows] of [[false,false],[true,true]]){
        expect(counts(services(period*2,tuning,distributed,rows))).toEqual({pointer:tuning.pointerWeight*2,
          distributed:0,oldest:tuning.oldestWeight*2});
      }
    }
  });

  it('clamps and rounds the new control and defaults invalid or absent values',()=>{
    for(const [input,expected] of [[-5,0],[5,4],[99,4],[.6,1],[3.4,3]] as const)
      expect(normalizeTuning({pointerPriority:input}).pointerPriority).toBe(expected);
    for(const pointerPriority of [undefined,null,NaN,Infinity,-Infinity,'4'])
      expect(normalizeTuning({pointerPriority}).pointerPriority).toBe(1);
  });

  it.each([
    {legacy:{pointerWeight:12,distributedWeight:3,oldestWeight:3},level:2},
    {legacy:{pointerWeight:7},level:1},
    {legacy:{pointerWeight:6,distributedWeight:3,oldestWeight:3},level:1},
    {legacy:{pointerWeight:9,distributedWeight:3,oldestWeight:6},level:1},
    {legacy:{pointerWeight:1,distributedWeight:18,oldestWeight:18},level:0},
    {legacy:{pointerWeight:18,distributedWeight:1,oldestWeight:1},level:3},
  ])('migrates legacy weights $legacy to the closest pointer share',({legacy,level})=>{
    const tuning=normalizeTuning({...legacy,motionPreference:63,dynamicDepthGain:7500,blaPrecisionLog2:-24});
    expect(tuning).toMatchObject({pointerPriority:level,motionPreference:63,dynamicDepthGain:7500,blaPrecisionLog2:-24});
    expect(tuning.pointerWeight/tuning.distributedWeight).toBe(ratios[level]);
    expect(tuning.distributedWeight).toBe(tuning.oldestWeight);
  });

  it('uses the new level instead of obsolete weights when both are present',()=>{
    expect(normalizeTuning({pointerPriority:0,pointerWeight:18,distributedWeight:1,oldestWeight:1}))
      .toMatchObject({pointerPriority:0,pointerWeight:1,distributedWeight:1,oldestWeight:1});
  });

  it('persists one editable priority and reconstructs every ratio on reload',()=>{
    expect(EDITABLE_TUNING_KEYS).toContain('pointerPriority');
    for(const key of ['pointerWeight','distributedWeight','oldestWeight'])expect(EDITABLE_TUNING_KEYS).not.toContain(key);
    const stored=new Map<string,string>(),storage={getItem:(key:string)=>stored.get(key)??null,
      setItem:(key:string,value:string)=>{stored.set(key,value);}};
    for(let pointerPriority=0;pointerPriority<ratios.length;pointerPriority++){
      const tuning=normalizeTuning({pointerPriority,motionPreference:63,dynamicDepthGain:7500,blaPrecisionLog2:-24});
      expect(saveTuning(tuning,storage)).toBe(true);
      const payload=JSON.parse(stored.get(TUNING_STORAGE_KEY)!).settings;
      expect(payload).toEqual(Object.fromEntries(EDITABLE_TUNING_KEYS.map(key=>[key,tuning[key]])));
      expect(loadTuning(storage)).toEqual({...tuning,motionPreference:DEFAULT_TUNING.motionPreference});
    }
  });

  it('migrates both supported local storage versions without losing other controls',()=>{
    for(const version of [2,3]){
      const storage={getItem:(key:string)=>key===`gpu-zoomer-navigation-tuning-v${version}`?
        JSON.stringify({version,settings:{pointerWeight:7,motionPreference:63,dynamicDepthGain:7500,blaPrecisionLog2:-24}}):null};
      expect(loadTuning(storage)).toMatchObject({pointerPriority:1,pointerWeight:2,distributedWeight:1,
        oldestWeight:1,motionPreference:63,dynamicDepthGain:7500,blaPrecisionLog2:-24});
    }
  });

  it('maps every v3 index by its old ratio while current indices retain their new meaning',()=>{
    const expected=[1,2,4,4,8,8,16,16,16,16,16];
    for(const [pointerPriority,ratio] of expected.entries()){
      const storage={getItem:(key:string)=>key==='gpu-zoomer-navigation-tuning-v3'
        ?JSON.stringify({version:3,settings:{pointerPriority}}):null};
      const tuning=loadTuning(storage);
      expect(tuning.pointerWeight/tuning.distributedWeight).toBe(ratio);
    }
    expect(normalizeTuning({pointerPriority:3}).pointerWeight).toBe(8);
    expect(normalizeTuning({pointerPriority:4}).pointerWeight).toBe(16);
  });

  it('migrates explicit saved defaults and keeps the selected level across saving defaults',()=>{
    const stored=new Map<string,string>(),storage={getItem:(key:string)=>stored.get(key)??null,
      setItem:(key:string,value:string)=>{stored.set(key,value);}};
    const legacy={...savedDefaults({...DEFAULT_TUNING}),tuning:{pointerWeight:18,distributedWeight:1,
      oldestWeight:1,dynamicDepthGain:7500,blaPrecisionLog2:-24}};
    stored.set(DEFAULTS_STORAGE_KEY,JSON.stringify({version:1,settings:legacy}));
    const migrated=readDefaults(storage);
    expect(migrated.error).toBeNull();expect(migrated.value?.tuning).toMatchObject({pointerPriority:3,
      pointerWeight:8,distributedWeight:1,oldestWeight:1,dynamicDepthGain:7500,blaPrecisionLog2:-24});
    const current=savedDefaults(normalizeTuning({pointerPriority:0,blaPrecisionLog2:-24}));
    expect(saveDefaults(current,storage).error).toBeNull();expect(readDefaults(storage).value).toEqual(current);
  });

  it('resets the new slider through the existing Control-click handler and emits the change',()=>{
    expect(RANGE_DEFAULTS['tuning-pointer-priority']).toBe(1);
    for(const key of ['tuning-pointer-weight','tuning-distributed-weight','tuning-oldest-weight'])
      expect(RANGE_DEFAULTS).not.toHaveProperty(key);
    let tuning=normalizeTuning({pointerPriority:4,blaPrecisionLog2:-24});
    class Input extends EventTarget {
      id='tuning-pointer-priority';value='4';disabled=false;
      focus=vi.fn();getClientRects=()=>[{}];
    }
    const input=new Input(),documentStub=Object.assign(new EventTarget(),{querySelectorAll:()=>[input]});
    const received:unknown[]=[],changed=vi.fn();
    input.addEventListener('input',event=>{
      received.push((event as CustomEvent).detail);
      tuning=normalizeTuning({...tuning,pointerPriority:Number(input.value)});
    });
    input.addEventListener('change',changed);
    vi.stubGlobal('document',documentStub);
    try {
      setupRangeControls();
      input.dispatchEvent(Object.assign(new Event('pointerdown',{cancelable:true}),{ctrlKey:true,button:0}));
      expect(input.value).toBe('1');expect(input.focus).toHaveBeenCalledOnce();
      expect(received).toEqual([{factoryReset:true}]);expect(changed).toHaveBeenCalledOnce();
      expect(tuning).toMatchObject({pointerPriority:1,pointerWeight:2,distributedWeight:1,oldestWeight:1,blaPrecisionLog2:-24});
      expect(modifiedTuningCount(tuning)).toBe(1);
    } finally {vi.unstubAllGlobals();}
  });
});
