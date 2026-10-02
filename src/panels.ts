import {setupColourPicker} from './colour-picker';

/** Device-local panel placement. Backgrounds move panels, never form controls. */
export const FACTORY_ACCENT='#eba046';
const PANEL_IDS=['title-badge','controls','png-export','julia-preview'];
const TAB_IDS=['tab-main','tab-colouring','tab-advanced'];
const DETAILS_IDS=['edit-palette','lighting'];
const RESIZABLE_IDS=['controls','julia-preview'];
const panelDimension=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(32768,Math.max(1,value)):undefined;
export interface PanelSettings {
  positions:Record<string,{x:number;y:number;width?:number;height?:number}>;
  opacity:number;accent:string;activeTab:string;details:Record<string,boolean>;controlsHidden:boolean;hideStatusWithMenu:boolean;
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
    details:Object.fromEntries(DETAILS_IDS.map(id=>[id,input.details?.[id]===true])),controlsHidden:input.controlsHidden===true,hideStatusWithMenu:input.hideStatusWithMenu===true};
}
export interface PanelController { reset():void;snapshot():PanelSettings }
export function setupPanels(initial?:PanelSettings):PanelController{
  const panels=Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
  const defaultAccent=FACTORY_ACCENT;
  let restored=normalizePanelSettings(initial);
  if(initial===undefined)try{restored=normalizePanelSettings(JSON.parse(localStorage.getItem('gpu-zoomer-layout')||'{}'));}catch{}
  let saved=restored.positions,opacity=restored.opacity,accent=restored.accent,hideStatusWithMenu=restored.hideStatusWithMenu;
  const persist=()=>{try{localStorage.setItem('gpu-zoomer-layout',JSON.stringify({positions:saved,opacity,accent,hideStatusWithMenu}));}catch{}};
  const clamp=(p:HTMLElement,x:number,y:number)=>{
    const r=p.getBoundingClientRect();
    const pos={x:Math.max(8,Math.min(innerWidth-r.width-8,x)),y:Math.max(8,Math.min(innerHeight-r.height-8,y))};
    p.style.left=pos.x+'px';p.style.top=pos.y+'px';p.style.right='auto';p.style.bottom='auto';return pos;
  };
  for(const p of panels){
    p.addEventListener('pointerdown',e=>e.stopPropagation());
    const handle=p.querySelector<HTMLElement>('[data-handle]')??p;
    handle.tabIndex=0;handle.setAttribute('aria-label',`Move ${p.getAttribute('aria-label')??'title badge'} (arrow keys)`);
    let start:{x:number;y:number;px:number;py:number;pointerId:number}|undefined;
    p.addEventListener('pointerdown',e=>{
      const target=e.target as HTMLElement;
      if(e.button!==0||start||target.closest('[data-panel]')!==p||target.closest('button,input,select,textarea,summary,a,label,[contenteditable]:not([contenteditable=false]),[role=button],[role=slider],[role=option],[role=listbox],#palette-strip,.colour-popover,[data-resize]'))return;
      const targetRect=target.getBoundingClientRect();
      // Leave native scrollbar tracks and the Julia panel's resize grip alone.
      if((target.scrollHeight>target.clientHeight&&target.offsetWidth>target.clientWidth&&e.clientX>=targetRect.left+target.clientLeft+target.clientWidth)||
        (target.scrollWidth>target.clientWidth&&target.offsetHeight>target.clientHeight&&e.clientY>=targetRect.top+target.clientTop+target.clientHeight))return;
      const r=p.getBoundingClientRect();
      if(getComputedStyle(p).resize!=='none'&&e.clientX>=r.right-18&&e.clientY>=r.bottom-18)return;
      start={x:e.clientX,y:e.clientY,px:r.x,py:r.y,pointerId:e.pointerId};
      p.setPointerCapture(e.pointerId);e.preventDefault();
    });
    window.addEventListener('pointermove',e=>{if(!start||e.pointerId!==start.pointerId)return;saved[p.id]={...saved[p.id],...clamp(p,start.px+e.clientX-start.x,start.py+e.clientY-start.y)};});
    const end=(e:PointerEvent)=>{
      if(!start||e.pointerId!==start.pointerId)return;
      const pointerId=start.pointerId;start=undefined;
      if(p.hasPointerCapture(pointerId))p.releasePointerCapture(pointerId);
      persist();
    };
    window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);p.addEventListener('lostpointercapture',end);
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
    let start:{rect:DOMRect;pointerX:number;pointerY:number;pointerId:number}|undefined;
    edgeHandle.addEventListener('pointerdown',event=>{
      if(event.button!==0||start)return;
      event.preventDefault();event.stopPropagation();
      start={rect:controls.getBoundingClientRect(),pointerX:event.clientX,pointerY:event.clientY,pointerId:event.pointerId};
      edgeHandle.setPointerCapture(event.pointerId);
    });
    edgeHandle.addEventListener('pointermove',event=>{
      if(!start||event.pointerId!==start.pointerId)return;
      resizeControls(edge,start.rect,edge==='bottom'?event.clientY-start.pointerY:event.clientX-start.pointerX);
    });
    const end=(event:PointerEvent)=>{if(start&&event.pointerId===start.pointerId){const pointerId=start.pointerId;start=undefined;if(edgeHandle.hasPointerCapture(pointerId))edgeHandle.releasePointerCapture(pointerId);persist();}};
    edgeHandle.addEventListener('pointerup',end);edgeHandle.addEventListener('pointercancel',end);edgeHandle.addEventListener('lostpointercapture',end);
    edgeHandle.addEventListener('keydown',event=>{
      const direction=edge==='bottom'?event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0:event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;
      if(!direction)return;
      event.preventDefault();resizeControls(edge,controls.getBoundingClientRect(),direction*10);persist();
    });
  });
  const restore=()=>panels.forEach(p=>{if(!p.hidden){const r=p.getBoundingClientRect();if(r.width&&r.height)clamp(p,saved[p.id]?.x??r.x,saved[p.id]?.y??r.y);}});
  window.addEventListener('resize',restore);restore();
  const input=document.getElementById('panel-opacity') as HTMLInputElement;
  const setOpacity=()=>{document.documentElement.style.setProperty('--panel-opacity',String(opacity));input.value=String(opacity);};setOpacity();
  input.oninput=()=>{opacity=Number(input.value);setOpacity();persist();};
  const accentInput=document.getElementById('panel-accent') as HTMLInputElement;
  const accentButton=document.getElementById('panel-accent-toggle') as HTMLButtonElement;
  const accentPopover=document.getElementById('panel-accent-popover')!;
  let accentPicker:ReturnType<typeof setupColourPicker>|undefined;
  const setAccent=()=>{document.documentElement.style.setProperty('--accent',accent);accentInput.value=accent;accentButton.style.background=accent;accentPicker?.sync(accent);};
  accentPicker=setupColourPicker(document.getElementById('panel-accent-picker')!,accentInput,value=>{accent=value;setAccent();persist();});setAccent();
  const closeAccent=(focus=false)=>{accentPopover.hidden=true;accentButton.setAttribute('aria-expanded','false');if(focus)accentButton.focus();};
  accentButton.onclick=()=>{
    if(!accentPopover.hidden){closeAccent();return;}
    accentPopover.hidden=false;accentButton.setAttribute('aria-expanded','true');accentPicker?.sync(accent);
    const anchor=accentButton.getBoundingClientRect(),r=accentPopover.getBoundingClientRect();
    accentPopover.style.left=Math.max(8,Math.min(innerWidth-r.width-8,anchor.left))+'px';
    accentPopover.style.top=Math.max(8,Math.min(innerHeight-r.height-8,anchor.bottom+6))+'px';
    accentInput.focus();accentInput.select();
  };
  accentPopover.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeAccent(true);}});
  document.addEventListener('pointerdown',e=>{if(!accentPopover.hidden&&!accentPopover.contains(e.target as Node)&&!accentButton.contains(e.target as Node))closeAccent();},true);
  controls.querySelector('.controls-scroll')?.addEventListener('scroll',()=>closeAccent());
  window.addEventListener('resize',()=>closeAccent());
  const resetLayout=(save=true)=>{saved={};panels.forEach(p=>{p.style.left='';p.style.top='';p.style.right='';p.style.bottom='';if(RESIZABLE_IDS.includes(p.id)){p.style.width='';p.style.height='';}});restore();if(save)persist();};
  const tabs=Array.from(document.querySelectorAll<HTMLButtonElement>('[role=tab]'));
  const selectTab=(tab:HTMLButtonElement,focus=false)=>{closeAccent();for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;const panel=document.getElementById(item.getAttribute('aria-controls')!);if(panel)panel.hidden=!selected;}if(focus)tab.focus();};
  tabs.forEach((tab,index)=>{tab.onclick=()=>selectTab(tab);tab.onkeydown=e=>{let next=index;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();selectTab(tabs[next],true);};});
  const toggle=document.getElementById('toggle')!;
  const syncToggle=(hidden:boolean)=>{const label=hidden?'Show controls':'Hide controls';toggle.setAttribute('aria-label',label);toggle.title=label;toggle.setAttribute('aria-expanded',String(!hidden));};
  const toggleMenu=()=>{const hidden=document.body.classList.toggle('controls-hidden');syncToggle(hidden);closeAccent();if(hidden&&panels.some(p=>p.contains(document.activeElement)))toggle.focus();};
  toggle.onclick=toggleMenu;
  document.addEventListener('keydown',e=>{
    if(e.key!=='Tab'||e.shiftKey||e.ctrlKey||e.altKey||e.metaKey)return;
    e.preventDefault();if(!e.repeat)toggleMenu();
  });
  const statusSwitch=document.getElementById('status-with-menu') as HTMLInputElement;
  const syncStatus=()=>{statusSwitch.checked=hideStatusWithMenu;document.body.classList.toggle('status-with-menu',hideStatusWithMenu);};
  statusSwitch.onchange=()=>{hideStatusWithMenu=statusSwitch.checked;syncStatus();persist();};
  syncStatus();
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
      controlsHidden:document.body.classList.contains('controls-hidden'),hideStatusWithMenu});
  },reset(){
    opacity=.8;accent=defaultAccent;hideStatusWithMenu=false;syncStatus();setOpacity();setAccent();resetLayout(false);document.body.classList.remove('controls-hidden');syncToggle(false);
    selectTab(tabs[0]);document.querySelectorAll<HTMLDetailsElement>('#controls details').forEach(details=>details.open=false);
  }};
}
