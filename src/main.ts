import './style.css';
import Decimal from 'decimal.js';
import { acquireGpu, backingSize, type GpuContext } from './gpu/device';
import { WebGpuRenderer, Method, type RenderRequest } from './render/webgpu-renderer';
import { DEFAULT_COLORS, needsEndpoints, renderColors, validateColors, type ColorSettings } from './logic/colorSettings';
import { Camera, HOME, MAX_ITERATIONS, homePosition, validateView, encodeView, decodeView, depthLabel, iterationFromSlider, iterationToSlider, type SavedView, type Family } from './state';
import { setupLocations, type LocationIdentity } from './locations';
import { setupPanels, normalizePanelSettings } from './panels';
import { DEFAULTS_STORAGE_KEY, readDefaults, saveDefaults, type SavedDefaults } from './defaults';
import { setupPngExportPanel } from './export/panel';
import { setupPaletteEditor } from './palette-editor';
import { RefinementTimer } from './refinement-time';
import { RefiningStatus } from './refining-status';
import { dynamicLimitForZoom } from './dynamic';
import { setupRangeControls } from './range-controls';
import { setImageColourSampler } from './colour-picker';
import { DEFAULT_ROTATION_SECONDS, PALETTE_ROTATION_MULTIPLIER, advanceColourRotation, rotationSecondsFromSlider, rotationSecondsToSlider, rotationDurationLabel } from './colour-rotation';
import { DEFAULT_TUNING, EDITABLE_TUNING_KEYS, POINTER_RATIOS, THROUGHPUT_PRESETS, loadTuning, modifiedTuningCount, normalizeTuning, overscanCssPx, saveTuning, type EditableTuningKey, type TuningSettings } from './tuning';

const el = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const canvas=el<HTMLCanvasElement>('fractal');
const camera=new Camera();
const defaultsRead=readDefaults();
let savedDefaults:SavedDefaults|null=defaultsRead.value;
let view:SavedView={...HOME}, colors={...DEFAULT_COLORS}, engine:WebGpuRenderer;
setImageColourSampler((x,y)=>engine?engine.captureDisplayedColour(x,y):Promise.reject(new Error('Image is not ready')),
  (x,y)=>engine?engine.captureDisplayedColourPatch(x,y):Promise.reject(new Error('Image is not ready')));
let tuning:TuningSettings=savedDefaults?.tuning??(defaultsRead.error?{...DEFAULT_TUNING}:loadTuning());
const DYNAMIC_STORAGE_KEY='gpu-zoomer-dynamic-v1';
let dynamicEnabled=true;
if(savedDefaults)dynamicEnabled=savedDefaults.dynamicEnabled;
else if(!defaultsRead.error)try { dynamicEnabled=localStorage.getItem(DYNAMIC_STORAGE_KEY)!=='off'; } catch {}
let rotationSeconds=savedDefaults?.rotationSeconds??DEFAULT_ROTATION_SECONDS,rotatePalette=savedDefaults?.rotatePalette??false,rotateLight=savedDefaults?.rotateLight??false,reverseRotation=savedDefaults?.reverseRotation??false;
const colourRotationEditing=new Set<string>();
let paletteRotationElapsed=0,lightRotationElapsed=0;
let baseIterations=HOME.iterations,anchorDepth=0,lastDynamicUpdate=0;
let provisionalNavigationCap=false;
let sliderEditing=false;
let baseEditTimer:ReturnType<typeof setTimeout>|undefined,baseEditing=false;
let generation=0, busy=false, dirty=true, error='', lastInteraction=0, lastRevision=-1;
let qualitySizeError=false;
let stopped=false, refreshPending=false, refreshHolding=false, stoppedAppearancePending=false;
let retainedRequest:RenderRequest|null=null;
let stopSnapshotPending=false,retainedPartialCaptured=false;
let completedQuality=0, preparingColourData=false, colourDataTarget=0;
let pointer={x:innerWidth/2,y:innerHeight/2}, direction=0, wheelDirection=0, dragging=false, speed=1, previousTime=0, statusTime=0;
let rotating=false,rotationSliderHeld=false,controlDown=false,rotationPointerAngle:number|null=null,activePointer:number|null=null;
const rotationKeys=new Set<string>();
let juliaReturn:SavedView|null=null;
let gpuContext:GpuContext|undefined, previewEngine:WebGpuRenderer|undefined;

