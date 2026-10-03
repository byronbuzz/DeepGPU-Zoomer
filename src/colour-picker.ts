import './colour-picker.css';

type HSV={h:number;s:number;v:number};
const normaliseHex=(value:string)=>/^#?[0-9a-f]{6}$/i.test(value.trim())?'#'+value.trim().replace(/^#/,'').toLowerCase():null;
const clamp=(value:number)=>Math.max(0,Math.min(1,value));
let sampleImageColour:((x:number,y:number)=>Promise<string>)|undefined;
type ImageColourPatch={width:number;height:number;pixels:Uint8ClampedArray};
let sampleImagePatch:((x:number,y:number)=>Promise<ImageColourPatch>)|undefined;
export function setImageColourSampler(sample:(x:number,y:number)=>Promise<string>,patch?:(x:number,y:number)=>Promise<ImageColourPatch>){sampleImageColour=sample;sampleImagePatch=patch;}

function toHSV(hex:string,previous:HSV):HSV{
  const [r,g,b]=[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)/255);
  const v=Math.max(r,g,b),delta=v-Math.min(r,g,b);
  const h=delta===0?previous.h:((v===r?(g-b)/delta:v===g?(b-r)/delta+2:(r-g)/delta+4)*60+360)%360;
  return {h,s:v===0?previous.s:delta/v,v};
}
function toHex({h,s,v}:HSV):string{
  const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;
  const rgb=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
  return '#'+rgb.map(value=>Math.round((value+m)*255).toString(16).padStart(2,'0')).join('');
}

/** Pick only the displayed fractal, intercepting the gesture before camera handlers. */
function pickImageColour():Promise<string|null>{
  const canvas=document.getElementById('fractal');
  if(!(canvas instanceof HTMLCanvasElement))return Promise.reject(new Error('No image to sample'));
  return new Promise((resolve,reject)=>{
    const previousCursor=canvas.style.cursor;
    let pointerId:number|undefined,result:string|null=null,failed:unknown,finished=false,settling=false,pending:Promise<void>|undefined;
    const loupe=document.createElement('div'),preview=document.createElement('canvas'),centre=document.createElement('span');
    loupe.className='colour-picker-loupe';loupe.hidden=true;loupe.setAttribute('aria-hidden','true');
    centre.className='colour-picker-loupe-centre';loupe.append(preview,centre);document.body.append(loupe);
    const context=preview.getContext('2d');
    let hover:{x:number;y:number;clientX:number;clientY:number}|undefined,previewPending=false,lastPreview=0,previewFrame=0;
    const point=(event:PointerEvent)=>{
      const r=canvas.getBoundingClientRect();
      if(!r.width||!r.height||!canvas.width||!canvas.height||event.target!==canvas)return;
      return {x:Math.min(canvas.width-1,Math.floor(clamp((event.clientX-r.left)/r.width)*canvas.width)),
        y:Math.min(canvas.height-1,Math.floor(clamp((event.clientY-r.top)/r.height)*canvas.height)),clientX:event.clientX,clientY:event.clientY};
    };
    const position=()=>{
      if(!hover)return;
      const size=109,gap=18;
      const x=hover.clientX+gap+size<=window.innerWidth?hover.clientX+gap:hover.clientX-gap-size;
      const y=hover.clientY+gap+size<=window.innerHeight?hover.clientY+gap:hover.clientY-gap-size;
      loupe.style.left=`${Math.max(4,Math.min(window.innerWidth-size-4,x))}px`;
      loupe.style.top=`${Math.max(4,Math.min(window.innerHeight-size-4,y))}px`;
    };
    const refreshPreview=(now:number)=>{
      if(finished)return;
      previewFrame=requestAnimationFrame(refreshPreview);
      if(!hover||pointerId!==undefined||previewPending||now-lastPreview<66||!sampleImagePatch||!context)return;
      const sampled=hover,sample=sampleImagePatch;previewPending=true;lastPreview=now;
      void Promise.resolve().then(()=>sample(sampled.x,sampled.y)).then(patch=>{
        if(finished||!hover)return;
        preview.width=patch.width;preview.height=patch.height;
        const data=context.createImageData(patch.width,patch.height);data.data.set(patch.pixels);context.putImageData(data,0,0);
        centre.style.width=`${105/patch.width}px`;centre.style.height=`${105/patch.height}px`;
        loupe.hidden=false;
      }).catch(error=>{if(!finished){failed=error;finish();}}).finally(()=>{previewPending=false;});
    };
    canvas.style.cursor='crosshair';
    const block=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();};
    const move=(event:PointerEvent)=>{
      block(event);hover=point(event);position();
      if(!hover)loupe.hidden=true;
    };
    const finish=(cancelled=false)=>{
      if(finished)return;finished=true;
      cancelAnimationFrame(previewFrame);loupe.remove();
      canvas.style.cursor=previousCursor;
      window.removeEventListener('pointerdown',down,true);window.removeEventListener('pointermove',move,true);
      window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',cancel,true);
      window.removeEventListener('click',block,true);window.removeEventListener('contextmenu',block,true);
      window.removeEventListener('wheel',block,true);window.removeEventListener('keydown',key,true);
      window.removeEventListener('blur',cancel);
      if(cancelled)resolve(null);else if(failed)reject(failed);else resolve(result);
    };
    const down=(event:PointerEvent)=>{
      block(event);if(pointerId!==undefined)return;
      pointerId=event.pointerId;
      if(event.button!==0||event.target!==canvas)return;
      try{
        const selected=point(event);if(!selected)throw new Error('Image is not ready');
        if(!sampleImageColour)throw new Error('Image sampling is unavailable');
        pending=sampleImageColour(selected.x,selected.y).then(hex=>{result=hex;},error=>{failed=error;});
      }catch(error){failed=error;}
    };
    const up=(event:PointerEvent)=>{
      block(event);if(event.pointerId!==pointerId||settling)return;settling=true;
      void (pending??Promise.resolve()).then(()=>setTimeout(()=>finish(),0));
    };
    const cancel=()=>finish(true);
    const key=(event:KeyboardEvent)=>{block(event);if(event.key==='Escape')cancel();};
    window.addEventListener('pointerdown',down,{capture:true,passive:false});
    window.addEventListener('pointermove',move,{capture:true,passive:false});
    window.addEventListener('pointerup',up,{capture:true,passive:false});
    window.addEventListener('pointercancel',cancel,true);window.addEventListener('click',block,true);
    window.addEventListener('contextmenu',block,true);window.addEventListener('wheel',block,{capture:true,passive:false});
    window.addEventListener('keydown',key,true);window.addEventListener('blur',cancel);
    previewFrame=requestAnimationFrame(refreshPreview);
  });
}

