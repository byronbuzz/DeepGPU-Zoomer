import type { GpuContext } from '../gpu/device';
import type { RenderRequest } from '../render/webgpu-renderer';
import { DisplayDimensions } from './display';
import { checkedExportDimensions } from './layout';
import { canReuseExportPixels, encodeCapturedExport, renderPng, snapshotExportRequest, type CapturedExport } from './render';

/** Modeless panel: opening and saving do not own the live camera or render loop. */
export function setupPngExportPanel(options:{context:()=>GpuContext|undefined;request:()=>RenderRequest;viewport:()=>{width:number;height:number};captureQuality?:(snapshot:RenderRequest,width:number,height:number)=>Promise<CapturedExport>|null}){
  const get=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const panel=get<HTMLElement>('png-export'),open=get<HTMLButtonElement>('screenshot');
  const close=get<HTMLButtonElement>('png-export-close'),save=get<HTMLButtonElement>('png-save');
  const slider=get<HTMLInputElement>('png-resolution'),width=get<HTMLInputElement>('png-width'),height=get<HTMLInputElement>('png-height');
  const label=get<HTMLOutputElement>('png-resolution-label'),dimensions=get<HTMLElement>('png-dimensions'),status=get<HTMLElement>('png-status');
  const names=['Current viewport','Current display','2× display','3× display','4× display'];
  let custom=false,configured=false,saving=false,presetAvailable=true,qualityInitialized=false;
  let exportController:AbortController|undefined;
  const cancel=()=>{exportController?.abort(new DOMException('Export cancelled.','AbortError'));if(saving){status.textContent='Cancelling export…';describe();}};
  const display=new DisplayDimensions(()=>{if(!custom&&Number(slider.value)>0)refreshPreset();});
  const readChoice=()=>checkedExportDimensions(Number(width.value),Number(height.value));
  const describe=()=>{
    const index=Number(slider.value);
    label.value=custom?'Custom':names[index];
    slider.setAttribute('aria-valuetext',names[index]);
    let valid=false;
    if(!custom&&!presetAvailable)dimensions.textContent=`${names[index]} unavailable: ${display.reason}. Enter custom dimensions below.`;
    else try{const size=readChoice();dimensions.textContent=`${size.width.toLocaleString()} × ${size.height.toLocaleString()} pixels`;valid=true;}
    catch(reason){dimensions.textContent=reason instanceof Error?reason.message:String(reason);}
    save.textContent=saving?(exportController?.signal.aborted?'Cancelling…':'Cancel export'):'Save PNG';
    save.disabled=saving?!!exportController?.signal.aborted:!valid;
  };
  function refreshPreset(){
    if(custom||saving)return;
    const index=Number(slider.value),size=index===0?options.viewport():display.pixels();
    presetAvailable=!!size;
    if(size){const scale=index===0?1:index;width.value=String(size.width*scale);height.value=String(size.height*scale);}
    configured=true;describe();
  }
  open.onclick=()=>{
    panel.hidden=false;open.setAttribute('aria-expanded','true');
    if(!qualityInitialized&&options.request().colors.oversampling&&!saving){
      qualityInitialized=true;
      if(!custom){
        const size=options.viewport();custom=true;presetAvailable=true;configured=true;
        width.value=String(size.width*2);height.value=String(size.height*2);
      }
    }
    if(!configured||!custom)refreshPreset();else describe();
    close.focus();
  };
  const hide=()=>{cancel();panel.hidden=true;open.setAttribute('aria-expanded','false');open.focus();};
  close.onclick=hide;
  panel.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();hide();}
  });
  slider.oninput=()=>{
    custom=false;status.textContent='';refreshPreset();
    if(Number(slider.value)>0)void display.choose();
  };
  for(const input of [width,height])input.oninput=()=>{custom=true;presetAvailable=true;status.textContent='';describe();};
  window.addEventListener('resize',()=>{queueMicrotask(()=>{if(!panel.hidden&&!custom)refreshPreset();});});
  save.onclick=async()=>{
    if(saving){cancel();return;}
    let ctx:GpuContext|undefined;
    try{
      if(!custom&&!presetAvailable)throw Error('Choose Custom dimensions or allow display detection.');
      const choice=readChoice();ctx=options.context();if(!ctx)throw Error('The GPU is not ready to export.');
      const snapshot=snapshotExportRequest(options.request());
      exportController=new AbortController();const signal=exportController.signal;
      saving=true;describe();slider.disabled=width.disabled=height.disabled=true;
      // Capture submits a detached readback before yielding, so later navigation
      // cannot replace the selected high-resolution image underneath this save.
      const captured=snapshot.colors.oversampling&&canReuseExportPixels(choice)?options.captureQuality?.(snapshot,choice.width,choice.height):null;
      let blob:Blob;
      if(captured){status.textContent='Saving completed quality image…';blob=await encodeCapturedExport(await captured,signal);}
      else blob=await renderPng(ctx,snapshot,choice,signal,text=>{if(!signal.aborted)status.textContent=text;});
      signal.throwIfAborted();
      const url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download=`webgpu-zoomer-${choice.width}x${choice.height}.png`;
      link.hidden=true;document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),60_000);
      status.textContent=`Saved ${choice.width.toLocaleString()} × ${choice.height.toLocaleString()} PNG.`;
    }catch(reason){status.textContent=reason instanceof Error?reason.message:String(reason);}
    finally{saving=false;exportController=undefined;slider.disabled=width.disabled=height.disabled=false;describe();}
  };
  return {reset(){cancel();custom=false;slider.value='0';configured=false;qualityInitialized=false;if(!saving)status.textContent='';panel.hidden=true;open.setAttribute('aria-expanded','false');}};
}
