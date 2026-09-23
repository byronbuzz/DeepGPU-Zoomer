import './style.css';
import Decimal from 'decimal.js';
import { acquireGpu, backingSize, type GpuContext } from './gpu/device';
import { WebGpuRenderer, type RenderRequest, type RenderStats } from './render/webgpu-renderer';
import { DEFAULT_COLORS, needsEndpoints, renderColors, validateColors } from './logic/colorSettings';
import { Camera, HOME, homePosition, validateView, encodeView, decodeView, depthLabel, iterationFromSlider, iterationToSlider, type SavedView, type Family } from './state';
import { PLACES } from './places';
import { setupPanels } from './panels';
import { setupPaletteEditor } from './palette-editor';
import { RefinementTimer } from './refinement-time';

const el = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const canvas=el<HTMLCanvasElement>('fractal');
const camera=new Camera();
let view:SavedView={...HOME}, colors={...DEFAULT_COLORS}, engine:WebGpuRenderer;
let generation=0, busy=false, dirty=true, error='', lastInteraction=0, lastRevision=-1;
let stopped=false, refreshPending=false, refreshHolding=false, stoppedAppearancePending=false;
let retainedRequest:RenderRequest|null=null;
let stopSnapshotPending=false,retainedPartialCaptured=false;
let fields=0, recolours=0, stats:RenderStats|undefined, completedQuality=0, preparingColourData=false, colourDataTarget=0;
let pointer={x:innerWidth/2,y:innerHeight/2}, direction=0, wheelDirection=0, dragging=false, speed=.8, previousTime=0, statusTime=0;
let rotating=false,rotationSliderHeld=false,controlDown=false,rotationPointerAngle:number|null=null,activePointer:number|null=null;
const rotationKeys=new Set<string>();
let juliaReturn:SavedView|null=null;
let gpuContext:GpuContext|undefined, previewEngine:WebGpuRenderer|undefined;
let profilingEnabled=false;
let previewEnabled=false, selecting=false, previewBusy=false, previewPending=false, previewEpoch=0, previewRenderedEpoch=-1;
let selectedJulia:{x:string;y:string}|null=null;
let displayedJulia:{x:string;y:string}|null=null,previewLifetime=0;
const previewCanvas=el<HTMLCanvasElement>('julia-preview-canvas');
let previewSize={width:previewCanvas.width,height:previewCanvas.height};
const keys=new Set<string>();
let saved: {name:string;view:SavedView}[]=[];
type LocationChoice={kind:'place'|'saved';index:number;name:string};
let selectedLocation:LocationChoice|null=null;
let linkedView:SavedView|null=null;
let frameTimes:number[]=[], frameCount=0, sessionStart=performance.now();
const refinementTime=new RefinementTimer(performance.now());
const freshness=el('freshness'),depth=el('depth');
let syncAppearance=()=>{};
let messageDismissTimer=0,messageFadeTimer=0,messageVersion=0;
let wheelSave:ReturnType<typeof setTimeout>|undefined,appearanceSave:ReturnType<typeof setTimeout>|undefined;
function message(text:string,transient=false){
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
function snapshot():SavedView{return {...view,x:camera.x.toString(),y:camera.y.toString(),span:camera.span.toString(),angle:camera.angle,appearance:validateColors(colors)};}
function colourPreparationLabel(progress=engine?.debugProgress()){
  const started=progress&&progress.targets>colourDataTarget&&progress.exactTotalSamples>0&&
    (progress.pending>0||progress.finalizing||progress.exactCompletedSamples<progress.exactTotalSamples);
  return `Refined · 100% · Preparing colour data${started&&progress?.percentage!==null?` · ${progress?.percentage}%`:''}`;
}
function preparing(){freshness.textContent=`${preparingColourData?`${colourPreparationLabel()} · `:''}${refinementTime.text(performance.now())}`;}
function syncIterationLabel(){
  el('iteration-value').textContent=view.iterations.toLocaleString();
}
function currentFieldComplete(){return !dirty&&!busy&&completedQuality===1&&lastRevision===camera.revision&&!!engine&&engine.isComplete(request());}
function releasePointer(){const id=activePointer;activePointer=null;if(id!==null&&canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);}
function stop(){refinementTime.stopHeld(performance.now(),currentFieldComplete());direction=0;wheelDirection=0;dragging=false;rotating=false;rotationSliderHeld=false;controlDown=false;rotationPointerAngle=null;selecting=false;keys.clear();rotationKeys.clear();releasePointer();}
function cancelPreviewWork(){previewLifetime++;previewEpoch++;previewPending=false;previewEngine?.abort();el('julia-preview').setAttribute('aria-busy','false');}
function captureStoppedPartial(){
  if(!stopSnapshotPending||!engine||!retainedRequest)return;
  retainedPartialCaptured=engine.retainDisplayedPartial(retainedRequest,true);
  stopSnapshotPending=false;
}
function stopRefinement(){
  if(stopped){stop();return;}
  retainedRequest=request();
  stop();stopped=true;refreshPending=false;refreshHolding=false;stoppedAppearancePending=false;
  generation++;engine?.abort();cancelPreviewWork();dirty=false;preparingColourData=false;
  stopSnapshotPending=true;retainedPartialCaptured=false;if(!busy)captureStoppedPartial();
  refinementTime.halt(performance.now());
}
function refresh(){
  retainedRequest ??= request();
  stop();stopped=false;refreshPending=true;refreshHolding=true;stoppedAppearancePending=false;
  stopSnapshotPending=false;
  generation++;engine?.abort();cancelPreviewWork();
  resize(false);completedQuality=0;preparingColourData=false;dirty=true;error='';
  refinementTime.demand(performance.now());preparing();
  if(previewEnabled&&selectedJulia)queuePreview();
}
function syncControls(){
  syncRotation();
  el<HTMLSelectElement>('family').value=view.family;
  el<HTMLInputElement>('iteration-slider').value=String(iterationToSlider(view.iterations));
  syncIterationLabel();
  el<HTMLTextAreaElement>('cx').value=camera.x.toString();el<HTMLTextAreaElement>('cy').value=camera.y.toString();el<HTMLInputElement>('span').value=camera.span.toString();
  depth.textContent=`${depthLabel(camera.span)} · ${view.iterations.toLocaleString()} iterations`;
  syncJuliaPreview();
  syncAppearance();
}
function load(next:SavedView,record=true){
  dismissReplacement();
  const valid=validateView(next);stop();stopped=false;refreshPending=false;refreshHolding=false;stoppedAppearancePending=false;retainedRequest=null;stopSnapshotPending=false;retainedPartialCaptured=false;preparingColourData=false;view=valid;colors=validateColors(valid.appearance??DEFAULT_COLORS);camera.load(valid);generation++;
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
function changed(){dismissReplacement();stopped=false;refreshPending=false;refreshHolding=false;stoppedAppearancePending=false;retainedRequest=null;stopSnapshotPending=false;retainedPartialCaptured=false;preparingColourData=false;dirty=true;lastInteraction=performance.now();preparing();}
function syncRotation(){el<HTMLInputElement>('rotation').value=String(camera.angle);el('rotation-value').textContent=`${Number(camera.angle.toFixed(1))}°`;}
function setRotation(angle:number,held=true){const previous=camera.revision;camera.setAngle(angle);if(camera.revision===previous)return;
  if(held)refinementTime.heldCameraChange();else refinementTime.demand(performance.now());changed();syncRotation();}
function finishRotation(){rotating=false;controlDown=false;rotationPointerAngle=null;releasePointer();refinementTime.stopHeld(performance.now(),currentFieldComplete());persist();}
function syncJuliaPreview(){
  const visible=previewEnabled && view.family==='mandelbrot';
  el('julia-preview').hidden=!visible;
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
  const epoch=previewEpoch,lifetime=previewLifetime,selected={...selectedJulia},size={...previewSize};
    const sameTarget=()=>!stopped && previewEnabled && view.family==='mandelbrot' && previewLifetime===lifetime && selectedJulia?.x===selected.x && selectedJulia.y===selected.y && previewSize.width===size.width && previewSize.height===size.height;
    const current=()=>sameTarget() && previewEpoch===epoch;
  try{
    // One persistent small renderer, with its own fields/history/uniforms.
    if(!previewEngine){previewEngine=new WebGpuRenderer(gpuContext,previewCanvas);await previewEngine.init();}
    if(!current())return;
    const requestedColors={...renderColors(colors),mode:0,supersample:1};
    const calculationCurrent=()=>sameTarget()&&(!needsEndpoints({...colors,mode:0,supersample:1})||needsEndpoints(requestedColors)||!!previewEngine?.endpointChannelsRequired?.());
    const req:RenderRequest={centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal(3.2).div(size.height),width:size.width,height:size.height,maxIterations:1000,colors:requestedColors,family:'julia',juliaX:new Decimal(selected.x),juliaY:new Decimal(selected.y),useApprox:false,publishPartial:false,isCurrent:current,isCalculationCurrent:calculationCurrent};
    // Preserve the previous canvas until the complete replacement is ready.
    const result=await previewEngine.render(req);
    if(current()&&result.completed){
      if(previewCanvas.width!==size.width)previewCanvas.width=size.width;
      if(previewCanvas.height!==size.height)previewCanvas.height=size.height;
      previewEngine.reproject(req);previewRenderedEpoch=epoch;
      displayedJulia=selected;
      el('julia-preview-constant').textContent=`Displayed c = ${selected.x} ${new Decimal(selected.y).isNegative()?'−':'+'} ${new Decimal(selected.y).abs().toString()}i`;
      el('julia-preview-status').textContent=`${req.maxIterations} iterations · M opens latest selected c`;
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
    const next=validateView({...HOME,family:'julia',x:'0',jx:selectedJulia.x,jy:selectedJulia.y,iterations:view.iterations,angle:camera.angle,appearance:validateColors(colors)});
    juliaReturn=snapshot();load(next);
  }else message('Press J, then select a point for the Julia preview.');
  canvas.focus();
}
function request():RenderRequest{
  const width=Math.max(8,canvas.width),height=Math.max(8,canvas.height);const g=generation;
  return {centerX:camera.x,centerY:camera.y,angle:camera.angle,unitsPerPixel:camera.span.div(height),width,height,maxIterations:view.iterations,colors:renderColors(colors),family:view.family,juliaX:new Decimal(view.jx),juliaY:new Decimal(view.jy),useApprox:true,interacting:moving(),followView:true,publishPartial:!refreshHolding,betweenBatches:computeJuliaPreview,focus:{x:pointer.x/innerWidth,y:pointer.y/innerHeight},zoom:direction||(keys.has('+')||keys.has('=')?1:keys.has('-')?-1:performance.now()-lastInteraction<180?wheelDirection:0),isCurrent:()=>generation===g};
}
async function compute(){
  if(busy||!engine||error||stopped||refreshPending)return;busy=true;dirty=false;const g=generation;
  try{
    const result=await engine.render(request());
    if(g===generation && result.completed && engine.isComplete(request())){const numericalWasPending=lastRevision!==camera.revision||completedQuality!==1;stats=result;if(result.computed)fields++;else recolours++;
      lastRevision=camera.revision;completedQuality=1;preparingColourData=false;refreshHolding=false;dirty=false;
      if(numericalWasPending)refinementTime.complete(performance.now());
    }
  }catch(e){if(!(e instanceof DOMException && e.name==='AbortError')){error=String(e);message(error);}}
  finally{busy=false;if(stopped){captureStoppedPartial();dirty=false;}else if(lastRevision!==camera.revision||g!==generation)dirty=true;}
}
async function recolorStopped(){
  if(busy||!engine||!stopped||!stoppedAppearancePending)return;
  busy=true;stoppedAppearancePending=false;const g=generation;
  try{if(await engine.recolorRetained(request())&&g===generation&&stopped)retainedRequest=request();}
  catch(e){if(g===generation){error=String(e);message(error);}}
  finally{busy=false;if(stopped)captureStoppedPartial();}
}
function resize(resetTimer=true){measurePreview();const dpr=devicePixelRatio||1;const endpointStorage=needsEndpoints(colors)||colors.mode===1||engine?.endpointChannelsRequired();const {width,height}=gpuContext?backingSize(innerWidth,innerHeight,dpr,gpuContext.device.limits,endpointStorage?16:8):{width:Math.round(innerWidth*dpr),height:Math.round(innerHeight*dpr)};if(canvas.width===width&&canvas.height===height)return false;if(resetTimer){stopped=false;refreshPending=false;refreshHolding=false;stoppedAppearancePending=false;retainedRequest=null;}preparingColourData=false;canvas.width=width;canvas.height=height;completedQuality=0;dirty=true;if(resetTimer)refinementTime.demand(performance.now());preparing();return true;}
function tick(time:number){
  const dt=previousTime?time-previousTime:0;previousTime=time;
  if(dt>0){frameTimes.push(dt);if(frameTimes.length>300)frameTimes.shift();}frameCount++;
  if(!document.hidden){
    if(controlDown&&rotationKeys.size&&dt){const turn=(rotationKeys.has('ArrowRight')?1:0)-(rotationKeys.has('ArrowLeft')?1:0);if(turn)setRotation(camera.angle+turn*dt*.06);}
    const zoom=direction||(keys.has('+')||keys.has('=')?1:keys.has('-')?-1:0);
    if(zoom && dt){const revision=camera.revision;camera.zoom(-zoom*speed*dt/1000,pointer.x,pointer.y,innerWidth,innerHeight);if(camera.revision!==revision){refinementTime.heldCameraChange();changed();}}
    let dx=0,dy=0;if(keys.has('ArrowLeft'))dx+=dt*.3;if(keys.has('ArrowRight'))dx-=dt*.3;if(keys.has('ArrowUp'))dy+=dt*.3;if(keys.has('ArrowDown'))dy-=dt*.3;
    if(dx||dy){camera.pan(dx,dy,innerHeight);refinementTime.heldCameraChange();changed();}
    if(engine){
      if(refreshPending&&!busy){if(retainedRequest&&!retainedPartialCaptured)engine.retainDisplayedPartial(retainedRequest);engine.restartCalculation();retainedRequest=null;retainedPartialCaptured=false;refreshPending=false;dirty=true;}
      engine.reproject(request(),stopped||refreshHolding);
      // Give the latest preview one turn between main jobs, without awaiting it.
      // Both renderers keep at most one bounded numerical region in the queue.
      const referenceWorkerWaiting=busy&&engine.debugProgress().referenceWorkerActive;
      if(!stopped&&(!busy||referenceWorkerWaiting)&&!previewBusy&&previewPending)void computeJuliaPreview();
      if(stopped&&stoppedAppearancePending&&!busy)void recolorStopped();
      if(dirty&&!busy&&!stopped&&!refreshPending)void compute();
    }
    if(time-statusTime>50){statusTime=time;
      const numericalPending=lastRevision!==camera.revision||completedQuality!==1;
      const fresh=!busy && !dirty && !moving() && !numericalPending;
      const progress=engine?.debugProgress();
      const state=stopped?'Stopped':!numericalPending?preparingColourData?colourPreparationLabel(progress):'Refined · 100%':progress?.referencePreparing?'Preparing reference':progress?.percentage!==null&&progress?.percentage!==undefined?`Refining · ${progress.percentage}%`:progress?.finalizing?'Finishing':busy?'Computing':'Preview';
      freshness.textContent=`${error?'Rendering stopped':state} · ${refinementTime.text(time)}`;
      depth.textContent=`${depthLabel(camera.span)} · ${view.iterations.toLocaleString()} iterations`;
      el<HTMLButtonElement>('screenshot').disabled=!fresh||!engine?.isComplete(request());
      if(profilingEnabled&&engine){
        const profile=engine.performance();
        const phases=Object.entries(profile.phases).filter(([,p])=>p.count).map(([name,p])=>`${name==='calculate'?'Calculation':name==='antialias'?'Antialias pass':'Shading'}: ${p.meanMs.toFixed(2)} ms mean, ${p.p95Ms.toFixed(2)} ms p95 (${p.count} samples)`);
        el('profiling-data').textContent=!profile.supported?'GPU timings are unavailable on this device.':phases.join(' · ')||'Waiting for the next render.';
      }
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
canvas.addEventListener('wheel',e=>{e.preventDefault();pointer={x:e.clientX,y:e.clientY};const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?innerHeight:1);wheelDirection=-Math.sign(delta);const revision=camera.revision;camera.zoom(Math.max(-1,Math.min(1,delta*.002))*speed,pointer.x,pointer.y,innerWidth,innerHeight);if(camera.revision!==revision){refinementTime.wheelCameraChange(performance.now());changed();}clearTimeout(wheelSave);wheelSave=setTimeout(()=>persist(),250);},{passive:false});
canvas.addEventListener('keydown',e=>{if(e.key==='Escape'){stop();persist();return;}
  if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&(e.ctrlKey||rotationKeys.has(e.key)))return;
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(['+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();wheelDirection=0;keys.add(e.key);changed();}});
canvas.addEventListener('keyup',e=>{if(!keys.delete(e.key))return;if(keys.size===0&&rotationKeys.size===0&&!direction&&!dragging&&!rotating)refinementTime.stopHeld(performance.now(),currentFieldComplete());persist();});
document.addEventListener('keyup',e=>{if(e.key==='Control'&&(rotating||controlDown)){finishRotation();}
  if(rotationKeys.delete(e.key)){if(keys.size===0&&rotationKeys.size===0&&!direction&&!dragging&&!rotating)refinementTime.stopHeld(performance.now(),currentFieldComplete());persist();}});
document.addEventListener('keydown',e=>{
  if(e.target instanceof HTMLElement&&(e.target.isContentEditable||e.target.closest('input,textarea,select,[role="combobox"],[role="listbox"]')))return;
  if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&(e.ctrlKey||rotationKeys.has(e.key))){e.preventDefault();keys.delete(e.key);if(e.ctrlKey){controlDown=true;rotationKeys.add(e.key);wheelDirection=0;}return;}
  if(e.key==='Escape'&&(rotating||controlDown||rotationSliderHeld)){stop();persist();return;}
  if(e.repeat||e.ctrlKey||e.metaKey||e.altKey)return;
  const key=e.key.toLowerCase();if(key!=='j'&&key!=='m')return;e.preventDefault();
  try{if(key==='j')toggleJuliaPreview();else switchJuliaView();}catch(err){message(String(err));}
});
window.addEventListener('blur',()=>{stop();persist();});document.addEventListener('visibilitychange',()=>{stop();persist();previousTime=0;});window.addEventListener('resize',()=>resize());
el<HTMLSelectElement>('family').onchange=e=>{const family=(e.target as HTMLSelectElement).value as Family;if(family===view.family)return;if(family==='mandelbrot'&&juliaReturn){switchJuliaView();return;}if(family==='julia')juliaReturn=snapshot();load({...HOME,family,x:family==='julia'?'0':HOME.x,jx:view.jx,jy:view.jy,iterations:view.iterations,angle:camera.angle});};
el('julia-preview-close').onclick=()=>{setPreview(false);canvas.focus();};
el('julia-promote').onclick=()=>{try{switchJuliaView();}catch(err){message(String(err));}};
el('refresh').onclick=refresh;
el('stop-refinement').onclick=stopRefinement;
el('reset').onclick=()=>load(homePosition(snapshot()));
const rotationSlider=el<HTMLInputElement>('rotation');
const finishSliderRotation=()=>{rotationSliderHeld=false;refinementTime.stopHeld(performance.now(),currentFieldComplete());persist();};
rotationSlider.onpointerdown=()=>{stop();rotationSliderHeld=true;};
rotationSlider.onkeydown=e=>{if(e.key==='Escape'){stop();persist();return;}if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))rotationSliderHeld=true;};
rotationSlider.oninput=()=>setRotation(Number(rotationSlider.value));
rotationSlider.onchange=()=>{if(!rotationSliderHeld)finishSliderRotation();};
rotationSlider.onpointerup=finishSliderRotation;rotationSlider.onpointercancel=finishSliderRotation;rotationSlider.onkeyup=finishSliderRotation;rotationSlider.onblur=finishSliderRotation;
el('rotation-reset').onclick=()=>{stop();setRotation(0,false);persist();};
el<HTMLInputElement>('speed').oninput=e=>{speed=Number((e.target as HTMLInputElement).value);el('speed-value').textContent=speed.toFixed(1)+'×';};
el<HTMLInputElement>('profiling').onchange=e=>{profilingEnabled=(e.target as HTMLInputElement).checked;engine?.setProfiling(profilingEnabled);el('profiling-data').textContent=profilingEnabled?'Waiting for the next render.':'GPU timings are off.';};
el<HTMLInputElement>('iteration-slider').oninput=e=>{const n=iterationFromSlider(Number((e.target as HTMLInputElement).value));el('iteration-value').textContent=n.toLocaleString();};
el<HTMLInputElement>('iteration-slider').onchange=e=>load({...snapshot(),iterations:iterationFromSlider(Number((e.target as HTMLInputElement).value))});
el<HTMLFormElement>('coordinates').onsubmit=e=>{e.preventDefault();try{load({...snapshot(),x:el<HTMLInputElement>('cx').value,y:el<HTMLInputElement>('cy').value,span:el<HTMLInputElement>('span').value});}catch(err){message(String(err));}};
const locationEntry=el<HTMLInputElement>('location-entry'),locationOptions=el<HTMLElement>('location-options');
const replaceLocation=el<HTMLElement>('replace-location');
let visibleLocations:LocationChoice[]=[],locationOptionsOpen=false,filterLocations=false,activeLocation=-1;
let pendingReplacement:{name:string;index:number;view:SavedView}|null=null;
function closeLocationOptions(){locationOptionsOpen=false;activeLocation=-1;locationOptions.hidden=true;locationEntry.setAttribute('aria-expanded','false');locationEntry.removeAttribute('aria-activedescendant');}
function dismissReplacement(){pendingReplacement=null;replaceLocation.hidden=true;}
function selectLocation(choice:LocationChoice){
  const item=choice.kind==='place'?PLACES[choice.index]:saved[choice.index];if(!item)return;
  selectedLocation={...choice,name:item.name};locationEntry.value=item.name;dismissReplacement();closeLocationOptions();load(choice.kind==='place'?PLACES[choice.index]:saved[choice.index].view);
}
function highlightLocation(){
  locationOptions.querySelectorAll<HTMLElement>('[role=option]').forEach((item,index)=>item.setAttribute('aria-selected',String(index===activeLocation)));
  if(activeLocation<0){locationEntry.removeAttribute('aria-activedescendant');return;}
  const item=locationOptions.querySelectorAll<HTMLElement>('[role=option]')[activeLocation];
  if(item){locationEntry.setAttribute('aria-activedescendant',item.id);item.scrollIntoView({block:'nearest'});}
}
function renderLocationOptions(){
  const query=filterLocations?locationEntry.value.trim().toLocaleLowerCase():'';
  visibleLocations=[...PLACES.map((item,index)=>({kind:'place' as const,index,name:item.name})),...saved.map((item,index)=>({kind:'saved' as const,index,name:item.name}))]
    .filter(item=>item.name.toLocaleLowerCase().includes(query));
  locationOptions.replaceChildren();
  visibleLocations.forEach((choice,index)=>{
    const option=document.createElement('div');option.id=`location-option-${index}`;option.className='location-option';option.setAttribute('role','option');
    option.dataset.locationKind=choice.kind;option.dataset.locationIndex=String(choice.index);
    option.textContent=`${choice.kind==='place'?'Place':'Saved'} · ${choice.name}`;
    option.onpointerdown=event=>event.preventDefault();option.onclick=()=>selectLocation(choice);locationOptions.append(option);
  });
  if(!visibleLocations.length){const empty=document.createElement('div');empty.className='location-empty';empty.textContent='No matching location. Save to create one.';locationOptions.append(empty);}
  locationOptions.hidden=!locationOptionsOpen;locationEntry.setAttribute('aria-expanded',String(locationOptionsOpen));highlightLocation();
}
locationEntry.onfocus=()=>{filterLocations=false;activeLocation=-1;locationOptionsOpen=true;renderLocationOptions();};
locationEntry.onclick=()=>{if(!locationOptionsOpen){filterLocations=false;locationOptionsOpen=true;renderLocationOptions();}};
locationEntry.oninput=()=>{dismissReplacement();filterLocations=true;activeLocation=-1;locationOptionsOpen=true;renderLocationOptions();};
locationEntry.onblur=()=>setTimeout(()=>{if(document.activeElement!==locationEntry)closeLocationOptions();},0);
locationEntry.onkeydown=event=>{
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();if(!locationOptionsOpen){filterLocations=false;locationOptionsOpen=true;renderLocationOptions();}
    if(visibleLocations.length){activeLocation=event.key==='ArrowDown'?(activeLocation+1)%visibleLocations.length:activeLocation<0?visibleLocations.length-1:(activeLocation-1+visibleLocations.length)%visibleLocations.length;highlightLocation();}
  }else if(event.key==='Enter'&&locationOptionsOpen&&activeLocation>=0){event.preventDefault();selectLocation(visibleLocations[activeLocation]);}
  else if(event.key==='Escape')closeLocationOptions();
};
function storeLocation(name:string,index:number,nextView:SavedView){
  const next=saved.slice(),target=index<0?next.length:index;next[target]={name,view:nextView};
  try{localStorage.setItem('gpu-zoomer-locations',JSON.stringify(next));saved=next;selectedLocation={kind:'saved',index:target,name};locationEntry.value=name;dismissReplacement();closeLocationOptions();message(index<0?'Location saved on this browser.':'Location updated on this browser.',true);}
  catch{dismissReplacement();message('Local storage is unavailable. Copy a share link instead.');}
}
el('save').onclick=()=>{
  const name=locationEntry.value.trim()||`${view.family} ${saved.length+1}`,nextView=snapshot();
  const selectedIndex=selectedLocation?.kind==='saved'?selectedLocation.index:-1;
  if(selectedIndex>=0&&saved[selectedIndex]?.name.toLocaleLowerCase()===name.toLocaleLowerCase()){storeLocation(name,selectedIndex,nextView);return;}
  const collision=saved.findIndex(item=>item.name.toLocaleLowerCase()===name.toLocaleLowerCase());
  if(collision<0){storeLocation(name,-1,nextView);return;}
  pendingReplacement={name,index:collision,view:nextView};el('replace-location-text').textContent=`Replace saved location “${saved[collision].name}” with this view?`;
  replaceLocation.hidden=false;closeLocationOptions();el<HTMLButtonElement>('replace-cancel').focus();
};
el('replace-cancel').onclick=()=>{dismissReplacement();el<HTMLButtonElement>('save').focus();};
el('replace-confirm').onclick=()=>{if(!pendingReplacement)return;const {name,index,view:nextView}=pendingReplacement;storeLocation(name,index,nextView);el<HTMLButtonElement>('save').focus();};
el('share').onclick=async()=>{persist();const url=new URL(location.href);url.hash=encodeView(snapshot());try{await navigator.clipboard.writeText(url.href);message('Exact view link copied. Reloads stay at Home until the link is explicitly opened.');}catch{message(`Copy this exact link: ${url.href}`);}};
el('open-linked-location').onclick=()=>{if(!linkedView)return;const next=linkedView;linkedView=null;el('linked-location').hidden=true;load(next);message('Linked location opened.');};
const panelController=setupPanels();
const paletteController=setupPaletteEditor(()=>colors,c=>{
  const previous=colors,changed=JSON.stringify(renderColors(previous))!==JSON.stringify(renderColors(c));
  const completedBefore=currentFieldComplete()||preparingColourData;
  colors=c;
  if(changed){
    const missingData=previous.mode!==c.mode||needsEndpoints(c)&&!engine?.endpointChannelsRequired();
    const numericalChange=missingData||previous.supersample!==c.supersample;
    if(stopped&&previous.supersample===c.supersample){
      generation++;engine?.abort();preparingColourData=false;dirty=false;
      stoppedAppearancePending=true;
    }else{
      if(stopped){stopped=false;refinementTime.demand(performance.now());}
      if(numericalChange){
        const wasPreparing=preparingColourData,previousTarget=colourDataTarget,currentTarget=engine?.debugProgress().targets??0;
        const resized=resize(false);
        preparingColourData=completedBefore&&!resized&&missingData&&previous.supersample===c.supersample;
        if(preparingColourData)colourDataTarget=wasPreparing&&previous.mode===c.mode?previousTarget:currentTarget;
        if(!preparingColourData)completedQuality=0;
        generation++;engine?.abort();preparing();
      }
      dirty=true;if(previewEnabled)queuePreview();
    }
  }
  clearTimeout(appearanceSave);appearanceSave=setTimeout(()=>persist(false),250);
});
syncAppearance=paletteController.sync;
el('full-reset').onclick=()=>{
  clearTimeout(wheelSave);clearTimeout(appearanceSave);clearTimeout(messageDismissTimer);clearTimeout(messageFadeTimer);
  stop();setPreview(false);previewEngine?.abort();selectedJulia=null;displayedJulia=null;juliaReturn=null;linkedView=null;
  speed=.8;el<HTMLInputElement>('speed').value='.8';el('speed-value').textContent='0.8×';
  selectedLocation=null;locationEntry.value='';dismissReplacement();closeLocationOptions();el<HTMLSelectElement>('random-style').value='harmonious';
  profilingEnabled=false;el<HTMLInputElement>('profiling').checked=false;engine?.setProfiling(false);el('profiling-data').textContent='GPU timings are off.';
  try{localStorage.removeItem('gpu-zoomer-view');localStorage.removeItem('gpu-zoomer-layout');}catch{}
  history.replaceState(null,'',location.pathname+location.search);el('linked-location').hidden=true;
  panelController.reset();load({...HOME,appearance:validateColors(DEFAULT_COLORS)},false);paletteController.reset();message('Defaults restored. Saved locations were kept.',true);
};
el('screenshot').onclick=async()=>{
  const button=el<HTMLButtonElement>('screenshot');button.disabled=true;
  try{
    const frame=await engine.capturePixels(request());
    const output=document.createElement('canvas');output.width=frame.width;output.height=frame.height;
    const context=output.getContext('2d');if(!context)throw new Error('PNG encoding is unavailable in this browser.');
    const imageBytes=new Uint8ClampedArray(frame.pixels.length);imageBytes.set(frame.pixels);
    context.putImageData(new ImageData(imageBytes,frame.width,frame.height),0,0);
    const blob=await new Promise<Blob>((resolve,reject)=>output.toBlob(value=>value?resolve(value):reject(new Error('PNG encoding failed.')),'image/png'));
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`webgpu-zoomer-${frame.width}x${frame.height}.png`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
    message(`Saved ${frame.width}×${frame.height} PNG.`,true);
  }catch(reason){message(String(reason));}
  finally{button.disabled=!engine?.isComplete(request());}
};
export const ready=(async()=>{
  try{saved=JSON.parse(localStorage.getItem('gpu-zoomer-locations')||'[]').map((s:{name:string;view:unknown})=>({name:String(s.name),view:validateView(s.view)}));}catch{saved=[];}
  let rememberedAppearance=DEFAULT_COLORS;try{const remembered=validateView(JSON.parse(localStorage.getItem('gpu-zoomer-view')||'null'));rememberedAppearance=remembered.appearance??DEFAULT_COLORS;}catch{}
  let linkedError=false;if(location.hash){try{linkedView=decodeView(location.hash.slice(1));}catch{linkedError=true;}}
  load({...HOME,appearance:validateColors(rememberedAppearance)},false);
  el('linked-location').hidden=!linkedView;if(linkedError)message('The linked view could not be read; showing Home.');
  resize();requestAnimationFrame(tick);
  try{const ctx=await acquireGpu();gpuContext=ctx;resize();const renderer=new WebGpuRenderer(ctx,canvas);await renderer.init();engine=renderer;if(import.meta.env.DEV)(window as typeof window&{__gpuZoomerEngine?:WebGpuRenderer}).__gpuZoomerEngine=renderer;engine.setProfiling(profilingEnabled);dirty=true;ctx.lost.then(info=>{if(info.reason!=='destroyed'){engine.abort();error='GPU connection lost. Reload this page to reconnect.';message(error);stop();setPreview(false);}});return ctx.capabilities;}
  catch(e){error=String(e);message(error);throw e;}
})();
// Development-only access exercises the displayed app and its real field.
export const testing = import.meta.env.DEV ? {
  load, snapshot, camera, get engine(){return engine;},
  capture:()=>engine.capturePixels(request()),
  selectPreview(x:number,y:number){pointer={x,y};selectJuliaAtPointer();},
  juliaPreview:()=>({enabled:previewEnabled,busy:previewBusy,pending:previewPending,epoch:previewEpoch,renderedEpoch:previewRenderedEpoch,size:{...previewSize},selected:selectedJulia?{...selectedJulia}:null,displayed:displayedJulia?{...displayedJulia}:null,returnView:juliaReturn?{...juliaReturn}:null,work:previewEngine?.debugProgress()}),
  status:()=>({busy,dirty,stopped,refreshPending,refreshHolding,stoppedAppearancePending,error,fields,recolours,effectiveLimit:view.iterations,lastRevision,revision:camera.revision,quality:completedQuality,stats,progress:engine?.debugProgress(),frameCount,frameTimes:[...frameTimes],elapsed:performance.now()-sessionStart}),
  resetTiming(){frameTimes=[];frameCount=0;sessionStart=performance.now();},
} : undefined;
if(import.meta.env.DEV)(window as typeof window&{__gpuZoomerTesting?:typeof testing}).__gpuZoomerTesting=testing;
