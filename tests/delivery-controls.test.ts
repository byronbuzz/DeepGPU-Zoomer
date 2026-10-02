import {describe,expect,it,vi} from 'vitest';
import {DEFAULT_TUNING,EDITABLE_TUNING_KEYS,THROUGHPUT_PRESETS,TUNING_STORAGE_KEY,
  loadTuning,migrateSavedTuning,modifiedTuningCount,normalizeTuning,saveTuning,type TuningSettings} from '../src/tuning';
import {DEFAULTS_STORAGE_KEY,readDefaults,saveDefaults,type SavedDefaults} from '../src/defaults';
import {DEFAULT_COLORS,validateColors} from '../src/logic/colorSettings';
import {normalizePanelSettings} from '../src/panels';
import {RANGE_DEFAULTS,setupRangeControls} from '../src/range-controls';

const memoryStorage=()=>{
  const entries=new Map<string,string>();
  return {entries,getItem:(key:string)=>entries.get(key)??null,
    setItem:(key:string,value:string)=>{entries.set(key,value);}};
};
const savedDefaults=(tuning:TuningSettings):SavedDefaults=>({appearance:validateColors(DEFAULT_COLORS),tuning,
  speed:.7,baseIterations:10000,dynamicEnabled:true,profilingEnabled:false,randomStyle:'unrestricted',
  panels:normalizePanelSettings({})});
const changed=()=>normalizeTuning({throughput:2,pointerRefinement:true,
  pointerPriority:4,blaPrecisionLog2:-24,dynamicDepthGain:15000});

