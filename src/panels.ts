/** Device-local panel placement. Handles move whole panels, never form controls. */
export const FACTORY_ACCENT='#eba046';
const PANEL_IDS=['title-badge','controls','png-export','julia-preview'];
const TAB_IDS=['tab-main','tab-colouring','tab-advanced'];
const DETAILS_IDS=['edit-palette','lighting'];
const RESIZABLE_IDS=['controls','julia-preview'];
const panelDimension=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(32768,Math.max(1,value)):undefined;
export interface PanelSettings {
  positions:Record<string,{x:number;y:number;width?:number;height?:number}>;
  opacity:number;accent:string;activeTab:string;details:Record<string,boolean>;controlsHidden:boolean;
}
export function normalizePanelSettings(value:unknown):PanelSettings{
  const input=value&&typeof value==='object'?value as Partial<PanelSettings>:{};
  const positions:PanelSettings['positions']={};
  for(const id of PANEL_IDS){const p=input.positions?.[id];if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y))continue;
    positions[id]={x:p.x,y:p.y};
    if(RESIZABLE_IDS.includes(id)){const width=panelDimension(p.width),height=panelDimension(p.height);if(width!==undefined)positions[id].width=width;if(height!==undefined)positions[id].height=height;}}
  return {positions,opacity:typeof input.opacity==='number'&&Number.isFinite(input.opacity)?Math.max(.15,Math.min(1,input.opacity)):.8,
    accent:typeof input.accent==='string'&&/^#[0-9a-fA-F]{6}$/.test(input.accent)?input.accent:FACTORY_ACCENT,
    activeTab:TAB_IDS.includes(input.activeTab??'')?input.activeTab!:'tab-main',
    details:Object.fromEntries(DETAILS_IDS.map(id=>[id,input.details?.[id]===true])),controlsHidden:input.controlsHidden===true};
}
export interface PanelController { reset():void;snapshot():PanelSettings }
export function setupPanels(initial?:PanelSettings):PanelController{
  const panels=Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
  const defaultAccent=FACTORY_ACCENT;
  let restored=normalizePanelSettings(initial);
  if(initial===undefined)try{restored=normalizePanelSettings(JSON.parse(localStorage.getItem('gpu-zoomer-layout')||'{}'));}catch{}
  let saved=restored.positions,opacity=restored.opacity,accent=restored.accent;
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
    const size=saved[p.id];if(size&&RESIZABLE_IDS.includes(p.id)){if(size.width)p.style.width=size.width+'px';if(size.height)p.style.height=size.height+'px';}
    new ResizeObserver(()=>{if(!p.hidden){const r=p.getBoundingClientRect();if(!r.width||!r.height)return;const position=clamp(p,saved[p.id]?.x??r.x,saved[p.id]?.y??r.y);
      if(RESIZABLE_IDS.includes(p.id))saved[p.id]={...position,width:r.width,height:r.height};}}).observe(p);
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
  const resetLayout=(save=true)=>{saved={};panels.forEach(p=>{p.style.left='';p.style.top='';p.style.right='';p.style.bottom='';if(RESIZABLE_IDS.includes(p.id)){p.style.width='';p.style.height='';}});restore();if(save)persist();};
  const tabs=Array.from(document.querySelectorAll<HTMLButtonElement>('[role=tab]'));
  const selectTab=(tab:HTMLButtonElement,focus=false)=>{for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;const panel=document.getElementById(item.getAttribute('aria-controls')!);if(panel)panel.hidden=!selected;}if(focus)tab.focus();};
  tabs.forEach((tab,index)=>{tab.onclick=()=>selectTab(tab);tab.onkeydown=e=>{let next=index;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();selectTab(tabs[next],true);};});
  const toggle=document.getElementById('toggle')!;
  const syncToggle=(hidden:boolean)=>{const label=hidden?'Show controls':'Hide controls';toggle.setAttribute('aria-label',label);toggle.title=label;toggle.setAttribute('aria-expanded',String(!hidden));};
  toggle.onclick=()=>syncToggle(document.body.classList.toggle('controls-hidden'));
  selectTab(tabs.find(tab=>tab.id===restored.activeTab)??tabs[0]);
  document.querySelectorAll<HTMLDetailsElement>('#controls details').forEach(details=>details.open=restored.details[details.id]===true);
  document.body.classList.toggle('controls-hidden',restored.controlsHidden);syncToggle(restored.controlsHidden);
  return {snapshot(){
    const positions={...saved};
    for(const p of panels){const r=p.getBoundingClientRect();
      if(!p.hidden&&r.width&&r.height){positions[p.id]={x:r.x,y:r.y,...(RESIZABLE_IDS.includes(p.id)?{width:r.width,height:r.height}:{})};continue;}
      // Native CSS resizing sets inline dimensions. Preserve them even if the
      // panel was hidden before its final ResizeObserver delivery.
      if(RESIZABLE_IDS.includes(p.id)){
        const width=panelDimension(Number.parseFloat(p.style.width)),height=panelDimension(Number.parseFloat(p.style.height));
        if(width!==undefined||height!==undefined)positions[p.id]={...(positions[p.id]??{x:Number.parseFloat(p.style.left)||8,y:Number.parseFloat(p.style.top)||78}),
          ...(width!==undefined?{width}:{}),...(height!==undefined?{height}:{})};
      }
    }
    return normalizePanelSettings({positions,opacity,accent,activeTab:tabs.find(tab=>tab.getAttribute('aria-selected')==='true')?.id,
      details:Object.fromEntries(Array.from(document.querySelectorAll<HTMLDetailsElement>('#controls details')).map(details=>[details.id,details.open])),
      controlsHidden:document.body.classList.contains('controls-hidden')});
  },reset(){
    opacity=.8;accent=defaultAccent;setOpacity();setAccent();resetLayout(false);document.body.classList.remove('controls-hidden');syncToggle(false);
    selectTab(tabs[0]);document.querySelectorAll<HTMLDetailsElement>('#controls details').forEach(details=>details.open=false);
  }};
}