let previewEnabled=false, selecting=false, previewBusy=false, previewPending=false, previewEpoch=0;
let selectedJulia:{x:string;y:string}|null=null;
let previewLifetime=0;
const previewCanvas=el<HTMLCanvasElement>('julia-preview-canvas');
let previewSize={width:previewCanvas.width,height:previewCanvas.height};
let previewIterationLimit=HOME.iterations;
const keys=new Set<string>();
// Keep layout-dependent actions, but pair releases by physical identity even
// when releasing Shift changes the reported key (for example '+' to '=').
const heldKeyActions=new Map<string,string>();
function keyIdentity(e:KeyboardEvent){return e.code||e.key;}
const locationHistory:{view:SavedView;identity:LocationIdentity|null}[]=[];
function syncBack(){el<HTMLButtonElement>('location-back').disabled=locationHistory.length===0;}
const refinementTime=new RefinementTimer(performance.now());
const refiningStatus=new RefiningStatus();
const freshness=el('freshness'),depth=el('depth');
let syncAppearance=()=>{};
let messageDismissTimer=0,messageFadeTimer=0,messageVersion=0;
let wheelSave:ReturnType<typeof setTimeout>|undefined,appearanceSave:ReturnType<typeof setTimeout>|undefined;
function message(text:string,transient=true){
  const target=el('message'),version=++messageVersion;
  clearTimeout(messageDismissTimer);clearTimeout(messageFadeTimer);target.classList.remove('message-fading');target.textContent=text;
  if(!text||!transient)return;
  messageDismissTimer=window.setTimeout(()=>{
    if(version!==messageVersion)return;
    target.classList.add('message-fading');
    const fadeDelay=matchMedia('(prefers-reduced-motion: reduce)').matches?0:250;
    messageFadeTimer=window.setTimeout(()=>{if(version===messageVersion){target.textContent='';target.classList.remove('message-fading');}},fadeDelay);
  },3000);
}
function snapshot():SavedView{return {...view,x:camera.x.toString(),y:camera.y.toString(),span:camera.span.toString(),angle:camera.angle,appearance:validateColors(colors),rotationSeconds,rotatePalette,rotateLight,reverseRotation};}
function colourPreparationLabel(progress=engine?.progress()){
  const started=progress&&progress.targets>colourDataTarget&&progress.exactTotalSamples>0&&
    (progress.pending>0||progress.finalizing||progress.exactCompletedSamples<progress.exactTotalSamples);
  return `Refined · 100% · Preparing colour data${started&&progress?.percentage!==null?` · ${progress?.percentage}%`:''}`;
}
function setText(target:HTMLElement,value:string){if(target.textContent!==value)target.textContent=value;}
function preparing(time=performance.now()){
  const numericalPending=lastRevision!==camera.revision||completedQuality!==1;
  const progress=engine?.progress();
  const actual=numericalPending?(dirty&&!busy?0:progress?.percentage??0):100;
  const state=error?'Rendering stopped':stopped?'Stopped':preparingColourData?colourPreparationLabel(progress):refiningStatus.text(time,actual);
  setText(freshness,`${state} · ${refinementTime.text(time)}`);
}
function syncIterationLabel(){
  if(previewIterationLimit!==view.iterations){previewIterationLimit=view.iterations;if(previewEnabled&&selectedJulia)queuePreview();}
  el('iteration-value').textContent=view.iterations.toLocaleString();
  el<HTMLInputElement>('iteration-slider').value=String(iterationToSlider(view.iterations));
  if(!baseEditing)el<HTMLInputElement>('iteration-base').value=String(baseIterations);
  el<HTMLButtonElement>('iteration-dynamic').setAttribute('aria-pressed',String(dynamicEnabled));
}
const tuningFields:[EditableTuningKey,string][]=[
  ['throughput','throughput'],['pointerRefinement','pointer-refinement'],
  ['dynamicDepthGain','depth-gain'],['blaPrecisionLog2','bla-epsilon'],['pointerPriority','pointer-priority'],
];
function syncTuningLabels(){
  for(const [key,id] of tuningFields){
    const control=el<HTMLInputElement>(`tuning-${id}`);
    if(key==='pointerRefinement')control.checked=tuning.pointerRefinement;
    else control.value=String(key==='blaPrecisionLog2'?-tuning.blaPrecisionLog2:tuning[key]);
    el(`tuning-${id}-modified`).hidden=tuning[key]===DEFAULT_TUNING[key];
  }
  const preset=THROUGHPUT_PRESETS[tuning.throughput];
  setText(el('tuning-throughput-value'),preset.name);
  el('tuning-throughput').setAttribute('aria-valuetext',`${preset.name}, work ${tuning.inwardWorkScale} times, residency ${tuning.targetResidencyMs} milliseconds`);
  setText(el('tuning-depth-gain-value'),tuning.dynamicDepthGain.toLocaleString());
  el('tuning-depth-gain').setAttribute('aria-valuetext',`${tuning.dynamicDepthGain.toLocaleString()} iterations per decade`);
  setText(el('tuning-bla-epsilon-value'),`2^${-tuning.blaPrecisionLog2}`);
  el<HTMLInputElement>('tuning-bla-epsilon').setAttribute('aria-valuetext',`Precision 2 to the power ${-tuning.blaPrecisionLog2}, tolerance 2 to the power ${tuning.blaPrecisionLog2}`);
  el<HTMLInputElement>('tuning-bla-epsilon').disabled=view.family!=='mandelbrot';
  const ratio=POINTER_RATIOS[tuning.pointerPriority];
  setText(el('tuning-pointer-priority-value'),ratio===1?'Off':`${ratio}×`);
  el('tuning-pointer-priority').setAttribute('aria-valuetext',`${ratio===1?'Off, ':''}${ratio}:1:1`);
}
function changeTuning(key:EditableTuningKey,value:TuningSettings[EditableTuningKey]){
  const next=normalizeTuning({...tuning,[key]:value});
  if(EDITABLE_TUNING_KEYS.every(field=>next[field]===tuning[field]))return;
  tuning=next;
  if(!saveTuning(tuning))message('This browser could not save tuning settings locally.');
  syncTuningLabels();
  if((key==='blaPrecisionLog2')&&view.family==='mandelbrot'){
    // Let the renderer retire only the affected numerical policy at its next
    // boundary; changing tolerance does not invalidate the reference orbit.
    completedQuality=0;lastRevision=-1;dirty=true;
    engine?.reproject(request());
    refinementTime.demand(performance.now());preparing();
  }
  // Navigation controls apply to the next scheduling decision. They do not
  // invalidate already calculated pixels or restart the current view.
}
function currentDepth(){
  const [mantissa,exponent]=camera.span.toExponential(14).split('e');
  return Math.log10(2.8)-Math.log10(Number(mantissa))-Number(exponent);
}
function resetDynamicAnchor(){
  anchorDepth=currentDepth();lastDynamicUpdate=0;provisionalNavigationCap=false;
}
function changeEffectiveLimit(limit:number,atBatchBoundary=false){
  const next=Math.max(1,Math.min(MAX_ITERATIONS,Math.round(limit)));
  if(next===view.iterations)return;
  view={...view,iterations:next};
  if(!atBatchBoundary){provisionalNavigationCap=false;generation++;engine?.abort();}
  dirty=true;completedQuality=0;lastRevision=-1;
  refinementTime.demand(performance.now());syncIterationLabel();syncTuningLabels();preparing();
}
function setManualBase(limit:number,beforeRefresh=false){
  if(!Number.isInteger(limit)||limit<1||limit>MAX_ITERATIONS){message(`Base iterations must be 1–${MAX_ITERATIONS.toLocaleString()}.`);return false;}
  clearTimeout(baseEditTimer);baseEditTimer=undefined;baseEditing=false;baseIterations=limit;resetDynamicAnchor();
  if(beforeRefresh)view={...view,iterations:limit};
  else changeEffectiveLimit(limit);
  syncIterationLabel();persist(false);return true;
}
function updateDynamicForZoom(time:number,zoomDirection:number){
  if(engine?.methodForRequest(request())!==Method.Direct)return;
  applyDynamicLimit(time,zoomDirection,500);
}
function applyDynamicLimit(time:number,zoomDirection:number,updateIntervalMs:number):number|null{
  if(!dynamicEnabled||stopped||refreshPending||error||sliderEditing||baseEditing)return null;
  const next=dynamicLimitForZoom({zoomDirection,time,lastUpdate:lastDynamicUpdate,
    base:baseIterations,current:view.iterations,depthDelta:currentDepth()-anchorDepth,
    depthGain:tuning.dynamicDepthGain,maximum:MAX_ITERATIONS,
    referencePreparing:false,updateIntervalMs});
  if(next===null)return null;
  provisionalNavigationCap=true;lastDynamicUpdate=time;
  changeEffectiveLimit(next,true);
  return next;
}
function updateDynamicBeforePreparation():number|null{
  return applyDynamicLimit(performance.now(),request().zoom??0,0)??null;
}
function currentFieldComplete(){return !dirty&&!busy&&completedQuality===1&&lastRevision===camera.revision&&!!engine&&engine.isComplete(request());}
function releasePointer(){const id=activePointer;activePointer=null;if(id!==null&&canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);}
function stop(){const now=performance.now();refinementTime.stopHeld(now,currentFieldComplete());refiningStatus.finish(now);direction=0;wheelDirection=0;dragging=false;rotating=false;rotationSliderHeld=false;controlDown=false;rotationPointerAngle=null;selecting=false;keys.clear();heldKeyActions.clear();rotationKeys.clear();releasePointer();}
function cancelPreviewWork(){previewLifetime++;previewEpoch++;previewPending=false;previewEngine?.abort();el('julia-preview').setAttribute('aria-busy','false');}
function captureStoppedPartial(){
  if(!stopSnapshotPending||!engine||!retainedRequest)return;
  const retained=retainedRequest,g=generation;
  void engine.retainDisplayedPartial(retained,true).then(captured=>{if(g===generation&&retainedRequest===retained)retainedPartialCaptured=captured;});
  stopSnapshotPending=false;
}
async function refreshCalculation(){
  if(!engine||busy||!refreshPending)return;
  busy=true;const g=generation;
  try{
    if(retainedRequest&&!retainedPartialCaptured)await engine.retainDisplayedPartial(retainedRequest);
    if(g!==generation||!refreshPending)return;
    engine.restartCalculation();retainedRequest=null;retainedPartialCaptured=false;refreshPending=false;dirty=true;
  }finally{busy=false;if(stopped)captureStoppedPartial();}
}
function stopRefinement(){
  if(stopped){stop();return;}
  retainedRequest=request();
  stop();stopped=true;refreshPending=false;refreshHolding=false;stoppedAppearancePending=false;
  generation++;engine?.abort();cancelPreviewWork();dirty=false;preparingColourData=false;
  stopSnapshotPending=true;retainedPartialCaptured=false;if(!busy)captureStoppedPartial();
  refinementTime.halt(performance.now());
  preparing();
}
function refresh(){
  retainedRequest ??= request();
  stop();refiningStatus.reset();stopped=false;refreshPending=true;refreshHolding=true;stoppedAppearancePending=false;
  stopSnapshotPending=false;
  generation++;engine?.abort();cancelPreviewWork();
  resize(false);completedQuality=0;preparingColourData=false;dirty=true;error='';
  refinementTime.demand(performance.now());preparing();
  if(previewEnabled&&selectedJulia)queuePreview();
}
function syncControls(){
  syncRotation();
  el<HTMLSelectElement>('family').value=view.family;
  syncIterationLabel();
  depth.textContent=`${depthLabel(camera.span)} · ${view.iterations.toLocaleString()} iterations`;
  syncJuliaPreview();
  syncAppearance();
  syncTuningLabels();
}
function load(next:SavedView,record=true,remember=record){
  const valid=validateView(next);
  if(remember){locationHistory.push({view:snapshot(),identity:locations.identity()});if(locationHistory.length>32)locationHistory.shift();syncBack();}
  locations.clear();
  clearTimeout(baseEditTimer);baseEditing=false;
  stop();refiningStatus.reset();stopped=false;refreshPending=false;refreshHolding=false;stoppedAppearancePending=false;retainedRequest=null;stopSnapshotPending=false;retainedPartialCaptured=false;preparingColourData=false;view=valid;baseIterations=valid.iterations;colors=validateColors(valid.appearance??savedDefaults?.appearance??DEFAULT_COLORS);camera.load(valid);resetDynamicAnchor();generation++;
  rotationSeconds=valid.rotationSeconds??savedDefaults?.rotationSeconds??DEFAULT_ROTATION_SECONDS;rotatePalette=valid.rotatePalette??savedDefaults?.rotatePalette??false;rotateLight=valid.rotateLight??savedDefaults?.rotateLight??false;reverseRotation=valid.reverseRotation??savedDefaults?.reverseRotation??false;
  paletteRotationElapsed=lightRotationElapsed=0;colourRotationEditing.clear();syncColourMotion();
  if(view.family==='julia')setPreview(false);
  resize();
  engine?.invalidateHistory();completedQuality=0;dirty=true;lastRevision=-1;lastInteraction=0;error='';refinementTime.demand(performance.now());preparing();message('');syncControls();
  if(previewEnabled&&selectedJulia)queuePreview();
  if(record)persist();
}
function persist(sync=true){
  const s=snapshot();try{localStorage.setItem('gpu-zoomer-view',JSON.stringify(s));}catch{message('This browser could not save preferences locally. Copy a share link to keep this exact view.');}
  if(sync)syncControls();
}
function moving(){return direction!==0||dragging||rotating||rotationSliderHeld||controlDown&&rotationKeys.size>0||keys.size>0||performance.now()-lastInteraction<180;}
function changed(kind:'held'|'wheel'='held') {const now=performance.now();if(qualitySizeError){error='';qualitySizeError=false;}if(kind==='wheel')refiningStatus.wheel(now);else refiningStatus.start();locations.dismiss();stopped=false;refreshPending=false;refreshHolding=false;stoppedAppearancePending=false;retainedRequest=null;stopSnapshotPending=false;retainedPartialCaptured=false;preparingColourData=false;dirty=true;lastInteraction=now;
  preparing(now);
}
function syncRotation(){el<HTMLInputElement>('rotation').value=String(camera.angle);el('rotation-value').textContent=`${Number(camera.angle.toFixed(1))}°`;}
function setRotation(angle:number,held=true){const previous=camera.revision;camera.setAngle(angle);if(camera.revision===previous)return;
  if(held)refinementTime.heldCameraChange();else refinementTime.demand(performance.now());changed();syncRotation();}
