import {chromium} from 'playwright-core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const base=process.env.GPU_ZOOMER_URL||'http://127.0.0.1:5183';
const output=process.env.GPU_ZOOMER_TEST_DIR||'F:/Coding/Temp/GPU-Zoomer-3-ui-upgrade/browser';
fs.mkdirSync(output,{recursive:true});
const context=await chromium.launchPersistentContext(path.join(output,'edge-profile'),{channel:'msedge',headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--enable-unsafe-swiftshader'],viewport:{width:960,height:720}});
const page=await context.newPage(),checks=[],errors=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail?` ${JSON.stringify(detail)}`:''}`);};
const app=(fn,arg)=>page.evaluate(fn,arg);
const waitReady=()=>page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);await a.ready;return !!a.testing?.engine;},null,{timeout:30000});
const status=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.status();});
const snapshot=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();});
const settle=async()=>{const start=Date.now();for(;;){const s=await status();if(s.error)throw Error(s.error);if(!s.busy&&!s.dirty&&s.quality===1&&s.progress?.complete&&s.progress.percentage===100)return s;if(Date.now()-start>120000)throw Error('settle timeout');await page.waitForTimeout(50);}};
const fieldHash=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const f=await a.testing.engine.debugReadField();const words=new Uint32Array(f.buffer);let h=2166136261;for(const word of words){h^=word;h=Math.imul(h,16777619);}return `${words.length}:${h>>>0}`;});
const screenshotHash=async(name,clip)=>{const bytes=await page.screenshot({path:path.join(output,`${name}.png`),clip});return crypto.createHash('sha256').update(bytes).digest('hex');};

try{
  await page.goto(base);await app(()=>localStorage.clear());await page.goto(base);await waitReady();await settle();
  const home=await snapshot();
  check('safe startup is Home at 1,000 iterations',home.span==='2.8'&&home.iterations===1000&&home.family==='mandelbrot',home);
  check('document and badge use WebGPU Zoomer 3',await page.title()==='WebGPU Zoomer 3'&&await page.locator('#title-badge').innerText()==='WebGPU Zoomer 3');
  check('one tabbed control panel replaces separate colour popup and exact input',await page.locator('#controls').count()===1&&await page.locator('#colour-panel,#iterations,#open-colour').count()===0&&await page.locator('[role=tab]').count()===3);
  const groups=await page.locator('#locations optgroup').evaluateAll(nodes=>nodes.map(n=>({label:n.label,values:Array.from(n.children).map(o=>o.value)})));
  check('location groups use unambiguous identifiers',groups[0]?.label==='Places'&&groups.flatMap(g=>g.values).every(v=>/^(place|saved):\d+$/.test(v)),groups);
  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);a.testing.load({...a.testing.snapshot(),x:'-0.61'});});await settle();await page.locator('#location-name').fill('Browser custom');await page.locator('#save').click();
  check('new saved location remains selected with its saved ID',await page.locator('#locations').inputValue()==='saved:0');
  await page.locator('#tab-main').focus();await page.keyboard.press('ArrowRight');
  check('tabs support arrow-key navigation',await page.locator('#tab-colouring').getAttribute('aria-selected')==='true'&&await page.locator('#panel-main').isHidden()&&await page.locator('#panel-colouring').isVisible());

  await page.locator('#open-palette').click();const first=page.locator('.palette-stop').first();await first.click();
  check('stop click opens anchored RGB picker',await page.locator('#stop-colour-popover').isVisible()&&await page.locator('#stop-select,#stop-position').count()===0);
  await page.locator('#stop-color').fill('#123456');await page.locator('#stop-color').dispatchEvent('input');
  check('valid RGB edit recolours in real time',(await snapshot()).appearance.stops.includes('#123456'));
  await page.locator('#stop-lock').check();const beforeDrag=(await snapshot()).appearance;await page.locator('#palette').click();
  const box=await first.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+70,box.y+box.height/2,{steps:5});await page.mouse.up();
  const afterDrag=(await snapshot()).appearance,lockedIndex=afterDrag.stops.indexOf('#123456');
  check('drag keeps pointer capture, does not open picker, and lock follows stop',await page.locator('#stop-colour-popover').isHidden()&&lockedIndex>=0&&afterDrag.locks[lockedIndex]===true,{lockedIndex});
  await page.locator('#palette-undo').click();check('palette drag remains undoable',JSON.stringify((await snapshot()).appearance.positions)!==JSON.stringify(afterDrag.positions));
  await page.locator('#close-palette').click();

  const baselineField=await fieldHash(),formulaHashes={};let s=await settle(),baseFields=s.fields;
  for(let id=0;id<15;id++){
    await page.locator('#color-formula').selectOption(String(id));s=await settle();
    if([0,1,5,9,11,12,13,14].includes(id))formulaHashes[id]=await screenshotHash(`formula-${id}`,{x:0,y:0,width:560,height:520});
    if(id===2)var endpointFields=s.fields;
    if(id>=3&&id<=10)check(`endpoint formula ${id} reuses retained endpoint field`,s.fields===endpointFields,{fields:s.fields});
  }
  check('all fifteen colouring formulas are available',await page.locator('#color-formula option').count()===15);
  check('scalar recolouring preserves numerical field',await fieldHash()===baselineField,{before:baselineField,after:await fieldHash()});
  check('representative formula renders are visibly distinct',new Set(Object.values(formulaHashes)).size>=6,formulaHashes);
  check('endpoint channels are acquired at most once for the formula sequence',endpointFields<=baseFields+1,{baseFields,endpointFields,finalFields:s.fields});
  await page.waitForTimeout(300);check('recolouring does not make the current saved location vanish',await page.locator('#locations').inputValue()==='saved:0');

  await page.locator('#tab-advanced').click();await page.locator('#profiling').check();const rawHash=await fieldHash();
  const points=Array.from({length:12},(_,j)=>Array.from({length:16},(_,i)=>[Math.floor((i+.5)*960/16),Math.floor((j+.5)*720/12)])).flat();
  await page.locator('#post-antialias').check();const aaStatus=await settle(),rawPixels=await app(async points=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.engine.debugReadPixels(points);},points),aaPixels=await app(async points=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.engine.debugReadAntialiasPixels(points);},points);
  const aaDifferences=rawPixels.filter((p,i)=>p.some((v,k)=>k<3&&v!==aaPixels[i]?.[k])).length;
  check('completed-image AA changes output without changing the numeric field',aaDifferences>0&&await fieldHash()===rawHash,{aaDifferences,rawHash,after:await fieldHash()});
  await page.waitForTimeout(150);const aaProfile=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.engine.performance();});check('AA pass timing is separated from recurrence timing',!aaProfile.supported||aaProfile.phases.antialias?.count>0,aaProfile);
  check('AA runs once then remains cached during idle',await (async()=>{const before=aaStatus.progress;await page.waitForTimeout(800);const after=(await status()).progress;return before.antialiasPasses===after.antialiasPasses&&before.calculationSubmissions===after.calculationSubmissions&&before.orbitSubmissions===after.orbitSubmissions;})(),{before:aaStatus.progress,after:(await status()).progress});
  await page.locator('#post-antialias').uncheck();const noAa=await settle();check('disabling AA restores unfiltered presentation without recurrence',noAa.fields===aaStatus.fields&&!(await snapshot()).appearance.postAntialias,{before:aaStatus.fields,after:noAa.fields});
  check('HUD remains DOM content outside the fractal filter target',await page.locator('footer').evaluate(n=>n.parentElement===document.body)&&await page.locator('#fractal').evaluate(n=>n.tagName==='CANVAS'));

  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const {PLACES}=await import('/src/places.ts');a.testing.load(PLACES[2]);});
  let partial=null,partialText='';for(let i=0;i<400;i++){const p=(await status()).progress;if(p?.percentage!==null&&p?.percentage<100){partial=p;partialText=await page.locator('#freshness').innerText();break;}await page.waitForTimeout(10);}const complete=await settle();
  check('progress is exact-tier, below 100 in flight and exactly 100 only complete',!!partial&&partial.percentage>=0&&partial.percentage<100&&!partialText.includes('100%')&&complete.progress.percentage===100&&complete.progress.exactCompletedSamples===complete.progress.exactTotalSamples,{partial,partialText,complete:complete.progress});
  const idleBefore=complete.progress;await page.waitForTimeout(800);const idleAfter=(await status()).progress;
  check('settled main view submits no further orbit or calculation work',idleBefore.calculationSubmissions===idleAfter.calculationSubmissions&&idleBefore.orbitSubmissions===idleAfter.orbitSubmissions,{idleBefore,idleAfter});
  const previewWasEnabled=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.juliaPreview().enabled;});if(previewWasEnabled){await app(()=>document.querySelector('#julia-from').click());await page.waitForTimeout(100);}await app(()=>document.querySelector('#julia-from').click());await page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const p=a.testing.juliaPreview();return p.enabled&&!p.busy&&!p.pending&&p.renderedEpoch===p.epoch&&p.work?.complete;},null,{timeout:60000});await page.waitForTimeout(100);const previewBefore=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.juliaPreview().work;});await page.waitForTimeout(800);const previewAfter=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.juliaPreview().work;});
  check('settled enabled Julia preview submits no further orbit or calculation work',previewBefore.complete&&previewBefore.calculationSubmissions===previewAfter.calculationSubmissions&&previewBefore.orbitSubmissions===previewAfter.orbitSubmissions,{previewBefore,previewAfter});await app(()=>document.querySelector('#julia-from').click());

  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const {PLACES}=await import('/src/places.ts');a.testing.load(PLACES[3]);});await settle();await page.mouse.move(480,360);await page.mouse.down();await page.waitForTimeout(120);await page.mouse.up();await page.mouse.down({button:'right'});await page.waitForTimeout(120);await page.mouse.up({button:'right'});const reversed=await settle();check('high-depth reversed motion converges to current target',reversed.progress.percentage===100&&reversed.quality===1,reversed.progress);
  await page.locator('#tab-main').click();await page.locator('#locations').selectOption('place:2');await page.locator('#locations').selectOption('place:4');const latest=await settle();check('stale in-flight result cannot complete over newer target',(await snapshot()).family==='julia'&&latest.progress.percentage===100);

  const deep=await app(async()=>{const {PLACES}=await import('/src/places.ts');const {encodeView}=await import('/src/state.ts');return{view:PLACES[3],hash:encodeView(PLACES[3])};});await page.goto(`${base}/?linked=1#${deep.hash}`);await waitReady();await settle();
  check('deep link is staged while startup remains Home',(await snapshot()).span==='2.8'&&await page.locator('#linked-location').isVisible());await page.locator('#open-linked-location').click();await settle();check('explicit linked-location action opens exact payload',JSON.stringify(await snapshot()).includes(deep.view.x)&&((await snapshot()).span===deep.view.span));
  await page.goto(base);await waitReady();await settle();check('plain reload returns to shallow Home with 1,000 iterations',(await snapshot()).span==='2.8'&&(await snapshot()).iterations===1000);

  await page.setViewportSize({width:390,height:844});await page.locator('#tab-advanced').click();await page.locator('#controls').evaluate(n=>{n.style.width='520px';n.style.height='780px';});await page.waitForTimeout(150);const rect=await page.locator('#controls').boundingBox();check('resized unified panel clamps inside narrow viewport',rect.x>=0&&rect.y>=0&&rect.x+rect.width<=390.5&&rect.y+rect.height<=844.5,rect);await screenshotHash('narrow-panel',{x:0,y:0,width:390,height:844});
  await page.setViewportSize({width:1440,height:900});await page.locator('#reset-layout').click();await page.locator('#tab-colouring').click();await screenshotHash('desktop-colouring',{x:0,y:0,width:1440,height:900});
}catch(error){errors.push(String(error));console.error(error);}finally{const report={checks,errors,browser:context.browser()?.version()};fs.writeFileSync(path.join(output,'upgrade-results.json'),JSON.stringify(report,null,2));await context.close();if(errors.length||checks.some(c=>!c.pass))process.exitCode=1;}
