import './style.css';
import Decimal from 'decimal.js';
import { acquireGpu, type GpuContext } from './gpu/device';
import { WebGpuRenderer, type RenderRequest, type RenderStats } from './render/webgpu-renderer';
import { DEFAULT_COLORS, validateColors } from './logic/colorSettings';
import { Camera, HOME, validateView, encodeView, decodeView, depthLabel, iterationFromSlider, iterationToSlider, type SavedView, type Family } from './state';
import { PLACES } from './places';
import { setupPanels } from './panels';
import { setupPaletteEditor } from './palette-editor';

const el = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const canvas=el<HTMLCanvasElement>('fractal');
const camera=new Camera();
let view:SavedView={...HOME}, colors={...DEFAULT_COLORS}, engine:WebGpuRenderer;
let generation=0, busy=false, dirty=true, error='', lastInteraction=0, lastRevision=-1;
let fields=0, recolours=0, lastFresh=0, stats:RenderStats|undefined, completedQuality=0;
let pointer={x:innerWidth/2,y:innerHeight/2}, direction=0, wheelDirection=0, dragging=false, speed=1, previousTime=0, statusTime=0;
let juliaReturn:SavedView|null=null;
let gpuContext:GpuContext|undefined, previewEngine:WebGpuRenderer|undefined;
let profilingEnabled=false;
let previewEnabled=false, selecting=false, previewBusy=false, previewPending=false, previewEpoch=0, previewRenderedEpoch=-1;
let selectedJulia:{x:string;y:string}|null=null;
let displayedJulia:{x:string;y:string}|null=null,previewLifetime=0;
const previewCanvas=el<HTMLCanvasElement>('julia-preview-canvas');
let previewSize={width:previewCanvas.width,height:previewCanvas.height};
const keys=new Set<string>(), timeline:SavedView[]=[];let timelineIndex=-1;
let saved: {name:string;view:SavedView}[]=[];
let frameTimes:number[]=[], frameCount=0, sessionStart=performance.now();
const cadence=el('cadence'),freshness=el('freshness'),depth=el('depth');
let syncAppearance=()=>{};
function message(text:string){el('message').textContent=text;}
function snapshot():SavedView{return {...view,x:camera.x.toString(),y:camera.y.toString(),span:camera.span.toString(),appearance:validateColors(colors)};}
function checkpoint(){const s=snapshot();if(timelineIndex>=0 && encodeView(timeline[timelineIndex])===encodeView(s))return;timeline.splice(timelineIndex+1);timeline.push(s);timelineIndex=timeline.length-1;historyButtons();}
function historyButtons(){el<HTMLButtonElement>('back').disabled=timelineIndex<=0;el<HTMLButtonElement>('forward').disabled=timelineIndex>=timeline.length-1;}
function stop(){direction=0;wheelDirection=0;dragging=false;selecting=false;keys.clear();}
function syncPlace(){
  const index=PLACES.findIndex(p=>p.family===view.family && p.iterations===view.iterations && camera.x.eq(p.x) && camera.y.eq(p.y) && camera.span.eq(p.span) && (view.family==='mandelbrot'||new Decimal(view.jx).eq(p.jx)&&new Decimal(view.jy).eq(p.jy)));
  el<HTMLSelectElement>('places').value=index<0?'':String(index);
}
function syncControls(){
  el<HTMLSelectElement>('family').value=view.family;el('set-label').textContent=view.family.toUpperCase();
  el<HTMLFormElement>('julia-form').hidden=view.family!=='julia';el<HTMLInputElement>('iterations').value=String(view.iterations);
  el<HTMLInputElement>('iteration-slider').value=String(iterationToSlider(view.iterations));
  el('iteration-value').textContent=view.iterations.toLocaleString();
  el<HTMLInputElement>('jx').value=view.jx;el<HTMLInputElement>('jy').value=view.jy;
  el<HTMLTextAreaElement>('cx').value=camera.x.toString();el<HTMLTextAreaElement>('cy').value=camera.y.toString();el<HTMLInputElement>('span').value=camera.span.toString();
  el<HTMLButtonElement>('return').disabled=view.family!=='julia'||!juliaReturn;
  el<HTMLButtonElement>('julia-from').disabled=view.family==='julia';
  syncPlace();syncJuliaPreview();
  syncAppearance();
}
function load(next:SavedView,record=true){
  const valid=validateView(next);if(record && engine)checkpoint();stop();view=valid;colors=validateColors(valid.appearance??DEFAULT_COLORS);camera.load(valid);generation++;
  if(view.family==='julia')setPreview(false);
  engine?.invalidateHistory();completedQuality=0;dirty=true;lastRevision=-1;lastInteraction=0;error='';message('');syncControls();
  if(record){checkpoint();persist();}
}
function persist(){
  const s=snapshot();try{localStorage.setItem('gpu-zoomer-view',JSON.stringify(s));history.replaceState(null,'','#'+encodeView(s));}catch{message('This browser could not save the view locally. Copy a share link to keep it.');}
  syncControls();
}
function moving(){return direction!==0||dragging||keys.size>0||performance.now()-lastInteraction<180;}
function changed(){dirty=true;lastInteraction=performance.now();syncPlace();}
function syncJuliaPreview(){
  const visible=previewEnabled && view.family==='mandelbrot';
  el('julia-preview').hidden=!visible;
  el('julia-from').setAttribute('aria-pressed',String(visible));
  el('julia-from').textContent=visible?'Close Julia preview':'Julia preview · J';
  canvas.classList.toggle('selecting-julia',visible);
  el<HTMLButtonElement>('julia-promote').disabled=!selectedJulia;
}
function queuePreview(){
  previewEpoch++;previewPending=true;
  el('julia-preview').setAttribute('aria-busy','true');
}
function measurePreview(){
  if(!previewEnabled)return;
  const rect=el('julia-preview-viewport').getBoundingClientRect();
  if(rect.width<=0||rect.height<=0)return;
  const dpr=devicePixelRatio||1;
  const limit=gpuContext?.device.limits.maxTextureDimension2D??Infinity;
  const limits=gpuContext?.device.limits;
  const pixelLimit=limits?Math.floor(Math.min(limits.maxStorageBufferBindingSize,limits.maxBufferSize)/8):Infinity;
  const scale=Math.min(dpr,limit/rect.width,limit/rect.height,Math.sqrt(pixelLimit/(rect.width*rect.height)));
  const round=scale<dpr?Math.floor:Math.round;
  const width=Math.max(1,round(rect.width*scale)),height=Math.max(1,round(rect.height*scale));
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
  if(!previewEnabled){previewLifetime++;previewEpoch++;previewPending=false;previewEngine?.abort();}
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
  if(previewBusy||!previewPending||!previewEnabled||!selectedJulia||!gpuContext)return;
  previewBusy=true;previewPending=false;
  const epoch=previewEpoch,lifetime=previewLifetime,selected={...selectedJulia},size={...previewSize};
  const current=()=>previewEnabled && view.family==='mandelbrot' && previewLifetime===lifetime;
  try{
    // One persistent small renderer, with its own fields/history/uniforms.
    if(!previewEngine){previewEngine=new WebGpuRenderer(gpuContext,previewCanvas);await previewEngine.init();}
    if(!current())return;
    const req:RenderRequest={centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal(3.2).div(size.height),width:size.width,height:size.height,maxIterations:1000,colors:{...colors,mode:0,supersample:1},family:'julia',juliaX:new Decimal(selected.x),juliaY:new Decimal(selected.y),useApprox:false,publishPartial:false,isCurrent:current};
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
    const next=validateView({...HOME,family:'julia',x:'0',jx:selectedJulia.x,jy:selectedJulia.y,iterations:view.iterations,appearance:validateColors(colors)});
    juliaReturn=snapshot();load(next);
  }else message('Press J, then select a point for the Julia preview.');
  canvas.focus();
}
function request():RenderRequest{
  const width=Math.max(8,canvas.width),height=Math.max(8,canvas.height);const g=generation;
  return {centerX:camera.x,centerY:camera.y,unitsPerPixel:camera.span.div(height),width,height,maxIterations:view.iterations,colors:{...colors},family:view.family,juliaX:new Decimal(view.jx),juliaY:new Decimal(view.jy),interacting:moving(),followView:true,betweenBatches:computeJuliaPreview,focus:{x:pointer.x/innerWidth,y:pointer.y/innerHeight},zoom:direction||(keys.has('+')||keys.has('=')?1:keys.has('-')?-1:performance.now()-lastInteraction<180?wheelDirection:0),isCurrent:()=>generation===g};
}
async function compute(){
  if(busy||!engine||error)return;busy=true;dirty=false;const g=generation;
  try{
    const result=await engine.render(request());
    if(g===generation && result.completed && engine.isComplete(request())){stats=result;if(result.computed){fields++;lastFresh=performance.now();}else recolours++;
      lastRevision=camera.revision;completedQuality=1;dirty=false;
    }
  }catch(e){if(!(e instanceof DOMException && e.name==='AbortError')){error=String(e);message(error);}}
  finally{busy=false;if(lastRevision!==camera.revision||g!==generation)dirty=true;}
}
function resize(){measurePreview();const dpr=devicePixelRatio||1;const width=Math.round(innerWidth*dpr),height=Math.round(innerHeight*dpr);if(canvas.width===width&&canvas.height===height)return;canvas.width=width;canvas.height=height;dirty=true;}
function tick(time:number){
  const dt=previousTime?time-previousTime:0;previousTime=time;
  if(dt>0){frameTimes.push(dt);if(frameTimes.length>300)frameTimes.shift();}frameCount++;
  if(!document.hidden){
    const zoom=direction||(keys.has('+')||keys.has('=')?1:keys.has('-')?-1:0);
    if(zoom && dt){camera.zoom(-zoom*speed*dt/1000,pointer.x,pointer.y,innerWidth,innerHeight);changed();}
    let dx=0,dy=0;if(keys.has('ArrowLeft'))dx+=dt*.3;if(keys.has('ArrowRight'))dx-=dt*.3;if(keys.has('ArrowUp'))dy+=dt*.3;if(keys.has('ArrowDown'))dy-=dt*.3;
    if(dx||dy){camera.pan(dx,dy,innerHeight);changed();}
    if(engine){
      engine.reproject(request());
      // Give the latest preview one turn between main jobs, without awaiting it.
      // Both renderers keep at most one bounded numerical region in the queue.
      if(!busy&&!previewBusy&&previewPending)void computeJuliaPreview();
      if(dirty&&!busy)void compute();
    }
    if(time-statusTime>250){statusTime=time;const mean=frameTimes.reduce((a,b)=>a+b,0)/Math.max(1,frameTimes.length);cadence.textContent=`Presentation ${Math.round(1000/mean)||0} Hz`;
      const fresh=!busy && !dirty && !moving() && lastRevision===camera.revision && completedQuality===1;
      const progress=engine?.debugProgress();
      const state=fresh?'Refined':progress?.active&&progress.regions?`Refining · ${progress.regions} regions`:busy?'Computing':'Preview';
      freshness.textContent=error?'Rendering stopped':`${state} · ${progress?.lastPublicationAt?Math.max(0,(time-progress.lastPublicationAt)/1000).toFixed(1)+'s since update':lastFresh?'Field ready':'first update pending'}`;
      depth.textContent=`${depthLabel(camera.span)} · ${view.iterations.toLocaleString()} iterations`;
      if(profilingEnabled&&engine){
        const profile=engine.performance();
        const phases=Object.entries(profile.phases).filter(([,p])=>p.count).map(([name,p])=>`${name==='calculate'?'Calculation':'Shading'}: ${p.meanMs.toFixed(2)} ms mean, ${p.p95Ms.toFixed(2)} ms p95 (${p.count} samples)`);
        el('profiling-data').textContent=!profile.supported?'GPU timings are unavailable on this device.':phases.join(' · ')||'Waiting for the next render.';
      }
    }
  }
  requestAnimationFrame(tick);
}
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{if(e.button>2)return;canvas.focus();canvas.setPointerCapture(e.pointerId);pointer={x:e.clientX,y:e.clientY};
  if(previewEnabled && view.family==='mandelbrot' && e.button===0){e.preventDefault();stop();selecting=true;selectJuliaAtPointer();return;}
  checkpoint();wheelDirection=0;dragging=e.shiftKey||e.button===1;direction=dragging?0:e.button===2?-1:1;changed();});
