import './colour-picker.css';

type HSV={h:number;s:number;v:number};
const normaliseHex=(value:string)=>/^#?[0-9a-f]{6}$/i.test(value.trim())?'#'+value.trim().replace(/^#/,'').toLowerCase():null;

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

/** Small shared picker: native keyboard-accessible sliders and an explicit hex field. */
export function setupColourPicker(mount:HTMLElement,hexInput:HTMLInputElement,onChange:(hex:string)=>void){
  let hsv:HSV={h:0,s:1,v:1},currentHex='';
  mount.classList.add('colour-picker');
  const preview=document.createElement('div');preview.className='colour-picker-preview';preview.setAttribute('aria-hidden','true');
  const sliders=([['h','Hue',360,'°'],['s','Saturation',100,'%'],['v','Brightness',100,'%']] as const).map(([key,title,max,unit])=>{
    const label=document.createElement('label'),name=document.createElement('span'),output=document.createElement('output'),input=document.createElement('input');
    label.className='colour-picker-channel';name.textContent=title;input.type='range';input.min='0';input.max=String(max);input.step='1';
    input.className=`colour-picker-${key}`;input.setAttribute('aria-label',title);output.setAttribute('aria-hidden','true');
    label.append(name,output,input);
    input.addEventListener('input',()=>{
      hsv[key]=Number(input.value)/(key==='h'?1:100);currentHex=toHex(hsv);render();onChange(currentHex);
    });
    return {key,unit,input,output,label};
  });
  mount.replaceChildren(preview,...sliders.map(slider=>slider.label));
  const error=document.createElement('span');error.className='colour-picker-error';error.id=`${hexInput.id}-error`;error.hidden=true;error.textContent='Use six hex digits, for example #eba046.';
  hexInput.insertAdjacentElement('afterend',error);hexInput.setAttribute('aria-describedby',[hexInput.getAttribute('aria-describedby'),error.id].filter(Boolean).join(' '));
  hexInput.autocomplete='off';hexInput.spellcheck=false;
  const validation=(invalid:boolean)=>{hexInput.setCustomValidity(invalid?error.textContent!:'');hexInput.setAttribute('aria-invalid',String(invalid));error.hidden=!invalid;};
  function render(){
    preview.style.background=currentHex;hexInput.value=currentHex;validation(false);
    for(const {key,unit,input,output} of sliders){const value=hsv[key]*(key==='h'?1:100);input.value=String(value);output.textContent=`${Math.round(value)}${unit}`;}
    sliders[1].input.style.background=`linear-gradient(to right,${toHex({...hsv,s:0})},${toHex({...hsv,s:1})})`;
    sliders[2].input.style.background=`linear-gradient(to right,#000000,${toHex({...hsv,v:1})})`;
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
