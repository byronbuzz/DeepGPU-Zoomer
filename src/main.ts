import './style.css';
import Decimal from 'decimal.js';
import { acquireGpu } from './gpu/device';
import { WebGpuRenderer, type RenderRequest, type RenderStats } from './render/webgpu-renderer';
import { DEFAULT_COLORS } from './logic/colorSettings';
import { Camera, HOME, validateView, encodeView, decodeView, type SavedView, type Family } from './state';
import { PLACES } from './places';

const el = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const canvas=el<HTMLCanvasElement>('fractal');
const camera=new Camera();
let view:SavedView={...HOME}, colors={...DEFAULT_COLORS}, engine:WebGpuRenderer;
let generation=0, busy=false, dirty=true, error='', lastInteraction=0, quality=.25, lastRevision=-1;
let fields=0, recolours=0, lastFresh=0, stats:RenderStats|undefined, completedQuality=0;
let pointer={x:innerWidth/2,y:innerHeight/2}, direction=0, dragging=false, speed=1, previousTime=0, statusTime=0, wasMoving=false;
let juliaReturn:SavedView|null=null;
const keys=new Set<string>(), timeline:SavedView[]=[];let timelineIndex=-1;
let saved: {name:string;view:SavedView}[]=[];
let frameTimes:number[]=[], frameCount=0, sessionStart=performance.now();
const cadence=el('cadence'),freshness=el('freshness'),depth=el('depth');
function message(text:string){el('message').textContent=text;}
function snapshot():SavedView{return {...view,x:camera.x.toString(),y:camera.y.toString(),span:camera.span.toString()};}
function checkpoint(){const s=snapshot();if(timelineIndex>=0 && encodeView(timeline[timelineIndex])===encodeView(s))return;timeline.splice(timelineIndex+1);timeline.push(s);timelineIndex=timeline.length-1;historyButtons();}
function historyButtons(){el<HTMLButtonElement>('back').disabled=timelineIndex<=0;el<HTMLButtonElement>('forward').disabled=timelineIndex>=timeline.length-1;}
function stop(){direction=0;dragging=false;keys.clear();}
function syncControls(){
  el<HTMLSelectElement>('family').value=view.family;el('set-label').textContent=view.family.toUpperCase();
  el<HTMLFormElement>('julia-form').hidden=view.family!=='julia';el<HTMLInputElement>('iterations').value=String(view.iterations);
  el<HTMLInputElement>('jx').value=view.jx;el<HTMLInputElement>('jy').value=view.jy;
  el<HTMLTextAreaElement>('cx').value=camera.x.toString();el<HTMLTextAreaElement>('cy').value=camera.y.toString();el<HTMLInputElement>('span').value=camera.span.toString();
  el<HTMLButtonElement>('return').disabled=!juliaReturn;
  el<HTMLButtonElement>('julia-from').disabled=view.family==='julia';
}
function load(next:SavedView,record=true){
  const valid=validateView(next);if(record && engine)checkpoint();stop();view=valid;camera.load(valid);generation++;
  engine?.invalidateHistory();quality=.25;completedQuality=0;dirty=true;lastRevision=-1;lastInteraction=0;error='';message('');syncControls();
  if(record){checkpoint();persist();}
}
function persist(){
  const s=snapshot();try{localStorage.setItem('gpu-zoomer-view',JSON.stringify(s));history.replaceState(null,'','#'+encodeView(s));}catch{message('This browser could not save the view locally. Copy a share link to keep it.');}
  syncControls();
}
function moving(){return direction!==0||dragging||keys.size>0||performance.now()-lastInteraction<180;}
function changed(){dirty=true;quality=.25;lastInteraction=performance.now();}
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
      if(revision===camera.revision && !moving() && q<1){quality=q<.5?.5:1;dirty=true;}
    }
  }catch(e){if(!(e instanceof DOMException && e.name==='AbortError')){error=String(e);message(error);}}
  finally{busy=false;if(camera.revision!==revision||g!==generation)dirty=true;}
}
function resize(){const dpr=devicePixelRatio||1;canvas.width=Math.round(innerWidth*dpr);canvas.height=Math.round(innerHeight*dpr);quality=.25;dirty=true;}
function tick(time:number){
  const dt=previousTime?time-previousTime:0;previousTime=time;
  if(dt>0){frameTimes.push(dt);if(frameTimes.length>300)frameTimes.shift();}frameCount++;
  if(!document.hidden){
    const zoom=direction||(keys.has('+')||keys.has('=')?1:keys.has('-')?-1:0);
    if(zoom && dt){camera.zoom(-zoom*speed*dt/1000,pointer.x,pointer.y,innerWidth,innerHeight);changed();}
    let dx=0,dy=0;if(keys.has('ArrowLeft'))dx+=dt*.3;if(keys.has('ArrowRight'))dx-=dt*.3;if(keys.has('ArrowUp'))dy+=dt*.3;if(keys.has('ArrowDown'))dy-=dt*.3;
    if(dx||dy){camera.pan(dx,dy,innerHeight);changed();}
    const nowMoving=moving();
    if(wasMoving && !nowMoving && completedQuality<1){quality=completedQuality<.5?.5:1;dirty=true;}
    wasMoving=nowMoving;
    if(engine){engine.reproject(request(1));if(dirty&&!busy)void compute();}
    if(time-statusTime>250){statusTime=time;const mean=frameTimes.reduce((a,b)=>a+b,0)/Math.max(1,frameTimes.length);cadence.textContent=`Presentation ${Math.round(1000/mean)||0} Hz`;
      const fresh=lastRevision===camera.revision && completedQuality===1;
      freshness.textContent=error?'Rendering stopped':`${fresh?'Refined':busy?'Computing':'Preview'} · ${Math.round(completedQuality*100)}% spatial · ${lastFresh?((time-lastFresh)/1000).toFixed(1)+'s since field':'first field pending'}`;
      depth.textContent=`${new Decimal(2.8).div(camera.span).toExponential(2)}× · ${view.iterations.toLocaleString()} iterations`;
    }
  }
  requestAnimationFrame(tick);
}
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{if(e.button>2)return;canvas.focus();canvas.setPointerCapture(e.pointerId);pointer={x:e.clientX,y:e.clientY};checkpoint();dragging=e.shiftKey||e.button===1;direction=dragging?0:e.button===2?-1:1;changed();});
canvas.addEventListener('pointermove',e=>{if(dragging){camera.pan(e.clientX-pointer.x,e.clientY-pointer.y,innerHeight);changed();}pointer={x:e.clientX,y:e.clientY};});
function endPointer(e:PointerEvent){if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);stop();changed();checkpoint();persist();}
canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',()=>{stop();changed();});
let wheelSave:ReturnType<typeof setTimeout>;
canvas.addEventListener('wheel',e=>{e.preventDefault();pointer={x:e.clientX,y:e.clientY};const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?innerHeight:1);camera.zoom(Math.max(-1,Math.min(1,delta*.002))*speed,pointer.x,pointer.y,innerWidth,innerHeight);changed();clearTimeout(wheelSave);wheelSave=setTimeout(()=>{checkpoint();persist();},250);},{passive:false});
canvas.addEventListener('keydown',e=>{if(e.key==='Escape'){stop();return;}if(e.key.toLowerCase()==='j'){toJulia();return;}if(['+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();keys.add(e.key);changed();}});
canvas.addEventListener('keyup',e=>{keys.delete(e.key);changed();checkpoint();persist();});
window.addEventListener('blur',stop);document.addEventListener('visibilitychange',()=>{stop();previousTime=0;});window.addEventListener('resize',resize);
el('toggle').onclick=()=>{const panel=el('controls');panel.hidden=!panel.hidden;el('toggle').setAttribute('aria-expanded',String(!panel.hidden));el('toggle').textContent=panel.hidden?'Show controls':'Hide controls';};
el<HTMLSelectElement>('family').onchange=e=>{const family=(e.target as HTMLSelectElement).value as Family;load({...HOME,family,x:family==='julia'?'0':HOME.x,jx:view.jx,jy:view.jy,iterations:view.iterations});};
function toJulia(){if(view.family!=='mandelbrot')return;const p=camera.point(pointer.x,pointer.y,innerWidth,innerHeight);juliaReturn=snapshot();load({...HOME,family:'julia',x:'0',jx:p.x.toString(),jy:p.y.toString(),iterations:view.iterations});}
el('julia-from').onclick=toJulia;el('return').onclick=()=>{if(juliaReturn){const v=juliaReturn;juliaReturn=null;load(v);}};
el('reset').onclick=()=>load({...HOME,family:view.family,x:view.family==='julia'?'0':HOME.x,jx:view.jx,jy:view.jy});
el('back').onclick=()=>{if(timelineIndex>0){load(timeline[--timelineIndex],false);historyButtons();persist();}};
el('forward').onclick=()=>{if(timelineIndex<timeline.length-1){load(timeline[++timelineIndex],false);historyButtons();persist();}};
PLACES.forEach((p,i)=>el<HTMLSelectElement>('places').add(new Option(p.name,String(i))));el<HTMLSelectElement>('places').onchange=e=>{const v=(e.target as HTMLSelectElement).value;if(v!=='')load(PLACES[Number(v)]);};
el<HTMLInputElement>('speed').oninput=e=>{speed=Number((e.target as HTMLInputElement).value);el('speed-value').textContent=speed.toFixed(1)+'×';};
el<HTMLInputElement>('iterations').onchange=e=>{try{load({...snapshot(),iterations:Number((e.target as HTMLInputElement).value)});}catch(err){message(String(err));}};
el<HTMLSelectElement>('palette').onchange=e=>{colors.palette=Number((e.target as HTMLSelectElement).value);dirty=true;};
el<HTMLInputElement>('cycle').oninput=e=>{colors.cycle=Number((e.target as HTMLInputElement).value);dirty=true;};
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
  try{const ctx=await acquireGpu();const renderer=new WebGpuRenderer(ctx,canvas);await renderer.init();engine=renderer;dirty=true;ctx.lost.then(info=>{if(info.reason!=='destroyed'){error='GPU connection lost. Reload this page to reconnect.';message(error);stop();}});return ctx.capabilities;}
  catch(e){error=String(e);message(error);throw e;}
})();
// Development-only access exercises the displayed app and its real field.
export const testing = import.meta.env.DEV ? {
  load, snapshot, camera, get engine(){return engine;},
  status:()=>({busy,dirty,error,fields,recolours,lastRevision,revision:camera.revision,quality:completedQuality,stats,frameCount,frameTimes:[...frameTimes],elapsed:performance.now()-sessionStart}),
  resetTiming(){frameTimes=[];frameCount=0;sessionStart=performance.now();},
} : undefined;