describe('delivery tuning presets',()=>{
  it('defaults to Smooth with fixed-base budgets and keeps retired mechanisms off',()=>{
    expect(normalizeTuning({})).toEqual(DEFAULT_TUNING);
    expect(DEFAULT_TUNING).toMatchObject({throughput:0,inwardWorkScale:1,gpuPassScale:1,
      inwardWorkTargetMs:24,publicationTargetMs:12,minimumLogicalSamples:24576,minimumPassSamples:16384,
      targetResidencyMs:64,pointerRefinement:false,workgroupShape:'16x4',hardPixelCutoff:0,
      predictionLookahead:0,blaPrecisionLog2:-14});
    expect(EDITABLE_TUNING_KEYS).toEqual(['throughput','pointerRefinement','dynamicDepthGain','blaPrecisionLog2','pointerPriority']);
  });

  it.each([
    {throughput:0,name:'Smooth',work:1,residency:64},
    {throughput:1,name:'Balanced',work:2,residency:128},
    {throughput:2,name:'Detailed',work:4,residency:32},
  ])('derives $name once from the fixed base values',({throughput,name,work,residency})=>{
    expect(THROUGHPUT_PRESETS[throughput]).toEqual({name,workScale:work,targetResidencyMs:residency});
    const tuning=normalizeTuning({...DEFAULT_TUNING,throughput,inwardWorkScale:999,gpuPassScale:999,
      inwardWorkTargetMs:999,publicationTargetMs:999,minimumLogicalSamples:999,minimumPassSamples:999,
      targetResidencyMs:999,hardPixelCutoff:512,predictionLookahead:16,workgroupShape:'64x4'});
    expect(tuning).toMatchObject({throughput,inwardWorkScale:work,gpuPassScale:work,
      inwardWorkTargetMs:24*work,publicationTargetMs:12*work,
      minimumLogicalSamples:24576*work,minimumPassSamples:16384*work,targetResidencyMs:residency,
      hardPixelCutoff:0,predictionLookahead:0,workgroupShape:'16x4'});
    expect(normalizeTuning(tuning)).toEqual(tuning);
  });

  it('bounds preset indices and defaults malformed values without interpreting legacy fields',()=>{
    for(const [input,expected] of [[-1,0],[99,2],[.6,1],[1.6,2]])
      expect(normalizeTuning({throughput:input}).throughput).toBe(expected);
    for(const throughput of [NaN,Infinity,null,undefined,'2'])
      expect(normalizeTuning({throughput,inwardWorkScale:1,targetResidencyMs:64})).toEqual(DEFAULT_TUNING);
    expect(normalizeTuning({inwardWorkScale:1,targetResidencyMs:64})).toEqual(DEFAULT_TUNING);
  });

  it('round trips five editable controls and keeps explicit saved defaults isolated from reset',()=>{
    const storage=memoryStorage(),tuning=changed();
    expect(modifiedTuningCount(tuning)).toBe(5);
    expect(saveTuning(tuning,storage)).toBe(true);
    expect(loadTuning(storage)).toEqual(tuning);
    const payload=JSON.parse(storage.getItem(TUNING_STORAGE_KEY)!);
    expect(payload.version).toBe(4);
    expect(Object.keys(payload.settings).sort()).toEqual([...EDITABLE_TUNING_KEYS].sort());
    expect(payload.settings.pointerRefinement).toBe(true);
    expect(saveDefaults(savedDefaults(tuning),storage)).toEqual({error:null});
    expect(readDefaults(storage)).toEqual({value:savedDefaults(tuning),error:null});
    const durable=storage.getItem(DEFAULTS_STORAGE_KEY);
    expect(saveTuning({...DEFAULT_TUNING},storage)).toBe(true);
    expect(loadTuning(storage)).toEqual(DEFAULT_TUNING);
    expect(modifiedTuningCount(loadTuning(storage))).toBe(0);
    expect(storage.getItem(DEFAULTS_STORAGE_KEY)).toBe(durable);
    expect(readDefaults(storage).value?.tuning).toEqual(tuning);
  });

  it.each([2,3] as const)('migrates supported v%s work/residency combinations and defaults unmatched ones',(version)=>{
    const storage=memoryStorage();
    for(const [index,preset] of THROUGHPUT_PRESETS.entries()){
      for(const sizing of [
        {inwardWorkScale:preset.workScale,gpuPassScale:preset.workScale},
        {inwardWorkTargetMs:24*preset.workScale,publicationTargetMs:12*preset.workScale},
      ]){
        const settings={...sizing,targetResidencyMs:preset.targetResidencyMs,hardPixelCutoff:512,
          predictionLookahead:16,workgroupShape:'64x4',pointerPriority:4,blaPrecisionLog2:-23};
        storage.setItem(`gpu-zoomer-navigation-tuning-v${version}`,JSON.stringify({version,settings}));
        expect(loadTuning(storage)).toMatchObject({throughput:index,pointerPriority:3,pointerWeight:8,
          blaPrecisionLog2:-23,hardPixelCutoff:0,predictionLookahead:0,workgroupShape:'16x4'});
        storage.setItem(DEFAULTS_STORAGE_KEY,JSON.stringify({version:1,
          settings:{...savedDefaults({...DEFAULT_TUNING}),tuning:settings}}));
        expect(readDefaults(storage).value?.tuning).toEqual(loadTuning(storage));
      }
    }
    for(const settings of [{},{inwardWorkScale:.5,targetResidencyMs:64},
      {inwardWorkScale:1,gpuPassScale:2,targetResidencyMs:64},{inwardWorkScale:4,targetResidencyMs:256},
      {inwardWorkScale:null,targetResidencyMs:64}])
      expect(migrateSavedTuning(settings,version).throughput).toBe(0);
  });

  it('distinguishes old pointer indices from current indices in unversioned saved defaults',()=>{
    expect(migrateSavedTuning({pointerPriority:4}).pointerWeight).toBe(8);
    expect(migrateSavedTuning({throughput:1,pointerPriority:4}).pointerWeight).toBe(16);
    expect(normalizeTuning({pointerPriority:4}).pointerWeight).toBe(16);
    expect(migrateSavedTuning({throughput:2,pointerPriority:4},3)).toMatchObject({throughput:0,pointerWeight:8});
  });

  it('prefers v4 over older storage and rejects a mismatched envelope version',()=>{
    const storage=memoryStorage();
    storage.setItem('gpu-zoomer-navigation-tuning-v3',JSON.stringify({version:3,
      settings:{inwardWorkScale:1,targetResidencyMs:64,pointerPriority:4}}));
    expect(loadTuning(storage)).toMatchObject({throughput:0,pointerPriority:3});
    saveTuning(changed(),storage);expect(loadTuning(storage)).toEqual(changed());
    storage.setItem(TUNING_STORAGE_KEY,JSON.stringify({version:3,settings:{throughput:0}}));
    expect(loadTuning(storage)).toEqual(DEFAULT_TUNING);
  });

  it('resets throughput through Control-click while preserving the other choices',()=>{
    expect(RANGE_DEFAULTS['tuning-throughput']).toBe(0);
    for(const id of ['tuning-inward-work-size','tuning-gpu-pass-size','tuning-target-residency'])
      expect(RANGE_DEFAULTS).not.toHaveProperty(id);
    class Input extends EventTarget {
      id='tuning-throughput';value='2';disabled=false;focus=vi.fn();getClientRects=()=>[{}];
    }
    const input=new Input(),documentStub=Object.assign(new EventTarget(),{querySelectorAll:()=>[input]});
    let tuning=changed();
    const emitted:unknown[]=[],change=vi.fn();
    input.addEventListener('input',event=>{
      emitted.push((event as CustomEvent).detail);
      tuning=normalizeTuning({...tuning,throughput:Number(input.value)});
    });
    input.addEventListener('change',change);vi.stubGlobal('document',documentStub);
    try {
      setupRangeControls();
      input.dispatchEvent(Object.assign(new Event('pointerdown',{cancelable:true}),{ctrlKey:true,button:0}));
      expect(input.value).toBe('0');expect(input.focus).toHaveBeenCalledOnce();
      expect(tuning).toMatchObject({throughput:0,inwardWorkTargetMs:24,publicationTargetMs:12,
        minimumLogicalSamples:24576,minimumPassSamples:16384,targetResidencyMs:64,pointerRefinement:true});
      expect(modifiedTuningCount(tuning)).toBe(4);
      expect(emitted).toEqual([{factoryReset:true}]);expect(change).toHaveBeenCalledOnce();
    } finally {vi.unstubAllGlobals();}
  });
});