/** Shared saturation/brightness swatch, hue strip, image picker and hex field. */
export function setupColourPicker(mount:HTMLElement,hexInput:HTMLInputElement,onChange:(hex:string)=>void){
  let hsv:HSV={h:0,s:1,v:1},currentHex='';
  mount.classList.add('colour-picker');
  const swatch=document.createElement('div'),marker=document.createElement('span');
  swatch.className='colour-picker-swatch';swatch.setAttribute('role','group');swatch.setAttribute('aria-label','Saturation and brightness');
  marker.className='colour-picker-marker';marker.setAttribute('aria-hidden','true');swatch.append(marker);
  const help=document.createElement('span');help.className='colour-picker-help';help.id=`${hexInput.id}-swatch-help`;
  help.textContent='Left and right change saturation. Up and down change brightness. Hold Shift for larger steps.';
  swatch.title=help.textContent;
  // Two native slider values keep both dimensions available to assistive technology.
  const axes=([['s','Saturation'],['v','Brightness']] as const).map(([key,title])=>{
    const input=document.createElement('input');input.type='range';input.min='0';input.max='100';input.step='1';
    input.className='colour-picker-axis';input.setAttribute('aria-label',title);input.setAttribute('aria-describedby',help.id);
    input.addEventListener('input',()=>{hsv[key]=Number(input.value)/100;commit();});swatch.append(input);
    return {key,input};
  });
  let activePointer:number|undefined;
  const move=(event:PointerEvent)=>{
    const r=swatch.getBoundingClientRect();if(!r.width||!r.height)return;
    hsv.s=clamp((event.clientX-r.left)/r.width);hsv.v=1-clamp((event.clientY-r.top)/r.height);commit();
  };
  swatch.addEventListener('pointerdown',event=>{
    if(event.button!==0||activePointer!==undefined)return;
    event.preventDefault();event.stopPropagation();activePointer=event.pointerId;
    axes[0].input.focus({preventScroll:true});swatch.setPointerCapture(event.pointerId);move(event);
  });
  swatch.addEventListener('pointermove',event=>{if(event.pointerId===activePointer){event.preventDefault();move(event);}});
  const end=(event:PointerEvent)=>{if(event.pointerId!==activePointer)return;activePointer=undefined;if(swatch.hasPointerCapture(event.pointerId))swatch.releasePointerCapture(event.pointerId);};
  swatch.addEventListener('pointerup',end);swatch.addEventListener('pointercancel',end);swatch.addEventListener('lostpointercapture',end);
  swatch.addEventListener('keydown',event=>{
    const step=event.shiftKey ? .1 : .01;
    if(event.key==='ArrowLeft')hsv.s=clamp(hsv.s-step);else if(event.key==='ArrowRight')hsv.s=clamp(hsv.s+step);
    else if(event.key==='ArrowUp')hsv.v=clamp(hsv.v+step);else if(event.key==='ArrowDown')hsv.v=clamp(hsv.v-step);
    else return;
    event.preventDefault();event.stopPropagation();commit();
  });
  const hueRow=document.createElement('div'),hueName=document.createElement('span'),hueValue=document.createElement('output'),hue=document.createElement('input');
  hueRow.className='colour-picker-channel';hueName.textContent='Hue';hueValue.setAttribute('aria-hidden','true');
  hue.type='range';hue.min='0';hue.max='360';hue.step='1';hue.className='colour-picker-h';hue.setAttribute('aria-label','Hue');
  hue.addEventListener('input',()=>{hsv.h=Number(hue.value);commit();});hueRow.append(hueName,hueValue,hue);
  const actions=document.createElement('div'),eyedropper=document.createElement('button'),status=document.createElement('span');
  actions.className='colour-picker-actions';eyedropper.type='button';eyedropper.textContent='Pick from image';eyedropper.setAttribute('aria-label','Pick colour from image');
  status.className='colour-picker-status';status.setAttribute('role','status');status.hidden=true;
  const preview=document.createElement('div');preview.className='colour-picker-preview';preview.setAttribute('aria-hidden','true');
  actions.append(preview,eyedropper);mount.replaceChildren(swatch,help,hueRow,actions,status);
  const setStatus=(message:string)=>{status.textContent=message;status.hidden=!message;};
  eyedropper.addEventListener('click',async()=>{
    eyedropper.disabled=true;setStatus('');
    try{
      setStatus('Click the image to pick a colour. Esc cancels.');
      const hex=await pickImageColour();
      if(hex){const value=normaliseHex(hex);if(value){hsv=toHSV(value,hsv);currentHex=value;render();onChange(value);}}
      setStatus('');
    }catch{setStatus('Colour could not be read. Try again or enter a hex colour.');}
    finally{eyedropper.disabled=false;if(eyedropper.getClientRects().length)eyedropper.focus({preventScroll:true});}
  });
  const error=document.createElement('span');error.className='colour-picker-error';error.id=`${hexInput.id}-error`;error.hidden=true;error.textContent='Use six hex digits, for example #eba046.';
  hexInput.insertAdjacentElement('afterend',error);hexInput.setAttribute('aria-describedby',[hexInput.getAttribute('aria-describedby'),error.id].filter(Boolean).join(' '));
  hexInput.autocomplete='off';hexInput.spellcheck=false;
  const validation=(invalid:boolean)=>{hexInput.setCustomValidity(invalid?error.textContent!:'');hexInput.setAttribute('aria-invalid',String(invalid));error.hidden=!invalid;};
  function commit(){currentHex=toHex(hsv);render();onChange(currentHex);}
  function render(){
    preview.style.background=currentHex;hexInput.value=currentHex;validation(false);
    swatch.style.setProperty('--picker-hue',`hsl(${hsv.h} 100% 50%)`);
    marker.style.left=`${hsv.s*100}%`;marker.style.top=`${(1-hsv.v)*100}%`;
    const description=`Saturation ${Math.round(hsv.s*100)}%, brightness ${Math.round(hsv.v*100)}%`;
    for(const {key,input} of axes){input.value=String(hsv[key]*100);input.setAttribute('aria-valuetext',description);}
    hue.value=String(hsv.h);hueValue.textContent=`${Math.round(hsv.h)}°`;hue.setAttribute('aria-valuetext',`${Math.round(hsv.h)} degrees`);
  }
  function sync(value:string){
    const hex=normaliseHex(value);if(!hex)return;
    if(hex!==currentHex){hsv=toHSV(hex,hsv);currentHex=hex;render();}
    else if(document.activeElement!==hexInput)render();
  }
  hexInput.addEventListener('input',()=>{
    const hex=normaliseHex(hexInput.value);if(!hex)return;
    hsv=toHSV(hex,hsv);currentHex=hex;render();onChange(hex);
  });
  hexInput.addEventListener('change',()=>validation(!normaliseHex(hexInput.value)));
  sync(hexInput.value||'#ffffff');
  return {sync};
}