function finishRotation(){rotating=false;controlDown=false;rotationPointerAngle=null;releasePointer();const now=performance.now();refinementTime.stopHeld(now,currentFieldComplete());refiningStatus.finish(now);persist();}
function syncJuliaPreview(){
  const visible=previewEnabled && view.family==='mandelbrot';
  const opening=visible&&el('julia-preview').hidden;
  el('julia-preview').hidden=!visible;
  if(opening)el('julia-preview').dispatchEvent(new Event('panelopened'));
  canvas.classList.toggle('selecting-julia',visible);
  el<HTMLButtonElement>('julia-promote').disabled=!selectedJulia;
}
function queuePreview(){
  if(stopped)return;
  previewEpoch++;previewPending=true;
  el('julia-preview').setAttribute('aria-busy','true');
}
function measurePreview(){
  if(!previewEnabled)return;
  const rect=el('julia-preview-viewport').getBoundingClientRect();
  if(rect.width<=0||rect.height<=0)return;
  const dpr=devicePixelRatio||1;
  const endpointStorage=needsEndpoints(colors)||previewEngine?.endpointChannelsRequired?.();
  const {width,height}=gpuContext?backingSize(rect.width,rect.height,dpr,gpuContext.device.limits,endpointStorage?16:8):{width:Math.max(1,Math.round(rect.width*dpr)),height:Math.max(1,Math.round(rect.height*dpr))};
  if(width===previewSize.width&&height===previewSize.height)return;
  previewSize={width,height};
  // Queue the latest geometry while the previous complete image stays visible.
  if(selectedJulia)queuePreview();
}
const previewObserver=new ResizeObserver(measurePreview);
previewObserver.observe(el('julia-preview-viewport'));
function selectJuliaAtPointer(){
  if(view.family!=='mandelbrot')return;
  const rect=canvas.getBoundingClientRect();
  const p=camera.point(Math.max(0,Math.min(rect.width,pointer.x-rect.left)),Math.max(0,Math.min(rect.height,pointer.y-rect.top)),rect.width,rect.height);
  const next={x:p.x.toString(),y:p.y.toString()};
  if(selectedJulia?.x===next.x && selectedJulia.y===next.y)return;
  selectedJulia=next;
  queuePreview();syncJuliaPreview();
}
function setPreview(enabled:boolean){
  previewEnabled=enabled && view.family==='mandelbrot';selecting=false;
  if(!previewEnabled)cancelPreviewWork();
  syncJuliaPreview();
  if(previewEnabled)measurePreview();
}
function toggleJuliaPreview(){
  if(view.family!=='mandelbrot')return;
  stop();setPreview(!previewEnabled);
  if(previewEnabled){if(!selectedJulia)selectJuliaAtPointer();else queuePreview();}
  canvas.focus();
}
async function computeJuliaPreview(){
  if(stopped||previewBusy||!previewPending||!previewEnabled||!selectedJulia||!gpuContext)return;
  previewBusy=true;previewPending=false;
  const epoch=previewEpoch,lifetime=previewLifetime,selected={...selectedJulia},size={...previewSize},iterations=view.iterations;
    const sameTarget=()=>!stopped && previewEnabled && view.family==='mandelbrot' && previewLifetime===lifetime && selectedJulia?.x===selected.x && selectedJulia.y===selected.y && previewSize.width===size.width && previewSize.height===size.height && view.iterations===iterations;
    const current=()=>sameTarget() && previewEpoch===epoch;
  try{
    // One persistent small renderer, with its own fields/history/uniforms.
    if(!previewEngine){previewEngine=new WebGpuRenderer(gpuContext,previewCanvas);await previewEngine.init();}
    if(!current())return;
    const requestedColors={...renderColors(colors),mode:0,supersample:1};
    const calculationCurrent=()=>sameTarget()&&(!needsEndpoints({...colors,mode:0,supersample:1})||needsEndpoints(requestedColors)||!!previewEngine?.endpointChannelsRequired?.());
    const req:RenderRequest={centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal(3.2).div(size.height),width:size.width,height:size.height,maxIterations:iterations,colors:requestedColors,family:'julia',juliaX:new Decimal(selected.x),juliaY:new Decimal(selected.y),useApprox:false,publishPartial:false,isCurrent:current,isCalculationCurrent:calculationCurrent};
    // Preserve the previous canvas until the complete replacement is ready.
    const result=await previewEngine.render(req);
    if(current()&&result.completed){
      if(previewCanvas.width!==size.width)previewCanvas.width=size.width;
      if(previewCanvas.height!==size.height)previewCanvas.height=size.height;
      previewEngine.reproject(req);
      el('julia-preview-status').textContent='';
      el('julia-preview').setAttribute('aria-busy','false');
    }
  }catch(e){if(current()){
    el('julia-preview-status').textContent=`Preview unavailable: ${String(e)}`;
    el('julia-preview').setAttribute('aria-busy','false');
  }}finally{previewBusy=false;}
}
function switchJuliaView(){
  if(view.family==='julia'){
    if(juliaReturn){const previous=juliaReturn;juliaReturn=null;load(previous);}
  }else if(selectedJulia){
    const next=validateView({...snapshot(),...HOME,family:'julia',x:'0',jx:selectedJulia.x,jy:selectedJulia.y,iterations:view.iterations,angle:camera.angle,appearance:validateColors(colors)});
    juliaReturn=snapshot();load(next);
  }else message('Press J, then select a point for the Julia preview.');
  canvas.focus();
}
function request():RenderRequest{
  const width=Math.max(8,canvas.width),height=Math.max(8,canvas.height);const g=generation;
  const interacting=moving();
  const heldZoom=direction||(keys.has('+')||keys.has('=')?1:keys.has('-')?-1:0);
  const zoom=heldZoom||(performance.now()-lastInteraction<180?wheelDirection:0);
  const margin=zoom<0?overscanCssPx(speed,tuning.overscanBase,tuning.overscanMax):0;
  const overscanPixels={x:Math.floor(margin*width/Math.max(1,innerWidth)/2)*2,
    y:Math.floor(margin*height/Math.max(1,innerHeight)/2)*2};
  return {centerX:camera.x,centerY:camera.y,angle:camera.angle,unitsPerPixel:camera.unitsPerPixel(height),width,height,maxIterations:view.iterations,colors:{...renderColors(colors),...(colors.oversampling&&!interacting?{supersample:1}:{})},stationaryOversampling:colors.oversampling===true&&!interacting,family:view.family,juliaX:new Decimal(view.jx),juliaY:new Decimal(view.jy),useApprox:true,interacting,followView:true,publishPartial:!refreshHolding,presentationOwner:'animation',betweenBatches:computeJuliaPreview,focus:{x:pointer.x/innerWidth,y:pointer.y/innerHeight},zoom,zoomRate:speed,overscanPixels,dynamicIterations:dynamicEnabled,provisionalNavigationCap,beforePreparation:()=>g===generation?updateDynamicBeforePreparation():null,tuning:normalizeTuning({...tuning,throughput:interacting?tuning.throughput:2}),isCurrent:()=>generation===g};
}
async function compute(){
  if(busy||!engine||error||stopped||refreshPending)return;busy=true;dirty=false;const g=generation;
  try{
    const result=await engine.render(request());
    if(g===generation && result.completed && engine.isComplete(request())){const numericalWasPending=lastRevision!==camera.revision||completedQuality!==1;
      engine.reproject(request(),stopped||refreshHolding);
      lastRevision=camera.revision;completedQuality=1;preparingColourData=false;refreshHolding=false;dirty=false;
      provisionalNavigationCap=false;
      if(numericalWasPending)refinementTime.complete(performance.now());
    }
  }catch(e){if(g===generation&&!(e instanceof DOMException && e.name==='AbortError')){error=String(e);qualitySizeError=error.includes('2x oversampling is unsupported');message(error);}}
  finally{busy=false;if(stopped){captureStoppedPartial();dirty=false;}else if(lastRevision!==camera.revision||g!==generation)dirty=true;}
}
async function recolorStopped(){
  if(busy||!engine||!stopped||!stoppedAppearancePending)return;
  busy=true;stoppedAppearancePending=false;const g=generation;
  try{if(await engine.recolorRetained(request())&&g===generation&&stopped)retainedRequest=request();}
  catch(e){if(g===generation){error=String(e);message(error);}}
  finally{busy=false;if(stopped)captureStoppedPartial();}
}
function resize(resetTimer=true){measurePreview();const dpr=devicePixelRatio||1;const endpointStorage=needsEndpoints(colors)||colors.mode===1||engine?.endpointChannelsRequired();const {width,height}=gpuContext?backingSize(innerWidth,innerHeight,dpr,gpuContext.device.limits,endpointStorage?16:8):{width:Math.round(innerWidth*dpr),height:Math.round(innerHeight*dpr)};if(canvas.width===width&&canvas.height===height)return false;if(resetTimer){stopped=false;refreshPending=false;refreshHolding=false;stoppedAppearancePending=false;retainedRequest=null;}preparingColourData=false;canvas.width=width;canvas.height=height;completedQuality=0;dirty=true;if(resetTimer)refinementTime.demand(performance.now());syncTuningLabels();preparing();return true;}
function tick(time:number){
  const dt=previousTime?time-previousTime:0;previousTime=time;
  if(!document.hidden){
    advanceColourMotion(dt);
    if(controlDown&&rotationKeys.size&&dt){const turn=(rotationKeys.has('ArrowRight')?1:0)-(rotationKeys.has('ArrowLeft')?1:0);if(turn)setRotation(camera.angle+turn*dt*.06);}
    const zoom=direction||(keys.has('+')||keys.has('=')?1:keys.has('-')?-1:0);
    if(zoom && dt){const revision=camera.revision;camera.zoom(-zoom*speed*dt/1000,pointer.x,pointer.y,innerWidth,innerHeight);if(camera.revision!==revision){refinementTime.heldCameraChange();changed();updateDynamicForZoom(time,zoom);}}
    let dx=0,dy=0;if(keys.has('ArrowLeft'))dx+=dt*.3;if(keys.has('ArrowRight'))dx-=dt*.3;if(keys.has('ArrowUp'))dy+=dt*.3;if(keys.has('ArrowDown'))dy-=dt*.3;
    if(dx||dy){camera.pan(dx,dy,innerHeight);refinementTime.heldCameraChange();changed();}
    if(engine){
      if(refreshPending&&!busy)void refreshCalculation();
      engine.reproject(request(),stopped||refreshHolding);
      if(!busy&&!dirty&&!stopped&&!refreshPending&&completedQuality===1&&!engine.isComplete(request())){
        completedQuality=0;dirty=true;
      }
      // Give the latest preview one turn between main jobs, without awaiting it.
      // Both renderers keep at most one bounded numerical region in the queue.
      const referenceWorkerWaiting=busy&&engine.progress().referenceWorkerActive;
      if(!stopped&&(!busy||referenceWorkerWaiting)&&!previewBusy&&previewPending)void computeJuliaPreview();
      if(stopped&&stoppedAppearancePending&&!busy)void recolorStopped();
      if(dirty&&!busy&&!stopped&&!refreshPending)void compute();
    }
    if(time-statusTime>50){statusTime=time;
      preparing(time);
      setText(depth,`${depthLabel(camera.span)} · ${view.iterations.toLocaleString()} iterations`);
      el<HTMLButtonElement>('screenshot').disabled=!engine;

    }
  }
  requestAnimationFrame(tick);
}
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{if(e.button>2)return;canvas.focus();stop();canvas.setPointerCapture(e.pointerId);activePointer=e.pointerId;pointer={x:e.clientX,y:e.clientY};
  if(e.ctrlKey&&e.button===0){e.preventDefault();rotating=true;controlDown=true;rotationPointerAngle=Math.hypot(e.clientX-innerWidth/2,e.clientY-innerHeight/2)>8?Math.atan2(e.clientY-innerHeight/2,e.clientX-innerWidth/2):null;return;}
  if(e.shiftKey||e.button===1){dragging=true;changed();return;}
  if(previewEnabled && view.family==='mandelbrot' && e.button===0){e.preventDefault();selecting=true;selectJuliaAtPointer();return;}
  wheelDirection=0;direction=e.button===2?-1:1;changed();});
