import { PRESETS, FORMULAS, EFFECTS, validateColors, stopPositions, cycleFromSlider, cycleToSlider, type ColorSettings } from './logic/colorSettings';

type Stop={position:number;color:string;locked:boolean};
export function paletteStops(c:ColorSettings):Stop[]{return c.stops.map((color,i)=>({color,position:stopPositions(c)[i],locked:c.locks?.[i]??false}));}
export function withStops(c:ColorSettings,stops:Stop[]):ColorSettings{
  const sorted=stops.slice().sort((a,b)=>a.position-b.position);
  return validateColors({...c,palette:5,stops:sorted.map(s=>s.color),positions:sorted.map(s=>s.position),locks:sorted.map(s=>s.locked)});
}
function randomColor(hue:number,harmonious:boolean){
  if(!harmonious)return '#'+Math.floor(Math.random()*0x1000000).toString(16).padStart(6,'0');
  const h=(hue+Math.random()*.22)%1,s=.5+Math.random()*.45,l=.2+Math.random()*.6;
  const f=(n:number)=>{const k=(n+h*12)%12,a=s*Math.min(l,1-l);return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');};
  return '#'+f(0)+f(8)+f(4);
}
export function randomizePalette(c:ColorSettings,all:boolean,harmonious:boolean):ColorSettings{
  let stops=paletteStops(c);const hue=Math.random();
  if(all){const locked=stops.filter(s=>s.locked);const count=Math.max(2,locked.length,2+Math.floor(Math.random()*7));
    stops=[...locked,...Array.from({length:count-locked.length},()=>({position:Math.random(),color:'#000000',locked:false}))];}
  return withStops(c,stops.map(s=>s.locked?s:{...s,color:randomColor(hue,harmonious)}));
}

export function setupPaletteEditor(get:()=>ColorSettings,change:(c:ColorSettings)=>void){
  const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  let selected=0,dragging=false,dragDistance=0,dragRemembered=false,colourEditRemembered=false;const undo:ColorSettings[]=[],redo:ColorSettings[]=[];
  const remember=()=>{undo.push(validateColors(get()));if(undo.length>100)undo.shift();redo.length=0;};
  const commit=(c:ColorSettings,record=true)=>{if(record)remember();change(validateColors(c));sync();};
  const update=(mutate:(s:Stop[])=>Stop[])=>commit(withStops(get(),mutate(paletteStops(get()))));
  const popover=el('stop-colour-popover');
  const closePicker=()=>{popover.hidden=true;};
  const openPicker=(rect:DOMRect)=>{colourEditRemembered=false;popover.hidden=false;const width=180;const beside=rect.right+8+width<=innerWidth?rect.right+8:rect.left-width-8;popover.style.left=Math.max(8,Math.min(innerWidth-width-8,beside))+'px';popover.style.top=Math.max(8,Math.min(innerHeight-150,rect.top-20))+'px';syncFields();el<HTMLInputElement>('stop-color').focus();};
  el<HTMLSelectElement>('palette').add(new Option('Custom',''));
  PRESETS.forEach((p,i)=>el<HTMLSelectElement>('palette').add(new Option(p.name,String(i))));
  FORMULAS.forEach((p,i)=>el<HTMLSelectElement>('color-formula').add(new Option(p,String(i))));
  EFFECTS.forEach((p,i)=>el<HTMLSelectElement>('color-effect').add(new Option(p,String(i))));
  function sync(){
    // Persistence may synchronize controls while a captured drag is paused.
    // Keep that button alive until pointerup/cancel releases its capture.
    if(dragging)return;
    const restoreFocus=document.activeElement?.classList.contains('palette-stop');
    const c=get(),stops=paletteStops(c);selected=Math.min(selected,stops.length-1);
    const preset=PRESETS.findIndex(p=>p.stops.length===c.stops.length&&p.stops.every((v,i)=>v.toLowerCase()===c.stops[i].toLowerCase())&&stopPositions(c).every((p,i)=>Math.abs(p-i/(c.repeating===false?c.stops.length-1:c.stops.length))<1e-9));
    el<HTMLSelectElement>('palette').value=preset<0?'':String(preset);
    const strip=el('palette-strip');const grad=stops.map(s=>`${s.color} ${s.position*100}%`);
    if(c.repeating!==false){const a=stops[0],b=stops.at(-1)!;const t=(1-b.position)/(1-b.position+a.position||1);const rgb=(s:string)=>[1,3,5].map(i=>parseInt(s.slice(i,i+2),16));const x=rgb(b.color),y=rgb(a.color);const seam='#'+x.map((v,i)=>Math.round(v+(y[i]-v)*t).toString(16).padStart(2,'0')).join('');grad.unshift(`${seam} 0%`);grad.push(`${seam} 100%`);}
    strip.style.background=`linear-gradient(to right,${grad.join(',')})`;strip.replaceChildren();
    stops.forEach((s,i)=>{const b=document.createElement('button');b.type='button';b.className='palette-stop';b.style.left=s.position*100+'%';b.style.background=s.color;b.setAttribute('aria-label',`Stop ${i+1}: ${s.color} at ${s.position.toFixed(3)}. Drag or use arrow keys to move; press Enter to edit colour.`);b.setAttribute('aria-pressed',String(i===selected));
      let startX=0,startY=0;
      b.onpointerdown=e=>{e.stopPropagation();selected=i;dragging=true;dragDistance=0;dragRemembered=false;startX=e.clientX;startY=e.clientY;b.setPointerCapture(e.pointerId);b.focus();syncFields();};
      b.onpointermove=e=>{if(!b.hasPointerCapture(e.pointerId))return;dragDistance=Math.max(dragDistance,Math.hypot(e.clientX-startX,e.clientY-startY));if(dragDistance<3)return;if(!dragRemembered){remember();dragRemembered=true;}const r=strip.getBoundingClientRect();const s=paletteStops(get());s[selected].position=Math.max(0,Math.min(1,(e.clientX-r.x)/r.width));
        // Keep index stable during capture, then sort once the drag finishes.
        const moved=s[selected];const next=withStops(get(),s);selected=paletteStops(next).findIndex(v=>v.position===moved.position&&v.color===moved.color);change(next);b.style.left=moved.position*100+'%';syncFields();};
      b.onpointerup=()=>{const rect=b.getBoundingClientRect(),clicked=dragDistance<3;dragging=false;sync();if(clicked)openPicker(rect);};b.onpointercancel=()=>{dragging=false;sync();};b.onlostpointercapture=()=>{if(dragging){dragging=false;sync();}};
      b.onkeydown=e=>{if(e.key==='Delete'){el('stop-delete').click();return;}if(e.key==='Enter'||e.key===' '){e.preventDefault();selected=i;openPicker(b.getBoundingClientRect());return;}if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();selected=i;update(s=>{s[i].position=Math.max(0,Math.min(1,s[i].position+(e.key==='ArrowLeft'?-.01:.01)));return s;});};strip.append(b);});
    syncFields();
    if(restoreFocus)(strip.children[selected] as HTMLElement)?.focus();
    el<HTMLButtonElement>('palette-undo').disabled=!undo.length;el<HTMLButtonElement>('palette-redo').disabled=!redo.length;
    el<HTMLInputElement>('palette-repeat').checked=c.repeating!==false;
    el<HTMLSelectElement>('color-formula').value=String(c.formula??0);el<HTMLSelectElement>('color-effect').value=String(c.effect??0);el<HTMLSelectElement>('capped-mode').value=String(c.capped??0);
    el<HTMLInputElement>('distance-mode').checked=c.mode===1;
    el<HTMLInputElement>('cycle').value=String(cycleToSlider(c.cycle));el('cycle-value').textContent=c.cycle<100?c.cycle.toFixed(1):Math.round(c.cycle).toString();
    for(const [id,key] of [['color-offset','offset'],['slope-depth','slopeDepth'],['light-angle','lightAngle'],['light-elevation','lightElevation']] as const)el<HTMLInputElement>(id).value=String(c[key]);
    el<HTMLInputElement>('post-antialias').checked=c.postAntialias===true;
  }
  function syncFields(){const c=get(),s=paletteStops(c)[selected];el<HTMLInputElement>('stop-color').value=s.color;el<HTMLInputElement>('stop-color-swatch').value=s.color;el<HTMLInputElement>('stop-lock').checked=s.locked;el('selected-stop-label').textContent=`Stop ${selected+1}`;el<HTMLButtonElement>('stop-delete').disabled=c.stops.length<=2;}
  el('palette-strip').onpointerdown=e=>{if(e.target!==el('palette-strip')||get().stops.length>=8)return;const r=el('palette-strip').getBoundingClientRect();const position=Math.max(0,Math.min(1,(e.clientX-r.x)/r.width));update(s=>[...s,{position,color:s[selected].color,locked:false}]);selected=stopPositions(get()).indexOf(position);sync();};
  const liveColour=(value:string)=>{if(!/^#[0-9a-f]{6}$/i.test(value))return;if(!colourEditRemembered){remember();colourEditRemembered=true;}const stops=paletteStops(get());stops[selected].color=value;change(withStops(get(),stops));sync();};
  el<HTMLInputElement>('stop-color').oninput=e=>liveColour((e.target as HTMLInputElement).value);
  el<HTMLInputElement>('stop-color-swatch').oninput=e=>liveColour((e.target as HTMLInputElement).value);
  popover.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePicker();(el('palette-strip').children[selected] as HTMLElement)?.focus();}};
  document.addEventListener('pointerdown',e=>{if(!popover.hidden&&!popover.contains(e.target as Node)&&!(e.target as HTMLElement).classList.contains('palette-stop'))closePicker();},true);
  el<HTMLInputElement>('stop-lock').onchange=e=>update(s=>{s[selected].locked=(e.target as HTMLInputElement).checked;return s;});
  el('stop-delete').onclick=()=>{if(get().stops.length>2)update(s=>s.filter((_,i)=>i!==selected));};
  el('palette-reverse').onclick=()=>update(s=>s.map(v=>({...v,position:1-v.position})));
  el('palette-even').onclick=()=>update(s=>s.map((v,i)=>({...v,position:i/(get().repeating===false?s.length-1:s.length)})));
  el<HTMLInputElement>('palette-repeat').onchange=e=>commit({...get(),repeating:(e.target as HTMLInputElement).checked});
  el<HTMLSelectElement>('palette').onchange=e=>{const value=(e.target as HTMLSelectElement).value;if(value==='')return;const p=PRESETS[Number(value)];commit({...get(),palette:5,stops:[...p.stops],positions:undefined,locks:undefined});};
  for(const [id,all] of [['random-colors',false],['random-palette',true]] as const)el(id).onclick=()=>commit(randomizePalette(get(),all,el<HTMLSelectElement>('random-style').value==='harmonious'));
  el('palette-undo').onclick=()=>{const c=undo.pop();if(c){redo.push(validateColors(get()));commit(c,false);}};
  el('palette-redo').onclick=()=>{const c=redo.pop();if(c){undo.push(validateColors(get()));commit(c,false);}};
  for(const [id,key] of [['color-formula','formula'],['color-effect','effect'],['capped-mode','capped']] as const)el<HTMLSelectElement>(id).onchange=e=>commit({...get(),[key]:Number((e.target as HTMLSelectElement).value)});
  el<HTMLInputElement>('distance-mode').onchange=e=>commit({...get(),mode:(e.target as HTMLInputElement).checked?1:0});
  el<HTMLInputElement>('post-antialias').onchange=e=>commit({...get(),postAntialias:(e.target as HTMLInputElement).checked});
  el<HTMLInputElement>('cycle').oninput=e=>{const value=cycleFromSlider(Number((e.target as HTMLInputElement).value));change({...get(),cycle:value});el('cycle-value').textContent=value<100?value.toFixed(1):Math.round(value).toString();};
  for(const [id,key] of [['color-offset','offset'],['slope-depth','slopeDepth'],['light-angle','lightAngle'],['light-elevation','lightElevation']] as const)el<HTMLInputElement>(id).oninput=e=>{change({...get(),[key]:Number((e.target as HTMLInputElement).value)});};
  sync();return sync;
}
