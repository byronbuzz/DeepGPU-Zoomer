import './style.css';
import Decimal from 'decimal.js';
import { acquireGpu, type GpuContext } from './gpu/device';
import { WebGpuRenderer, type RenderRequest, type RenderStats } from './render/webgpu-renderer';
import { DEFAULT_COLORS } from './logic/colorSettings';
import { Camera, HOME, validateView, encodeView, decodeView, type SavedView, type Family } from './state';
import { PLACES } from './places';

const el = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const canvas=el<HTMLCanvasElement>('fractal');
const camera=new Camera();
let view:SavedView={...HOME}, colors={...DEFAULT_COLORS}, engine:WebGpuRenderer;
let generation=0, busy=false, dirty=true, error='', lastInteraction=0, quality=1, lastRevision=-1;
let fields=0, recolours=0, lastFresh=0, stats:RenderStats|undefined, completedQuality=0;
let pointer={x:innerWidth/2,y:innerHeight/2}, direction=0, dragging=false, speed=1, previousTime=0, statusTime=0, wasMoving=false;
let juliaReturn:SavedView|null=null;
let gpuContext:GpuContext|undefined, previewEngine:WebGpuRenderer|undefined;
let previewEnabled=false, selecting=false, previewBusy=false, previewPending=false, previewEpoch=0, previewRenderedEpoch=-1;
let selectedJulia:{x:string;y:string}|null=null;
const previewCanvas=el<HTMLCanvasElement>('julia-preview-canvas');
const keys=new Set<string>(), timeline:SavedView[]=[];let timelineIndex=-1;
let saved: {name:string;view:SavedView}[]=[];
let frameTimes:number[]=[], frameCount=0, sessionStart=performance.now();
const cadence=el('cadence'),freshness=el('freshness'),depth=el('depth');
function message(text:string){el('message').textContent=text;}
function snapshot():SavedView{return {...view,x:camera.x.toString(),y:camera.y.toString(),span:camera.span.toString()};}
function checkpoint(){const s=snapshot();if(timelineIndex>=0 && encodeView(timeline[timelineIndex])===encodeView(s))return;timeline.splice(timelineIndex+1);timeline.push(s);timelineIndex=timeline.length-1;historyButtons();}
function historyButtons(){el<HTMLButtonElement>('back').disabled=timelineIndex<=0;el<HTMLButtonElement>('forward').disabled=timelineIndex>=timeline.length-1;}
function stop(){direction=0;dragging=false;selecting=false;keys.clear();}
function syncPlace(){
  const index=PLACES.findIndex(p=>p.family===view.family && p.iterations===view.iterations && camera.x.eq(p.x) && camera.y.eq(p.y) && camera.span.eq(p.span) && (view.family==='mandelbrot'||new Decimal(view.jx).eq(p.jx)&&new Decimal(view.jy).eq(p.jy)));
  el<HTMLSelectElement>('places').value=index<0?'':String(index);
}
function syncControls(){
  el<HTMLSelectElement>('family').value=view.family;el('set-label').textContent=view.family.toUpperCase();
  el<HTMLFormElement>('julia-form').hidden=view.family!=='julia';el<HTMLInputElement>('iterations').value=String(view.iterations);
  el<HTMLInputElement>('jx').value=view.jx;el<HTMLInputElement>('jy').value=view.jy;
  el<HTMLTextAreaElement>('cx').value=camera.x.toString();el<HTMLTextAreaElement>('cy').value=camera.y.toString();el<HTMLInputElement>('span').value=camera.span.toString();
  el<HTMLButtonElement>('return').disabled=view.family!=='julia'||!juliaReturn;
  el<HTMLButtonElement>('julia-from').disabled=view.family==='julia';
  syncPlace();syncJuliaPreview();
}
function load(next:SavedView,record=true){
  const valid=validateView(next);if(record && engine)checkpoint();stop();view=valid;camera.load(valid);generation++;
  if(view.family==='julia')setPreview(false);
  engine?.invalidateHistory();quality=1;completedQuality=0;dirty=true;lastRevision=-1;lastInteraction=0;error='';message('');syncControls();
  if(record){checkpoint();persist();}
}
function persist(){
  const s=snapshot();try{localStorage.setItem('gpu-zoomer-view',JSON.stringify(s));history.replaceState(null,'','#'+encodeView(s));}catch{message('This browser could not save the view locally. Copy a share link to keep it.');}
  syncControls();
}
function moving(){return direction!==0||dragging||keys.size>0||performance.now()-lastInteraction<180;}
function changed(){dirty=true;quality=engine?.calculationScale(canvas.width,canvas.height)??1;lastInteraction=performance.now();syncPlace();}
function syncJuliaPreview(){
  const visible=previewEnabled && view.family==='mandelbrot';
  el('julia-preview').hidden=!visible;
  el('julia-from').setAttribute('aria-pressed',String(visible));
  el('julia-from').textContent=visible?'Close Julia preview':'Julia preview · J';
  canvas.classList.toggle('selecting-julia',visible);
  el<HTMLButtonElement>('julia-promote').disabled=!selectedJulia;
}
function queuePreview(){
  previewEpoch++;previewPending=true;previewEngine?.abort();
  el('julia-preview').setAttribute('aria-busy','true');
  el('julia-preview-status').textContent='Updating preview…';
}
function selectJuliaAtPointer(){
  if(view.family!=='mandelbrot')return;
  const rect=canvas.getBoundingClientRect();
  const p=camera.point(Math.max(0,Math.min(rect.width,pointer.x-rect.left)),Math.max(0,Math.min(rect.height,pointer.y-rect.top)),rect.width,rect.height);
  const next={x:p.x.toString(),y:p.y.toString()};
  if(selectedJulia?.x===next.x && selectedJulia.y===next.y)return;
  selectedJulia=next;
  el('julia-preview-constant').textContent=`c = ${next.x} ${new Decimal(next.y).isNegative()?'−':'+'} ${new Decimal(next.y).abs().toString()}i`;
  queuePreview();syncJuliaPreview();
}
function setPreview(enabled:boolean){
  previewEnabled=enabled && view.family==='mandelbrot';selecting=false;
  if(!previewEnabled){previewEpoch++;previewPending=false;previewEngine?.abort();}
  syncJuliaPreview();
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
  const epoch=previewEpoch,selected={...selectedJulia};
  const current=()=>previewEnabled && view.family==='mandelbrot' && previewEpoch===epoch;
  try{
    // One persistent small renderer, with its own fields/history/uniforms.
    if(!previewEngine){previewEngine=new WebGpuRenderer(gpuContext,previewCanvas);await previewEngine.init();}
    if(!current())return;
    const req:RenderRequest={centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal(3.2).div(previewCanvas.height),width:previewCanvas.width,height:previewCanvas.height,maxIterations:Math.min(512,view.iterations),colors:{...colors,mode:0,supersample:1},family:'julia',juliaX:new Decimal(selected.x),juliaY:new Decimal(selected.y),useApprox:false,tileRows:8,isCurrent:current};
    const result=await previewEngine.render(req);
    if(current()&&result.completed){
      previewEngine.reproject(req);previewRenderedEpoch=epoch;
      el('julia-preview-status').textContent=`${req.maxIterations} iterations · M opens this Julia`;
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
    const next=validateView({...HOME,family:'julia',x:'0',jx:selectedJulia.x,jy:selectedJulia.y,iterations:view.iterations});
    juliaReturn=snapshot();load(next);
  }else message('Press J, then select a point for the Julia preview.');
  canvas.focus();
}
function request(scale:number):RenderRequest{
  const width=Math.max(8,Math.round(canvas.width*scale)),height=Math.max(8,Math.round(canvas.height*scale));const g=generation;
  return {centerX:camera.x,centerY:camera.y,unitsPerPixel:camera.span.div(height),width,height,maxIterations:view.iterations,colors:{...colors},family:view.family,juliaX:new Decimal(view.jx),juliaY:new Decimal(view.jy),interacting:moving(),isCurrent:()=>generation===g};
}
async function compute(){
  if(busy||!engine||error)return;busy=true;dirty=false;const revision=camera.revision,g=generation,q=quality;
  try{
    const result=await engine.render(request(q));
    if(g===generation && result.completed){stats=result;if(result.computed){fields++;lastFresh=performance.now();}else recolours++;
      lastRevision=revision;completedQuality=q;
      if(revision===camera.revision && !moving() && q<1){quality=1;dirty=true;}
    }
  }catch(e){if(!(e instanceof DOMException && e.name==='AbortError')){error=String(e);message(error);}}
  finally{busy=false;if(camera.revision!==revision||g!==generation)dirty=true;}
}
function resize(){const dpr=devicePixelRatio||1;const width=Math.round(innerWidth*dpr),height=Math.round(innerHeight*dpr);if(canvas.width===width&&canvas.height===height)return;canvas.width=width;canvas.height=height;quality=1;dirty=true;}
function tick(time:number){
  const dt=previousTime?time-previousTime:0;previousTime=time;
  if(dt>0){frameTimes.push(dt);if(frameTimes.length>300)frameTimes.shift();}frameCount++;
  if(!document.hidden){
    const zoom=direction||(keys.has('+')||keys.has('=')?1:keys.has('-')?-1:0);
    if(zoom && dt){camera.zoom(-zoom*speed*dt/1000,pointer.x,pointer.y,innerWidth,innerHeight);changed();}
    let dx=0,dy=0;if(keys.has('ArrowLeft'))dx+=dt*.3;if(keys.has('ArrowRight'))dx-=dt*.3;if(keys.has('ArrowUp'))dy+=dt*.3;if(keys.has('ArrowDown'))dy-=dt*.3;
    if(dx||dy){camera.pan(dx,dy,innerHeight);changed();}
    const nowMoving=moving();
    if(wasMoving && !nowMoving){quality=1;dirty=true;}
    wasMoving=nowMoving;
    if(engine){engine.reproject(request(1));if(dirty&&!busy)void compute();}
    if(!busy&&!dirty&&!previewBusy&&previewPending)void computeJuliaPreview();
    if(time-statusTime>250){statusTime=time;const mean=frameTimes.reduce((a,b)=>a+b,0)/Math.max(1,frameTimes.length);cadence.textContent=`Presentation ${Math.round(1000/mean)||0} Hz`;
      const fresh=!busy && !dirty && !moving() && lastRevision===camera.revision && completedQuality===1;
      freshness.textContent=error?'Rendering stopped':`${fresh?'Refined':busy?'Computing':'Preview'} · ${Math.round(completedQuality*100)}% spatial · ${lastFresh?((time-lastFresh)/1000).toFixed(1)+'s since field':'first field pending'}`;
      depth.textContent=`${new Decimal(2.8).div(camera.span).toExponential(2)}× · ${view.iterations.toLocaleString()} iterations`;
    }
  }
  requestAnimationFrame(tick);
}
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{if(e.button>2)return;canvas.focus();canvas.setPointerCapture(e.pointerId);pointer={x:e.clientX,y:e.clientY};
  if(previewEnabled && view.family==='mandelbrot' && e.button===0){e.preventDefault();stop();selecting=true;selectJuliaAtPointer();return;}
  checkpoint();dragging=e.shiftKey||e.button===1;direction=dragging?0:e.button===2?-1:1;changed();});
