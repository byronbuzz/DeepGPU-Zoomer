import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const base=process.env.GPU_ZOOMER_URL||'http://127.0.0.1:5184';
const output=process.env.GPU_ZOOMER_TEST_DIR||`F:/Coding/Temp/GPU-Zoomer-3-lighting-repair/regression-${Date.now()}`;
fs.mkdirSync(output,{recursive:true});
const context=await chromium.launchPersistentContext(path.join(output,'edge-profile'),{channel:'msedge',headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--enable-unsafe-swiftshader'],viewport:{width:1440,height:900}});
const page=await context.newPage(),checks=[],errors=[];
page.on('pageerror',error=>errors.push(`pageerror: ${String(error)}`));
page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('404'))errors.push(`console: ${message.text()}`);});
const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail?` ${JSON.stringify(detail)}`:''}`);};
const app=(fn,arg)=>page.evaluate(fn,arg);
const module=()=>app(async()=>{const script=document.querySelector('script[type="module"][src*="/src/main.ts"]');return !!script;});
const status=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.status();});
const snapshot=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();});
const rawHash=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src),frame=await a.testing.capture();const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',frame.pixels));return {width:frame.width,height:frame.height,hash:[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('')};});
const settle=async(label)=>{const started=performance.now();let stable=0,last;for(;;){last=await status();const ready=!last.busy&&!last.dirty&&last.quality===1&&last.progress?.complete&&last.progress.percentage===100;if(ready)stable++;else stable=0;if(stable>=3)return {label,durationMs:Math.round(performance.now()-started),status:last};if(last.error)throw Error(last.error);if(performance.now()-started>120000)throw Error(`${label} settle timeout`);await page.waitForTimeout(40);}};
const waitBusy=()=>page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.status().busy;},null,{timeout:5000});
const open=async()=>{await page.goto(base);await page.waitForSelector('script[type="module"][src*="/src/main.ts"]',{state:'attached'});await page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);await a.ready;return !!a.testing?.engine;});await settle('open');};
const setRange=async(id,value)=>page.locator(id).fill(String(value));
let report={checks,errors,runs:[],artifacts:{}};

try{
  await open();check('development diagnostics available',await module());
  await page.locator('#tab-colouring').click();await page.locator('#lighting summary').click();
  await page.locator('#distance-mode').check();report.runs.push(await settle('distance-field'));
  const field=await status(),baseImage=await rawHash();
  const fieldIdentity=field.progress.fieldIdentity,submissions=field.progress.calculationSubmissions;

  await page.locator('#color-formula').selectOption('5');report.runs.push(await settle('formula-5'));const formula5=await rawHash(),afterFormula5=await status();
  await page.locator('#color-formula').selectOption('6');report.runs.push(await settle('formula-6'));const formula6=await rawHash(),afterFormula6=await status();
  await setRange('#cycle',.75);report.runs.push(await settle('spacing'));const spacing=await rawHash(),afterSpacing=await status();
  await setRange('#color-offset',.37);report.runs.push(await settle('offset'));const offset=await rawHash(),afterOffset=await status();
  await page.locator('#color-effect').selectOption('4');report.runs.push(await settle('effect'));const effect=await rawHash(),afterEffect=await status();
  const recolours=[afterFormula5,afterFormula6,afterSpacing,afterOffset,afterEffect];
  check('distance colouring controls change real pixels',new Set([baseImage.hash,formula5.hash,formula6.hash,spacing.hash,offset.hash,effect.hash]).size===6);
  check('distance recolours preserve the numeric field',recolours.every(s=>s.progress.fieldIdentity===fieldIdentity&&s.progress.calculationSubmissions===submissions),recolours.map(s=>({field:s.progress.fieldIdentity,submissions:s.progress.calculationSubmissions,fields:s.fields,recolours:s.recolours})));

  await setRange('#slope-depth',20);await settle('relief-20');const relief20=await rawHash();
  await setRange('#slope-depth',80);report.runs.push(await settle('relief-80'));const relief80=await rawHash();
  check('relief 80 reaches rendering and changes pixels',relief80.hash!==relief20.hash&&await page.locator('#slope-depth').getAttribute('max')==='80');
  check('relief 80 is current saved state',(await snapshot()).appearance.slopeDepth===80);

  await page.locator('#distance-mode').uncheck();await waitBusy();
  await page.locator('#color-formula').selectOption('10');await page.locator('#color-effect').selectOption('7');await page.locator('#capped-mode').selectOption('11');
  await page.locator('#distance-mode').check();await waitBusy();await page.waitForTimeout(20);
  report.artifacts.onTransition=path.join(output,'on-transition.png');await page.locator('#fractal').screenshot({path:report.artifacts.onTransition,animations:'disabled'});
  report.runs.push(await settle('rapid-final-on'));const finalOn=await rawHash(),finalOnState=await status();
  await page.waitForTimeout(350);await page.reload();await page.waitForSelector('script[type="module"][src*="/src/main.ts"]',{state:'attached'});await page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);await a.ready;return !!a.testing?.engine;});report.runs.push(await settle('fresh-final-on'));const freshOn=await rawHash();
  check('rapid OFF to ON converges to fresh final pixels',finalOn.hash===freshOn.hash,{finalOn:finalOn.hash,freshOn:freshOn.hash});
  check('final ON is idle and complete',!finalOnState.busy&&!finalOnState.dirty&&finalOnState.progress.complete&&finalOnState.progress.percentage===100);

  await page.locator('#tab-colouring').click();await page.locator('#lighting summary').click();
  await page.locator('#distance-mode').uncheck();await waitBusy();await page.locator('#distance-mode').check();await waitBusy();
  await page.locator('#color-formula').selectOption('6');await page.locator('#color-effect').selectOption('4');await page.locator('#capped-mode').selectOption('8');await page.locator('#distance-mode').uncheck();
  await page.waitForTimeout(20);report.artifacts.offTransition=path.join(output,'off-transition.png');await page.locator('#fractal').screenshot({path:report.artifacts.offTransition,animations:'disabled'});
  report.runs.push(await settle('rapid-final-off'));const finalOff=await rawHash(),finalOffState=await status();
  await page.waitForTimeout(350);await page.reload();await page.waitForSelector('script[type="module"][src*="/src/main.ts"]',{state:'attached'});await page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);await a.ready;return !!a.testing?.engine;});report.runs.push(await settle('fresh-final-off'));const freshOff=await rawHash();
  check('rapid ON to OFF converges to fresh final pixels',finalOff.hash===freshOff.hash,{finalOff:finalOff.hash,freshOff:freshOff.hash});
  check('final OFF is idle and complete',!finalOffState.busy&&!finalOffState.dirty&&finalOffState.progress.complete&&finalOffState.progress.percentage===100);
  check('relief 80 survives reload',(await snapshot()).appearance.slopeDepth===80);

  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src),v=a.testing.snapshot();a.testing.load({...v,family:'julia',x:'0',y:'0',span:'2.8',jx:'-0.8',jy:'0.156'});});report.runs.push(await settle('shallow-julia'));const julia=await rawHash();
  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src),v=a.testing.snapshot();a.testing.load({...v,family:'mandelbrot',x:'-0.743643887037151',y:'0.13182590420533',span:'2.8e-8'});});report.runs.push(await settle('deeper-mandelbrot'));const deep=await rawHash();
  check('Julia and deeper smoke produce complete distinct images',julia.hash!==deep.hash&&julia.width===deep.width&&julia.height===deep.height,{julia:julia.hash,deep:deep.hash});
  report.artifacts.final=path.join(output,'final.png');await page.screenshot({path:report.artifacts.final,animations:'disabled'});
}catch(error){errors.push(String(error?.stack||error));console.error(error);}finally{
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));await context.close();
}
if(errors.length||checks.some(c=>!c.pass))process.exitCode=1;
