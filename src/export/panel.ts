import type { GpuContext } from '../gpu/device';
import type { RenderRequest } from '../render/webgpu-renderer';
import { DisplayDimensions } from './display';
import { checkedExportDimensions } from './layout';
import { renderPng, snapshotExportRequest } from './render';

/** Modeless panel: opening and saving do not own the live camera or render loop. */
export function setupPngExportPanel(options:{context:()=>GpuContext|undefined;request:()=>RenderRequest;viewport:()=>{width:number;height:number}}){
  const get=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const panel=get<HTMLElement>('png-export'),open=get<HTMLButtonElement>('screenshot');
  const close=get<HTMLButtonElement>('png-export-close'),save=get<HTMLButtonElement>('png-save');
  const slider=get<HTMLInputElement>('png-resolution'),width=get<HTMLInputElement>('png-width'),height=get<HTMLInputElement>('png-height');
  const label=get<HTMLOutputElement>('png-resolution-label'),dimensions=get<HTMLElement>('png-dimensions'),status=get<HTMLElement>('png-status');
  const names=['Current viewport','Current display','2× display','3× display','4× display'];
  let custom=false,configured=false,saving=false,presetAvailable=true;
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
    save.disabled=saving||!valid;
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
    if(!configured||!custom)refreshPreset();else describe();
    close.focus();
  };
  const hide=()=>{panel.hidden=true;open.setAttribute('aria-expanded','false');open.focus();};
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
    if(saving)return;
    let ctx:GpuContext|undefined;
    try{
      if(!custom&&!presetAvailable)throw Error('Choose Custom dimensions or allow display detection.');
      const choice=readChoice();ctx=options.context();if(!ctx)throw Error('The GPU is not ready to export.');
      const snapshot=snapshotExportRequest(options.request());
      saving=true;describe();slider.disabled=width.disabled=height.disabled=true;
      const blob=await renderPng(ctx,snapshot,choice,new AbortController().signal,text=>{status.textContent=text;});
      const url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download=`webgpu-zoomer-${choice.width}x${choice.height}.png`;
      link.hidden=true;document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),60_000);
      status.textContent=`Saved ${choice.width.toLocaleString()} × ${choice.height.toLocaleString()} PNG.`;
    }catch(reason){status.textContent=reason instanceof Error?reason.message:String(reason);}
    finally{saving=false;slider.disabled=width.disabled=height.disabled=false;describe();}
  };
  return {reset(){custom=false;slider.value='0';configured=false;if(!saving)status.textContent='';panel.hidden=true;open.setAttribute('aria-expanded','false');}};
}
