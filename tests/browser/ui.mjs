const report=[],out=document.querySelector('#report'),status=document.querySelector('#status'),log=document.querySelector('#checks');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,pass,detail)=>{report.push({name,pass,detail});log.textContent+=`${pass?'PASS':'FAIL'} ${name}\n`;out.value=JSON.stringify(report);};
document.querySelector('#run').onclick=async()=>{
 document.querySelector('#run').disabled=true;const iframe=document.createElement('iframe');document.body.append(iframe);
 try{
  await new Promise(r=>{iframe.onload=r;iframe.src='/';});const w=iframe.contentWindow,d=w.document;
  const a=await w.eval(`import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src)`);await a.ready;
  const {HOME}=await w.eval("import('/src/state.ts')");a.testing.load(HOME);const el=id=>d.getElementById(id);
  const event=(id,type)=>el(id).dispatchEvent(new w.Event(type,{bubbles:true}));
  const settle=async()=>{for(let i=0;i<600;i++){const s=a.testing.status();if(s.error)throw Error(s.error);if(!s.busy&&!s.dirty&&s.quality===1)return;await delay(25);}throw Error('Main settle timeout');};
  await settle();check('exact 1000 is valid',el('iterations').checkValidity()&&a.testing.snapshot().iterations===1000);
  el('iteration-slider').value='1';event('iteration-slider','input');check('slider shows 1m while deferring application',el('iterations').value==='1000000'&&a.testing.snapshot().iterations===1000);
  el('iteration-slider').value='0';event('iteration-slider','input');event('iteration-slider','change');await settle();check('slider release applies its integer',a.testing.snapshot().iterations===32);
  el('iterations').value='1000';el('iterations').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await settle();check('Enter applies exact numeric iteration entry',a.testing.snapshot().iterations===1000);
  el('open-palette').click();const strip=el('palette-strip');
  for(let i=0;i<8;i++)strip.dispatchEvent(new w.PointerEvent('pointerdown',{clientX:strip.getBoundingClientRect().x+20+i*24,clientY:strip.getBoundingClientRect().y+10,bubbles:true}));
  check('palette enforces eight-stop maximum',a.testing.snapshot().appearance.stops.length===8);
  while(a.testing.snapshot().appearance.stops.length>2)el('stop-delete').click();el('stop-delete').click();check('palette enforces two-stop minimum',a.testing.snapshot().appearance.stops.length===2);
  el('palette-undo').click();check('delete is undoable',a.testing.snapshot().appearance.stops.length===3);el('palette-redo').click();check('delete is redoable',a.testing.snapshot().appearance.stops.length===2);
  el('stop-select').value='0';event('stop-select','change');el('stop-lock').checked=true;event('stop-lock','change');
  const locked=a.testing.snapshot().appearance,geometry=a.testing.snapshot();el('random-palette').click();const randomized=a.testing.snapshot();
  check('random palette preserves locked stops and numerical view',randomized.appearance.stops.some((s,i)=>s===locked.stops[0]&&randomized.appearance.positions[i]===locked.positions[0])&&['x','y','span','iterations'].every(k=>randomized[k]===geometry[k]));
  await settle();const before=a.testing.status();el('random-colors').click();await settle();check('palette-only edits recolour without recurrence',a.testing.status().fields===before.fields&&a.testing.status().recolours>before.recolours);
  const header=el('controls').querySelector('[data-handle]'),old=el('controls').getBoundingClientRect(),child=el('family').getBoundingClientRect();header.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  const moved=el('controls').getBoundingClientRect(),movedChild=el('family').getBoundingClientRect();check('panel handle moves the whole unit',Math.abs(moved.x-old.x+10)<1&&Math.abs((child.x-old.x)-(movedChild.x-moved.x))<1);
  el('fractal').dispatchEvent(new w.KeyboardEvent('keydown',{key:'j',bubbles:true}));
  const previewSettled=async()=>{for(let i=0;i<400;i++){const p=a.testing.juliaPreview();if(p.enabled&&!p.busy&&!p.pending&&p.epoch===p.renderedEpoch)return p;await delay(25);}throw Error('Preview settle timeout');};
  await previewSettled();const previewView=a.testing.snapshot();
  for(const [width,height] of [[470,420],[350,510],[430,450]]){
    el('julia-preview').style.width=width+'px';el('julia-preview').style.height=height+'px';await delay(40);await previewSettled();
  }
  const pv=await previewSettled(),pc=el('julia-preview-canvas'),pr=pc.getBoundingClientRect();
  check('resized preview uses bounded square pixels and exact displayed c',pc.width===pv.size.width&&pc.height===pv.size.height&&pc.width<=192&&pc.height<=160&&Math.abs(pc.width/pr.width-pc.height/pr.height)<=1/pr.width+1/pr.height&&JSON.stringify(pv.selected)===JSON.stringify(pv.displayed)&&JSON.stringify(a.testing.snapshot())===JSON.stringify(previewView),{backing:[pc.width,pc.height],css:[pr.width,pr.height]});
  el('toggle').click();check('hide includes panels and badge but leaves Julia independent',w.getComputedStyle(el('controls')).display==='none'&&w.getComputedStyle(el('palette-panel')).display==='none'&&w.getComputedStyle(el('title-badge')).display==='none'&&!el('julia-preview').hidden);
  let rendered=new Set(),lag=false;
  for(let i=0;i<35;i++){a.testing.selectPreview(200+i*8,340+Math.sin(i)*30);await delay(30);const p=a.testing.juliaPreview();if(p.renderedEpoch>=0)rendered.add(p.renderedEpoch);if(p.displayed&&JSON.stringify(p.displayed)!==JSON.stringify(p.selected))lag=true;}
  check('rapid selection continues publishing coherent preview images',rendered.size>=2,{images:rendered.size,displayLagObserved:lag});
  a.testing.selectPreview(630,400);const latest=a.testing.juliaPreview().selected,prior=a.testing.snapshot();el('fractal').dispatchEvent(new w.KeyboardEvent('keydown',{key:'m',bubbles:true}));await settle();
  check('M promotes latest selected c and main iteration limit',a.testing.snapshot().jx===latest.x&&a.testing.snapshot().jy===latest.y&&a.testing.snapshot().iterations===prior.iterations);
  el('fractal').dispatchEvent(new w.KeyboardEvent('keydown',{key:'m',bubbles:true}));await settle();check('M restores exact prior Mandelbrot and appearance',JSON.stringify(a.testing.snapshot())===JSON.stringify(prior));
  const p=a.testing.juliaPreview();await delay(200);check('closed Julia preview stops work',!p.enabled&&!a.testing.juliaPreview().busy&&a.testing.juliaPreview().renderedEpoch===p.renderedEpoch);
  el('toggle').click();el('reset-layout').click();
  iframe.style.width='390px';iframe.style.height='844px';await delay(150);
  el('open-colour').click();el('fractal').dispatchEvent(new w.KeyboardEvent('keydown',{key:'j',bubbles:true}));await previewSettled();
  const visible=Array.from(d.querySelectorAll('[data-panel]')).filter(p=>!p.hidden&&w.getComputedStyle(p).display!=='none').map(p=>({id:p.id,rect:p.getBoundingClientRect()}));
  check('all visible panels clamp inside a narrow viewport',visible.every(p=>p.rect.x>=0&&p.rect.y>=0&&p.rect.right<=w.innerWidth+1&&p.rect.bottom<=w.innerHeight+1),visible.map(p=>({id:p.id,x:p.rect.x,y:p.rect.y,width:p.rect.width,height:p.rect.height})));
  status.textContent=report.some(c=>!c.pass)?'FAILED':'PASSED';
 }catch(e){check('controls execution',false,String(e));status.textContent='FAILED';}
};
