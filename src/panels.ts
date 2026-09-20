/** Device-local panel placement. Handles move whole panels, never form controls. */
export interface PanelController { reset():void }
export function setupPanels():PanelController{
  const panels=Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
  let saved:Record<string,{x:number;y:number;width?:number;height?:number}>={};let opacity=.8;
  try{const v=JSON.parse(localStorage.getItem('gpu-zoomer-layout')||'{}');saved=v.positions??{};opacity=Number.isFinite(v.opacity)?Math.max(.15,Math.min(1,v.opacity)):.8;}catch{}
  const persist=()=>{try{localStorage.setItem('gpu-zoomer-layout',JSON.stringify({positions:saved,opacity}));}catch{}};
  const clamp=(p:HTMLElement,x:number,y:number)=>{
    const r=p.getBoundingClientRect();
    const pos={x:Math.max(8,Math.min(innerWidth-r.width-8,x)),y:Math.max(8,Math.min(innerHeight-r.height-8,y))};
    p.style.left=pos.x+'px';p.style.top=pos.y+'px';p.style.right='auto';p.style.bottom='auto';return pos;
  };
  for(const p of panels){
    p.addEventListener('pointerdown',e=>e.stopPropagation());
    const handle=p.querySelector<HTMLElement>('[data-handle]')??p;
    handle.tabIndex=0;handle.setAttribute('aria-label',`Move ${p.getAttribute('aria-label')??'title badge'} (arrow keys)`);
    let start:{x:number;y:number;px:number;py:number;tab:boolean;pointerId:number}|undefined,suppressClick=false;
    handle.addEventListener('click',e=>{if(!suppressClick)return;suppressClick=false;e.preventDefault();e.stopPropagation();},true);
    handle.addEventListener('pointerdown',e=>{const target=e.target as HTMLElement,tab=!!target.closest('[role=tab]');if(e.button!==0||(!tab&&target.closest('button,input,select')))return;
      const r=p.getBoundingClientRect();start={x:e.clientX,y:e.clientY,px:r.x,py:r.y,tab,pointerId:e.pointerId};if(!tab){handle.setPointerCapture(e.pointerId);e.preventDefault();}});
    window.addEventListener('pointermove',e=>{if(!start)return;const dx=e.clientX-start.x,dy=e.clientY-start.y;if(start.tab&&Math.hypot(dx,dy)<4)return;if(start.tab){suppressClick=true;if(!handle.hasPointerCapture(start.pointerId))handle.setPointerCapture(start.pointerId);}saved[p.id]=clamp(p,start.px+dx,start.py+dy);});
    const end=(e:PointerEvent)=>{if(!start)return;start=undefined;persist();if(e.type==='pointercancel')suppressClick=false;else setTimeout(()=>{suppressClick=false;},0);};window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
    handle.addEventListener('keydown',e=>{const d:Record<string,number[]>={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]};if(e.target!==handle||!d[e.key])return;e.preventDefault();const r=p.getBoundingClientRect();saved[p.id]=clamp(p,r.x+d[e.key][0],r.y+d[e.key][1]);persist();});
    const size=saved[p.id];if(size?.width&&p.id==='controls'){p.style.width=size.width+'px';p.style.height=(size.height??p.offsetHeight)+'px';}
    let resizeReady=false;
    new ResizeObserver(()=>{if(!p.hidden){const r=p.getBoundingClientRect();const pos=clamp(p,saved[p.id]?.x??r.x,saved[p.id]?.y??r.y);if(resizeReady&&p.id==='controls'){saved[p.id]={...pos,width:r.width,height:r.height};persist();}resizeReady=true;}}).observe(p);
  }
  const restore=()=>panels.forEach(p=>{if(!p.hidden){const r=p.getBoundingClientRect();clamp(p,saved[p.id]?.x??r.x,saved[p.id]?.y??r.y);}});
  window.addEventListener('resize',restore);restore();
  const input=document.getElementById('panel-opacity') as HTMLInputElement;
  const setOpacity=()=>{document.documentElement.style.setProperty('--panel-opacity',String(opacity));input.value=String(opacity);};setOpacity();
  input.oninput=()=>{opacity=Number(input.value);setOpacity();persist();};
  const resetLayout=(save=true)=>{saved={};panels.forEach(p=>{p.style.left='';p.style.top='';p.style.right='';p.style.bottom='';if(p.id==='controls'){p.style.width='';p.style.height='';}});restore();if(save)persist();};
  document.getElementById('reset-layout')!.onclick=()=>resetLayout();
  const tabs=Array.from(document.querySelectorAll<HTMLButtonElement>('[role=tab]'));
  const selectTab=(tab:HTMLButtonElement,focus=false)=>{for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;const panel=document.getElementById(item.getAttribute('aria-controls')!);if(panel)panel.hidden=!selected;}if(focus)tab.focus();};
  tabs.forEach((tab,index)=>{tab.onclick=()=>selectTab(tab);tab.onkeydown=e=>{let next=index;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();selectTab(tabs[next],true);};});
  const toggle=document.getElementById('toggle')!;
  toggle.onclick=()=>{const hidden=document.body.classList.toggle('controls-hidden');toggle.textContent=hidden?'Show controls':'Hide controls';toggle.setAttribute('aria-expanded',String(!hidden));};
  return {reset(){
    opacity=.8;setOpacity();resetLayout(false);document.body.classList.remove('controls-hidden');toggle.textContent='Hide controls';toggle.setAttribute('aria-expanded','true');
    selectTab(tabs[0]);document.querySelectorAll<HTMLDetailsElement>('#controls details').forEach(details=>details.open=false);
  }};
}