canvas.addEventListener('pointermove',e=>{if(rotating){if(!e.ctrlKey){finishRotation();return;}const dx=e.clientX-innerWidth/2,dy=e.clientY-innerHeight/2;
    if(Math.hypot(dx,dy)>8){const angle=Math.atan2(dy,dx);if(rotationPointerAngle!==null){const delta=angle-rotationPointerAngle;setRotation(camera.angle+Math.atan2(Math.sin(delta),Math.cos(delta))*180/Math.PI);}rotationPointerAngle=angle;}else rotationPointerAngle=null;
    pointer={x:e.clientX,y:e.clientY};return;}
  if(selecting){pointer={x:e.clientX,y:e.clientY};selectJuliaAtPointer();return;}if(dragging&&(e.clientX!==pointer.x||e.clientY!==pointer.y)){camera.pan(e.clientX-pointer.x,e.clientY-pointer.y,innerHeight);refinementTime.heldCameraChange();changed();}pointer={x:e.clientX,y:e.clientY};});
function endPointer(){if(selecting){stop();return;}stop();persist();}
canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',()=>{stop();persist();});
canvas.addEventListener('lostpointercapture',()=>{if(activePointer!==null){activePointer=null;stop();persist();}});
canvas.addEventListener('wheel',e=>{e.preventDefault();pointer={x:e.clientX,y:e.clientY};const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?innerHeight:1);wheelDirection=-Math.sign(delta);const revision=camera.revision;camera.zoom(Math.max(-1,Math.min(1,delta*.002))*speed,pointer.x,pointer.y,innerWidth,innerHeight);if(camera.revision!==revision){const now=performance.now();refinementTime.wheelCameraChange(now);changed('wheel');updateDynamicForZoom(now,wheelDirection);}clearTimeout(wheelSave);wheelSave=setTimeout(()=>persist(),250);},{passive:false});
canvas.addEventListener('keydown',e=>{if(e.key==='Escape'){stop();persist();return;}
  if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&(e.ctrlKey||rotationKeys.has(e.key)))return;
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(['+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();wheelDirection=0;const identity=keyIdentity(e);if(!heldKeyActions.has(identity)){heldKeyActions.set(identity,e.key);keys.add(e.key);}changed();}});
document.addEventListener('keyup',e=>{const identity=keyIdentity(e),action=heldKeyActions.get(identity);if(action===undefined)return;heldKeyActions.delete(identity);if(![...heldKeyActions.values()].includes(action))keys.delete(action);if(keys.size===0&&rotationKeys.size===0&&!direction&&!dragging&&!rotating){const now=performance.now();refinementTime.stopHeld(now,currentFieldComplete());refiningStatus.finish(now);}persist();});
canvas.addEventListener('blur',()=>{stop();persist();});
document.addEventListener('keyup',e=>{if(e.key==='Control'&&(rotating||controlDown)){finishRotation();}
  if(rotationKeys.delete(e.key)){if(keys.size===0&&rotationKeys.size===0&&!direction&&!dragging&&!rotating){const now=performance.now();refinementTime.stopHeld(now,currentFieldComplete());refiningStatus.finish(now);}persist();}});
document.addEventListener('keydown',e=>{
  if(e.target instanceof HTMLElement&&(e.target.isContentEditable||e.target.closest('input:not([type="checkbox"]),textarea,select,[role="combobox"],[role="listbox"]')))return;
  if(e.target instanceof HTMLInputElement&&e.target.type==='checkbox'&&!['j','m'].includes(e.key.toLowerCase()))return;
  if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&(e.ctrlKey||rotationKeys.has(e.key))){e.preventDefault();keys.delete(e.key);if(e.ctrlKey){controlDown=true;rotationKeys.add(e.key);wheelDirection=0;}return;}
  if(e.key==='Escape'&&(rotating||controlDown||rotationSliderHeld)){stop();persist();return;}
  if(e.repeat||e.ctrlKey||e.metaKey||e.altKey)return;
  const key=e.key.toLowerCase();if(key!=='j'&&key!=='m')return;e.preventDefault();
  try{if(key==='j')toggleJuliaPreview();else switchJuliaView();}catch(err){message(String(err));}
});
window.addEventListener('blur',()=>{stop();persist();});document.addEventListener('visibilitychange',()=>{stop();persist();previousTime=0;});window.addEventListener('resize',()=>resize());
el<HTMLSelectElement>('family').onchange=e=>{const family=(e.target as HTMLSelectElement).value as Family;if(family===view.family)return;if(family==='mandelbrot'&&juliaReturn){switchJuliaView();return;}if(family==='julia')juliaReturn=snapshot();load({...snapshot(),...HOME,family,x:family==='julia'?'0':HOME.x,jx:view.jx,jy:view.jy,iterations:view.iterations,angle:camera.angle});};
el('julia-preview-close').onclick=()=>{setPreview(false);canvas.focus();};
el('julia-promote').onclick=()=>{try{switchJuliaView();}catch(err){message(String(err));}};
el('stop-refinement').onclick=stopRefinement;
el('reset').onclick=()=>load(homePosition(snapshot()));
const rotationSlider=el<HTMLInputElement>('rotation');
const finishSliderRotation=()=>{rotationSliderHeld=false;const now=performance.now();refinementTime.stopHeld(now,currentFieldComplete());refiningStatus.finish(now);persist();};
rotationSlider.onpointerdown=()=>{stop();rotationSliderHeld=true;};
rotationSlider.onkeydown=e=>{if(e.key==='Escape'){stop();persist();return;}if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))rotationSliderHeld=true;};
rotationSlider.oninput=()=>setRotation(Number(rotationSlider.value));
rotationSlider.onchange=()=>{if(!rotationSliderHeld)finishSliderRotation();};
rotationSlider.onpointerup=finishSliderRotation;rotationSlider.onpointercancel=finishSliderRotation;rotationSlider.onkeyup=finishSliderRotation;rotationSlider.onblur=finishSliderRotation;
el<HTMLInputElement>('speed').oninput=e=>{speed=Number((e.target as HTMLInputElement).value);el('speed-value').textContent=speed.toFixed(1)+'×';};
el<HTMLInputElement>('iteration-slider').oninput=e=>{sliderEditing=true;const n=iterationFromSlider(Number((e.target as HTMLInputElement).value));el('iteration-value').textContent=n.toLocaleString();};
el<HTMLInputElement>('iteration-slider').onchange=e=>{sliderEditing=false;const n=iterationFromSlider(Number((e.target as HTMLInputElement).value));setManualBase(n);};
const baseInput=el<HTMLInputElement>('iteration-base');
baseInput.oninput=()=>{
  baseEditing=true;clearTimeout(baseEditTimer);
  baseEditTimer=setTimeout(()=>{baseEditTimer=undefined;const raw=baseInput.value.trim();if(raw&&/^\d+$/.test(raw))setManualBase(Number(raw));else message(`Base iterations must be 1–${MAX_ITERATIONS.toLocaleString()}.`);},1000);
};
el<HTMLButtonElement>('iteration-dynamic').onclick=()=>{
  dynamicEnabled=!dynamicEnabled;
  try{localStorage.setItem(DYNAMIC_STORAGE_KEY,dynamicEnabled?'on':'off');}catch{message('This browser could not save the Dynamic setting locally.');}
  clearTimeout(baseEditTimer);baseEditTimer=undefined;baseEditing=false;sliderEditing=false;
  baseIterations=view.iterations;resetDynamicAnchor();
  persist(false);syncIterationLabel();
};
const tuningInputs:[EditableTuningKey,string,(value:number)=>number][]=[
  ['throughput','throughput',Number],
  ['dynamicDepthGain','depth-gain',Number],
  ['blaPrecisionLog2','bla-epsilon',value=>-Number(value)],
  ['pointerPriority','pointer-priority',Number],
];
for(const [key,id,parse] of tuningInputs){
  const control=el<HTMLInputElement>(`tuning-${id}`);
  control.oninput=()=>changeTuning(key,parse(Number(control.value)));
}
el<HTMLInputElement>('tuning-pointer-refinement').onchange=event=>changeTuning('pointerRefinement',(event.currentTarget as HTMLInputElement).checked);
el('tuning-reset').onclick=()=>{
  if(!modifiedTuningCount(tuning))return;
  tuning={...DEFAULT_TUNING};

  if(!saveTuning(tuning))message('This browser could not save tuning settings locally.');
  syncTuningLabels();refresh();
};
const locations=setupLocations(snapshot,next=>load(next),message);
el('location-back').onclick=()=>{const previous=locationHistory.pop();if(!previous)return;load(previous.view,true,false);locations.restore(previous.identity);juliaReturn=null;syncBack();};
syncBack();
el('share').onclick=async()=>{persist();const url=new URL(location.href);url.hash=encodeView(snapshot());try{await navigator.clipboard.writeText(url.href);message('Location link copied.');}catch{message(`Copy this exact link: ${url.href}`);}};
function openLocationLink(record=true){
  if(!location.hash)return false;
  let next:SavedView;
  try{next=decodeView(location.hash.slice(1));}
  catch{message('The linked location could not be read. The current view was kept.');return false;}
  load(next,record);juliaReturn=null;
  // Consume the fragment so pasting the same link again also opens its view.
  history.replaceState(history.state,'',location.pathname+location.search);
  message('Linked location opened.');return true;
}
window.addEventListener('hashchange',()=>openLocationLink());
const panelController=setupPanels(savedDefaults?.panels??(defaultsRead.error?normalizePanelSettings(null):undefined));
function applyAppearance(c:ColorSettings,persistLater=true){
  const previous=colors,changed=JSON.stringify(renderColors(previous))!==JSON.stringify(renderColors(c));
  const completedBefore=currentFieldComplete()||preparingColourData;
  colors=c;
  if(previous.oversampling!==c.oversampling&&qualitySizeError){error='';qualitySizeError=false;}
  if(changed){
    const missingData=previous.mode!==c.mode||needsEndpoints(c)&&!engine?.endpointChannelsRequired();
    const numericalChange=missingData||previous.supersample!==c.supersample||previous.oversampling!==c.oversampling;
    if(stopped&&previous.supersample===c.supersample&&previous.oversampling===c.oversampling){
      if(persistLater){generation++;engine?.abort();}
      preparingColourData=false;dirty=false;stoppedAppearancePending=true;
    }else{
      if(stopped||previous.oversampling!==c.oversampling){stopped=false;refinementTime.demand(performance.now());}
      if(numericalChange){
        const wasPreparing=preparingColourData,previousTarget=colourDataTarget,currentTarget=engine?.progress().targets??0;
        const resized=resize(false);
        preparingColourData=completedBefore&&!resized&&missingData&&previous.supersample===c.supersample&&previous.oversampling===c.oversampling;
        if(preparingColourData)colourDataTarget=wasPreparing&&previous.mode===c.mode?previousTarget:currentTarget;
        if(!preparingColourData)completedQuality=0;
        generation++;engine?.abort();preparing();
      }
      dirty=true;if(previewEnabled&&(persistLater||!previewBusy&&!previewPending))queuePreview();
    }
  }
  if(persistLater){clearTimeout(appearanceSave);appearanceSave=setTimeout(()=>persist(false),250);}
}
const paletteController=setupPaletteEditor(()=>colors,applyAppearance);
syncAppearance=paletteController.sync;
setupRangeControls();
function syncColourMotion(){
  const control=el<HTMLInputElement>('rotation-speed');control.value=String(rotationSecondsToSlider(rotationSeconds));
  const label=rotationDurationLabel(rotationSeconds);el('rotation-speed-value').textContent=label;control.setAttribute('aria-valuetext',`${label} per light rotation; ${rotationDurationLabel(rotationSeconds*PALETTE_ROTATION_MULTIPLIER)} per palette cycle`);
  el<HTMLInputElement>('rotate-palette').checked=rotatePalette;el<HTMLInputElement>('rotate-light').checked=rotateLight;
  el<HTMLInputElement>('rotation-reverse').checked=reverseRotation;
}
function advanceColourMotion(dt:number){
  const palette=rotatePalette&&!colourRotationEditing.has('color-offset'),light=rotateLight&&!colourRotationEditing.has('light-angle');
  paletteRotationElapsed=palette?paletteRotationElapsed+dt:0;lightRotationElapsed=light?lightRotationElapsed+dt:0;
  if(busy||!paletteRotationElapsed&&!lightRotationElapsed)return;
  // Keep the submitted appearance stable until it is displayed; retain elapsed time.
  let next=advanceColourRotation(colors,paletteRotationElapsed/1000,rotationSeconds,true,false,reverseRotation);
  next=advanceColourRotation(next,lightRotationElapsed/1000,rotationSeconds,false,true,reverseRotation);
  paletteRotationElapsed=lightRotationElapsed=0;applyAppearance(next,false);
  if(palette)el<HTMLInputElement>('color-offset').value=String(colors.offset);
  if(light)el<HTMLInputElement>('light-angle').value=String(colors.lightAngle);
}
el<HTMLInputElement>('rotation-speed').oninput=event=>{rotationSeconds=rotationSecondsFromSlider(Number((event.currentTarget as HTMLInputElement).value));syncColourMotion();persist(false);};
el<HTMLInputElement>('rotation-reverse').onchange=event=>{reverseRotation=(event.currentTarget as HTMLInputElement).checked;paletteRotationElapsed=lightRotationElapsed=0;persist(false);};
el<HTMLInputElement>('rotate-palette').onchange=event=>{rotatePalette=(event.currentTarget as HTMLInputElement).checked;persist(false);};
el<HTMLInputElement>('rotate-light').onchange=event=>{rotateLight=(event.currentTarget as HTMLInputElement).checked;persist(false);};
for(const id of ['color-offset','light-angle']){
  const input=el<HTMLInputElement>(id);input.addEventListener('pointerdown',()=>colourRotationEditing.add(id));
  input.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))colourRotationEditing.add(id);});
  input.addEventListener('keyup',()=>colourRotationEditing.delete(id));input.addEventListener('blur',()=>colourRotationEditing.delete(id));
}
window.addEventListener('pointerup',()=>colourRotationEditing.clear());window.addEventListener('pointercancel',()=>colourRotationEditing.clear());
window.addEventListener('blur',()=>colourRotationEditing.clear());
syncColourMotion();
el('save-defaults').onclick=()=>{
  if(baseEditing){const raw=baseInput.value.trim();if(!/^\d+$/.test(raw)){message('Base iterations must be a positive whole number.');return;}if(!setManualBase(Number(raw)))return;}
  const next:SavedDefaults={appearance:validateColors(colors),tuning:{...tuning},speed,baseIterations,dynamicEnabled,rotationSeconds,rotatePalette,rotateLight,reverseRotation,
    panels:panelController.snapshot()};
  const result=saveDefaults(next);
  if(result.error){message(result.error);return;}
  savedDefaults=next;message('Defaults saved. Camera position and saved locations were kept separate.',true);
};
el('full-reset').onclick=()=>{
  clearTimeout(wheelSave);clearTimeout(appearanceSave);clearTimeout(baseEditTimer);baseEditing=false;clearTimeout(messageDismissTimer);clearTimeout(messageFadeTimer);
  stop();setPreview(false);previewEngine?.abort();selectedJulia=null;juliaReturn=null;
  rotationSeconds=DEFAULT_ROTATION_SECONDS;rotatePalette=false;rotateLight=false;reverseRotation=false;paletteRotationElapsed=lightRotationElapsed=0;colourRotationEditing.clear();syncColourMotion();
  speed=1;el<HTMLInputElement>('speed').value='1';el('speed-value').textContent='1.0×';
  locations.clear();locationHistory.length=0;syncBack();
  tuning={...DEFAULT_TUNING};saveTuning(tuning);syncTuningLabels();
  dynamicEnabled=true;try{localStorage.setItem(DYNAMIC_STORAGE_KEY,'on');}catch{}
  savedDefaults=null;
  let resetStorageFailed=false;
  try{localStorage.removeItem(DEFAULTS_STORAGE_KEY);localStorage.removeItem('gpu-zoomer-view');localStorage.removeItem('gpu-zoomer-layout');}catch{resetStorageFailed=true;}
  history.replaceState(null,'',location.pathname+location.search);
  pngExportPanel.reset();panelController.reset();load({...HOME,appearance:validateColors(DEFAULT_COLORS)},false);paletteController.reset();message(resetStorageFailed?'Factory settings restored for this session, but stored defaults could not be cleared.':'Defaults restored. Saved locations were kept.',!resetStorageFailed);
  el<HTMLButtonElement>('reset').focus();
};
const pngExportPanel=setupPngExportPanel({context:()=>gpuContext,request,viewport:()=>({width:canvas.width,height:canvas.height}),captureQuality:(snapshot,width,height)=>engine?.captureMatchingQuality(snapshot,width,height)??null});
void (async()=>{
  let rememberedAppearance=savedDefaults?.appearance??DEFAULT_COLORS;
  if(!savedDefaults&&!defaultsRead.error)try{const remembered=validateView(JSON.parse(localStorage.getItem('gpu-zoomer-view')||'null'));rememberedAppearance=remembered.appearance??DEFAULT_COLORS;}catch{}
  if(savedDefaults){speed=savedDefaults.speed;}
  el<HTMLInputElement>('speed').value=String(speed);el('speed-value').textContent=speed.toFixed(1)+'×';
  load({...HOME,iterations:savedDefaults?.baseIterations??HOME.iterations,appearance:validateColors(rememberedAppearance)},false);
  if(location.hash){openLocationLink(false);}else if(defaultsRead.error)message(defaultsRead.error);else if(locations.storageError)message('Saved locations could not be read. Saving and deletion are disabled to preserve the stored data.');else if(locations.recoveryError)message('Default locations could not be added. Your existing saved locations were kept.');
  resize();requestAnimationFrame(tick);
  try{const ctx=await acquireGpu();gpuContext=ctx;resize();const renderer=new WebGpuRenderer(ctx,canvas);await renderer.init();engine=renderer;dirty=true;ctx.lost.then(info=>{if(info.reason!=='destroyed'){engine.abort();error='GPU connection lost. Reload this page to reconnect.';message(error);stop();setPreview(false);}});}
  catch(e){error=String(e);message(error);throw e;}
})();