canvas.addEventListener('pointermove',e=>{if(selecting){pointer={x:e.clientX,y:e.clientY};selectJuliaAtPointer();return;}if(dragging){camera.pan(e.clientX-pointer.x,e.clientY-pointer.y,innerHeight);changed();}pointer={x:e.clientX,y:e.clientY};});
function endPointer(e:PointerEvent){if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);if(selecting){stop();return;}stop();checkpoint();persist();}
canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',()=>{stop();});
let wheelSave:ReturnType<typeof setTimeout>;
canvas.addEventListener('wheel',e=>{e.preventDefault();pointer={x:e.clientX,y:e.clientY};const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?innerHeight:1);wheelDirection=-Math.sign(delta);camera.zoom(Math.max(-1,Math.min(1,delta*.002))*speed,pointer.x,pointer.y,innerWidth,innerHeight);changed();clearTimeout(wheelSave);wheelSave=setTimeout(()=>{checkpoint();persist();},250);},{passive:false});
canvas.addEventListener('keydown',e=>{if(e.key==='Escape'){stop();return;}if(['+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();wheelDirection=0;keys.add(e.key);changed();}});
canvas.addEventListener('keyup',e=>{if(!keys.delete(e.key))return;checkpoint();persist();});
document.addEventListener('keydown',e=>{
  if(e.repeat||e.ctrlKey||e.metaKey||e.altKey||(e.target instanceof HTMLElement && (e.target.isContentEditable||e.target.closest('input,textarea,select'))))return;
  const key=e.key.toLowerCase();if(key!=='j'&&key!=='m')return;e.preventDefault();
  try{if(key==='j')toggleJuliaPreview();else switchJuliaView();}catch(err){message(String(err));}
});
window.addEventListener('blur',stop);document.addEventListener('visibilitychange',()=>{stop();previousTime=0;});window.addEventListener('resize',resize);
el<HTMLSelectElement>('family').onchange=e=>{const family=(e.target as HTMLSelectElement).value as Family;if(family===view.family)return;if(family==='mandelbrot'&&juliaReturn){switchJuliaView();return;}if(family==='julia')juliaReturn=snapshot();load({...HOME,family,x:family==='julia'?'0':HOME.x,jx:view.jx,jy:view.jy,iterations:view.iterations});};
el('julia-from').onclick=toggleJuliaPreview;
el('julia-preview-close').onclick=()=>{setPreview(false);canvas.focus();};
el('julia-promote').onclick=()=>{try{switchJuliaView();}catch(err){message(String(err));}};
el('return').onclick=switchJuliaView;
el('reset').onclick=()=>load({...HOME,family:view.family,x:view.family==='julia'?'0':HOME.x,jx:view.jx,jy:view.jy});
el('back').onclick=()=>{if(timelineIndex>0){load(timeline[--timelineIndex],false);historyButtons();persist();}};
el('forward').onclick=()=>{if(timelineIndex<timeline.length-1){load(timeline[++timelineIndex],false);historyButtons();persist();}};
PLACES.forEach((p,i)=>el<HTMLSelectElement>('places').add(new Option(p.name,String(i))));el<HTMLSelectElement>('places').onchange=e=>{const v=(e.target as HTMLSelectElement).value;if(v!=='')load(PLACES[Number(v)]);};
el<HTMLInputElement>('speed').oninput=e=>{speed=Number((e.target as HTMLInputElement).value);el('speed-value').textContent=speed.toFixed(1)+'×';};
el<HTMLInputElement>('profiling').onchange=e=>{profilingEnabled=(e.target as HTMLInputElement).checked;engine?.setProfiling(profilingEnabled);el('profiling-data').textContent=profilingEnabled?'Waiting for the next render.':'GPU timings are off.';};
el<HTMLInputElement>('iterations').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();try{load({...snapshot(),iterations:Number((e.target as HTMLInputElement).value)});}catch(err){message(String(err));}}};
el<HTMLInputElement>('iteration-slider').oninput=e=>{const n=iterationFromSlider(Number((e.target as HTMLInputElement).value));el('iteration-value').textContent=n.toLocaleString();el<HTMLInputElement>('iterations').value=String(n);};
el<HTMLInputElement>('iteration-slider').onchange=e=>load({...snapshot(),iterations:iterationFromSlider(Number((e.target as HTMLInputElement).value))});
el<HTMLFormElement>('coordinates').onsubmit=e=>{e.preventDefault();try{load({...snapshot(),x:el<HTMLInputElement>('cx').value,y:el<HTMLInputElement>('cy').value,span:el<HTMLInputElement>('span').value});}catch(err){message(String(err));}};
el<HTMLFormElement>('julia-form').onsubmit=e=>{e.preventDefault();try{load({...snapshot(),jx:el<HTMLInputElement>('jx').value,jy:el<HTMLInputElement>('jy').value});}catch(err){message(String(err));}};
function savedOptions(){const select=el<HTMLSelectElement>('saved');select.replaceChildren(new Option(saved.length?'Choose a saved location…':'No saved locations',''));saved.forEach((s,i)=>select.add(new Option(s.name,String(i))));}
el('save').onclick=()=>{saved.push({name:el<HTMLInputElement>('location-name').value.trim()||`${view.family} ${saved.length+1}`,view:snapshot()});try{localStorage.setItem('gpu-zoomer-locations',JSON.stringify(saved));savedOptions();message('Location saved on this browser.');}catch{message('Local storage is unavailable. Copy a share link instead.');}};
el<HTMLSelectElement>('saved').onchange=e=>{const v=(e.target as HTMLSelectElement).value;if(v!=='')load(saved[Number(v)].view);};
el('share').onclick=async()=>{persist();try{await navigator.clipboard.writeText(location.href);message('Exact view link copied.');}catch{message('Copy the address bar to share this exact view.');}};
setupPanels();
let appearanceSave:ReturnType<typeof setTimeout>;
syncAppearance=setupPaletteEditor(()=>colors,c=>{colors=c;dirty=true;if(previewEnabled)queuePreview();clearTimeout(appearanceSave);appearanceSave=setTimeout(persist,250);});
export const ready=(async()=>{
  try{saved=JSON.parse(localStorage.getItem('gpu-zoomer-locations')||'[]').map((s:{name:string;view:unknown})=>({name:String(s.name),view:validateView(s.view)}));}catch{saved=[];}savedOptions();
  try{const restored=location.hash?decodeView(location.hash.slice(1)):JSON.parse(localStorage.getItem('gpu-zoomer-view')||'null');load(restored||HOME,false);}catch{load(HOME,false);message('The saved view could not be read; showing the whole set.');}
  checkpoint();resize();requestAnimationFrame(tick);
  try{const ctx=await acquireGpu();gpuContext=ctx;measurePreview();const renderer=new WebGpuRenderer(ctx,canvas);await renderer.init();engine=renderer;engine.setProfiling(profilingEnabled);dirty=true;ctx.lost.then(info=>{if(info.reason!=='destroyed'){error='GPU connection lost. Reload this page to reconnect.';message(error);stop();setPreview(false);}});return ctx.capabilities;}
  catch(e){error=String(e);message(error);throw e;}
})();
// Development-only access exercises the displayed app and its real field.
export const testing = import.meta.env.DEV ? {
  load, snapshot, camera, get engine(){return engine;},
  selectPreview(x:number,y:number){pointer={x,y};selectJuliaAtPointer();},
  juliaPreview:()=>({enabled:previewEnabled,busy:previewBusy,pending:previewPending,epoch:previewEpoch,renderedEpoch:previewRenderedEpoch,size:{...previewSize},selected:selectedJulia?{...selectedJulia}:null,displayed:displayedJulia?{...displayedJulia}:null,returnView:juliaReturn?{...juliaReturn}:null}),
  status:()=>({busy,dirty,error,fields,recolours,lastRevision,revision:camera.revision,quality:completedQuality,stats,frameCount,frameTimes:[...frameTimes],elapsed:performance.now()-sessionStart}),
  resetTiming(){frameTimes=[];frameCount=0;sessionStart=performance.now();},
} : undefined;