canvas.addEventListener('pointermove',e=>{if(selecting){pointer={x:e.clientX,y:e.clientY};selectJuliaAtPointer();return;}if(dragging){camera.pan(e.clientX-pointer.x,e.clientY-pointer.y,innerHeight);changed();}pointer={x:e.clientX,y:e.clientY};});
function endPointer(e:PointerEvent){if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);if(selecting){stop();return;}stop();changed();checkpoint();persist();}
canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',()=>{stop();changed();});
let wheelSave:ReturnType<typeof setTimeout>;
canvas.addEventListener('wheel',e=>{e.preventDefault();pointer={x:e.clientX,y:e.clientY};const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?innerHeight:1);camera.zoom(Math.max(-1,Math.min(1,delta*.002))*speed,pointer.x,pointer.y,innerWidth,innerHeight);changed();clearTimeout(wheelSave);wheelSave=setTimeout(()=>{checkpoint();persist();},250);},{passive:false});
canvas.addEventListener('keydown',e=>{if(e.key==='Escape'){stop();return;}if(['+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();keys.add(e.key);changed();}});
canvas.addEventListener('keyup',e=>{if(!keys.delete(e.key))return;changed();checkpoint();persist();});
document.addEventListener('keydown',e=>{
  if(e.repeat||e.ctrlKey||e.metaKey||e.altKey||(e.target instanceof HTMLElement && (e.target.isContentEditable||e.target.closest('input,textarea,select'))))return;
  const key=e.key.toLowerCase();if(key!=='j'&&key!=='m')return;e.preventDefault();
  try{if(key==='j')toggleJuliaPreview();else switchJuliaView();}catch(err){message(String(err));}
});
window.addEventListener('blur',stop);document.addEventListener('visibilitychange',()=>{stop();previousTime=0;});window.addEventListener('resize',resize);
el('toggle').onclick=()=>{const panel=el('controls');panel.hidden=!panel.hidden;el('toggle').setAttribute('aria-expanded',String(!panel.hidden));el('toggle').textContent=panel.hidden?'Show controls':'Hide controls';};
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
el<HTMLInputElement>('iterations').onchange=e=>{try{load({...snapshot(),iterations:Number((e.target as HTMLInputElement).value)});}catch(err){message(String(err));}};
el<HTMLSelectElement>('palette').onchange=e=>{colors.palette=Number((e.target as HTMLSelectElement).value);dirty=true;if(previewEnabled)queuePreview();};
el<HTMLInputElement>('cycle').oninput=e=>{colors.cycle=Number((e.target as HTMLInputElement).value);dirty=true;if(previewEnabled)queuePreview();};
el<HTMLFormElement>('coordinates').onsubmit=e=>{e.preventDefault();try{load({...snapshot(),x:el<HTMLInputElement>('cx').value,y:el<HTMLInputElement>('cy').value,span:el<HTMLInputElement>('span').value});}catch(err){message(String(err));}};
el<HTMLFormElement>('julia-form').onsubmit=e=>{e.preventDefault();try{load({...snapshot(),jx:el<HTMLInputElement>('jx').value,jy:el<HTMLInputElement>('jy').value});}catch(err){message(String(err));}};
function savedOptions(){const select=el<HTMLSelectElement>('saved');select.replaceChildren(new Option(saved.length?'Choose a saved location…':'No saved locations',''));saved.forEach((s,i)=>select.add(new Option(s.name,String(i))));}
el('save').onclick=()=>{saved.push({name:el<HTMLInputElement>('location-name').value.trim()||`${view.family} ${saved.length+1}`,view:snapshot()});try{localStorage.setItem('gpu-zoomer-locations',JSON.stringify(saved));savedOptions();message('Location saved on this browser.');}catch{message('Local storage is unavailable. Copy a share link instead.');}};
el<HTMLSelectElement>('saved').onchange=e=>{const v=(e.target as HTMLSelectElement).value;if(v!=='')load(saved[Number(v)].view);};
el('share').onclick=async()=>{persist();try{await navigator.clipboard.writeText(location.href);message('Exact view link copied.');}catch{message('Copy the address bar to share this exact view.');}};
export const ready=(async()=>{
  try{saved=JSON.parse(localStorage.getItem('gpu-zoomer-locations')||'[]').map((s:{name:string;view:unknown})=>({name:String(s.name),view:validateView(s.view)}));}catch{saved=[];}savedOptions();
  try{const restored=location.hash?decodeView(location.hash.slice(1)):JSON.parse(localStorage.getItem('gpu-zoomer-view')||'null');load(restored||HOME,false);}catch{load(HOME,false);message('The saved view could not be read; showing the whole set.');}
  checkpoint();resize();requestAnimationFrame(tick);
  try{const ctx=await acquireGpu();gpuContext=ctx;const renderer=new WebGpuRenderer(ctx,canvas);await renderer.init();engine=renderer;dirty=true;ctx.lost.then(info=>{if(info.reason!=='destroyed'){error='GPU connection lost. Reload this page to reconnect.';message(error);stop();setPreview(false);}});return ctx.capabilities;}
  catch(e){error=String(e);message(error);throw e;}
})();
// Development-only access exercises the displayed app and its real field.
export const testing = import.meta.env.DEV ? {
  load, snapshot, camera, get engine(){return engine;},
  juliaPreview:()=>({enabled:previewEnabled,busy:previewBusy,pending:previewPending,epoch:previewEpoch,renderedEpoch:previewRenderedEpoch,selected:selectedJulia?{...selectedJulia}:null,returnView:juliaReturn?{...juliaReturn}:null}),
  status:()=>({busy,dirty,error,fields,recolours,lastRevision,revision:camera.revision,quality:completedQuality,stats,frameCount,frameTimes:[...frameTimes],elapsed:performance.now()-sessionStart}),
  resetTiming(){frameTimes=[];frameCount=0;sessionStart=performance.now();},
} : undefined;
