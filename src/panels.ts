/** Device-local panel placement. Handles move whole panels, never form controls. */
export function setupPanels(){
  const panels=Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
  let saved:Record<string,{x:number;y:number}>={};let opacity=.8;
  try{const v=JSON.parse(localStorage.getItem('gpu-zoomer-layout')||'{}');saved=v.positions??{};opacity=Number.isFinite(v.opacity)?Math.max(.15,Math.min(1,v.opacity)):.8;}catch{}
  const persist=()=>{try{localStorage.setItem('gpu-zoomer-layout',JSON.stringify({positions:saved,opacity}));}catch{}};
  const clamp=(p:HTMLElement,x:number,y:number)=>{
    const r=p.getBoundingClientRect();
    const pos={x:Math.max(8,Math.min(innerWidth-r.width-8,x)),y:Math.max(8,Math.min(innerHeight-r.height-8,y))};
    p.style.left=pos.x+'px';p.style.top=pos.y+'px';p.style.right='auto';p.style.bottom='auto';return pos;
  };
  for(const p of panels){
    const handle=p.querySelector<HTMLElement>('[data-handle]')??p;
    handle.tabIndex=0;handle.setAttribute('aria-label',`Move ${p.getAttribute('aria-label')??'title badge'} (arrow keys)`);
    let start:{x:number;y:number;px:number;py:number}|undefined;
    handle.addEventListener('pointerdown',e=>{if(e.button!==0||(e.target as HTMLElement).closest('button,input,select'))return;
      const r=p.getBoundingClientRect();start={x:e.clientX,y:e.clientY,px:r.x,py:r.y};handle.setPointerCapture(e.pointerId);e.preventDefault();});
    handle.addEventListener('pointermove',e=>{if(start)saved[p.id]=clamp(p,start.px+e.clientX-start.x,start.py+e.clientY-start.y);});
    const end=()=>{start=undefined;persist();};handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
    handle.addEventListener('keydown',e=>{const d:Record<string,number[]>={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]};if(e.target!==handle||!d[e.key])return;e.preventDefault();const r=p.getBoundingClientRect();saved[p.id]=clamp(p,r.x+d[e.key][0],r.y+d[e.key][1]);persist();});
    new ResizeObserver(()=>{if(!p.hidden){const r=p.getBoundingClientRect();clamp(p,saved[p.id]?.x??r.x,saved[p.id]?.y??r.y);}}).observe(p);
  }
  const restore=()=>panels.forEach(p=>{if(!p.hidden){const r=p.getBoundingClientRect();clamp(p,saved[p.id]?.x??r.x,saved[p.id]?.y??r.y);}});
  window.addEventListener('resize',restore);restore();
  const input=document.getElementById('panel-opacity') as HTMLInputElement;
  const setOpacity=()=>{document.documentElement.style.setProperty('--panel-opacity',String(opacity));input.value=String(opacity);};setOpacity();
  input.oninput=()=>{opacity=Number(input.value);setOpacity();persist();};
  document.getElementById('reset-layout')!.onclick=()=>{saved={};panels.forEach(p=>{p.style.left='';p.style.top='';p.style.right='';p.style.bottom='';});restore();persist();};
  for(const name of ['palette','colour']){
    const panel=document.getElementById(name+'-panel')!;
    const opener=document.getElementById('open-'+name)!;
    opener.onclick=()=>{panel.hidden=!panel.hidden;opener.setAttribute('aria-expanded',String(!panel.hidden));restore();if(!panel.hidden)panel.querySelector<HTMLElement>('[data-handle]')?.focus();};
    document.getElementById('close-'+name)!.onclick=()=>{panel.hidden=true;opener.setAttribute('aria-expanded','false');opener.focus();};
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'){panel.hidden=true;opener.setAttribute('aria-expanded','false');opener.focus();}});
  }
  const toggle=document.getElementById('toggle')!;
  toggle.onclick=()=>{const hidden=document.body.classList.toggle('controls-hidden');toggle.textContent=hidden?'Show controls':'Hide controls';toggle.setAttribute('aria-expanded',String(!hidden));};
}
