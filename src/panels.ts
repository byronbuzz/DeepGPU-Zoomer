/** Device-local panel placement. Handles move whole panels, never form controls. */
export interface PanelController { reset():void }
export function setupPanels():PanelController{
  const panels=Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
  const defaultAccent='#9cdcd6';
  let saved:Record<string,{x:number;y:number;width?:number;height?:number}>={};let opacity=.8,accent=defaultAccent;
  try{const v=JSON.parse(localStorage.getItem('gpu-zoomer-layout')||'{}');saved=v.positions??{};opacity=Number.isFinite(v.opacity)?Math.max(.15,Math.min(1,v.opacity)):.8;accent=typeof v.accent==='string'&&/^#[0-9a-fA-F]{6}$/.test(v.accent)?v.accent:defaultAccent;}catch{}
  const persist=()=>{try{localStorage.setItem('gpu-zoomer-layout',JSON.stringify({positions:saved,opacity,accent}));}catch{}};
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
    window.addEventListener('pointermove',e=>{if(!start)return;const dx=e.clientX-start.x,dy=e.clientY-start.y;if(start.tab&&Math.hypot(dx,dy)<4)return;if(start.tab){suppressClick=true;if(!handle.hasPointerCapture(start.pointerId))handle.setPointerCapture(start.pointerId);}saved[p.id]={...saved[p.id],...clamp(p,start.px+dx,start.py+dy)};});
    const end=(e:PointerEvent)=>{if(!start)return;start=undefined;persist();if(e.type==='pointercancel')suppressClick=false;else setTimeout(()=>{suppressClick=false;},0);};window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
    handle.addEventListener('keydown',e=>{const d:Record<string,number[]>={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]};if(e.target!==handle||!d[e.key])return;e.preventDefault();const r=p.getBoundingClientRect();saved[p.id]={...saved[p.id],...clamp(p,r.x+d[e.key][0],r.y+d[e.key][1])};persist();});
    const size=saved[p.id];if(size?.width&&p.id==='controls'){p.style.width=size.width+'px';p.style.height=(size.height??p.offsetHeight)+'px';}
    new ResizeObserver(()=>{if(!p.hidden){const r=p.getBoundingClientRect();clamp(p,saved[p.id]?.x??r.x,saved[p.id]?.y??r.y);}}).observe(p);
  }
  const controls=document.getElementById('controls')!;
  const limit=(value:number,minimum:number,maximum:number)=>Math.max(minimum,Math.min(maximum,value));
  const resizeControls=(edge:string,r:DOMRect,delta:number)=>{
    const minWidth=Math.min(320,Math.max(1,innerWidth-16));
    const minHeight=Math.min(280,Math.max(1,innerHeight-76));
    let x=r.x,width=r.width,height=r.height;
    if(edge==='left'){
      x=limit(r.x+delta,8,r.right-minWidth);
      width=r.right-x;
    }else if(edge==='right'){
      width=limit(r.width+delta,minWidth,Math.max(minWidth,innerWidth-r.x-8));
    }else{
      height=limit(r.height+delta,minHeight,Math.max(minHeight,innerHeight-r.y-8));
    }
    controls.style.left=x+'px';controls.style.top=r.y+'px';controls.style.right='auto';controls.style.bottom='auto';
    controls.style.width=width+'px';controls.style.height=height+'px';
    saved[controls.id]={x,y:r.y,width,height};
  };
  controls.querySelectorAll<HTMLButtonElement>('[data-resize]').forEach(edgeHandle=>{
    const edge=edgeHandle.dataset.resize!;
    let start:{rect:DOMRect;pointerX:number;pointerY:number}|undefined;
    edgeHandle.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      event.preventDefault();event.stopPropagation();
      start={rect:controls.getBoundingClientRect(),pointerX:event.clientX,pointerY:event.clientY};
      edgeHandle.setPointerCapture(event.pointerId);
    });
    edgeHandle.addEventListener('pointermove',event=>{
      if(!start)return;
      resizeControls(edge,start.rect,edge==='bottom'?event.clientY-start.pointerY:event.clientX-start.pointerX);
    });
    const end=()=>{if(start){start=undefined;persist();}};
    edgeHandle.addEventListener('pointerup',end);edgeHandle.addEventListener('pointercancel',end);
    edgeHandle.addEventListener('keydown',event=>{
      const direction=edge==='bottom'?event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0:event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;
      if(!direction)return;
      event.preventDefault();resizeControls(edge,controls.getBoundingClientRect(),direction*10);persist();
    });
  });
  const restore=()=>panels.forEach(p=>{if(!p.hidden){const r=p.getBoundingClientRect();clamp(p,saved[p.id]?.x??r.x,saved[p.id]?.y??r.y);}});
  window.addEventListener('resize',restore);restore();
  const input=document.getElementById('panel-opacity') as HTMLInputElement;
  const setOpacity=()=>{document.documentElement.style.setProperty('--panel-opacity',String(opacity));input.value=String(opacity);};setOpacity();
  input.oninput=()=>{opacity=Number(input.value);setOpacity();persist();};
  const accentInput=document.getElementById('panel-accent') as HTMLInputElement;
  const setAccent=()=>{document.documentElement.style.setProperty('--accent',accent);accentInput.value=accent;};setAccent();
  accentInput.oninput=()=>{if(!/^#[0-9a-fA-F]{6}$/.test(accentInput.value))return;accent=accentInput.value;setAccent();persist();};
  const resetLayout=(save=true)=>{saved={};panels.forEach(p=>{p.style.left='';p.style.top='';p.style.right='';p.style.bottom='';if(p.id==='controls'){p.style.width='';p.style.height='';}});restore();if(save)persist();};
  const tabs=Array.from(document.querySelectorAll<HTMLButtonElement>('[role=tab]'));
  const selectTab=(tab:HTMLButtonElement,focus=false)=>{for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;const panel=document.getElementById(item.getAttribute('aria-controls')!);if(panel)panel.hidden=!selected;}if(focus)tab.focus();};
  tabs.forEach((tab,index)=>{tab.onclick=()=>selectTab(tab);tab.onkeydown=e=>{let next=index;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();selectTab(tabs[next],true);};});
  const toggle=document.getElementById('toggle')!;
  const syncToggle=(hidden:boolean)=>{const label=hidden?'Show controls':'Hide controls';toggle.setAttribute('aria-label',label);toggle.title=label;toggle.setAttribute('aria-expanded',String(!hidden));};
  toggle.onclick=()=>syncToggle(document.body.classList.toggle('controls-hidden'));
  return {reset(){
    opacity=.8;accent=defaultAccent;setOpacity();setAccent();resetLayout(false);document.body.classList.remove('controls-hidden');syncToggle(false);
    selectTab(tabs[0]);document.querySelectorAll<HTMLDetailsElement>('#controls details').forEach(details=>details.open=false);
  }};
}
