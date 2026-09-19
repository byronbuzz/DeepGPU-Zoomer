import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { direct } from './direct.mjs';
import { presentationChecks } from './presentation.mjs';
import { streamingChecks } from './streaming.mjs';
import { retargetChecks } from './retarget.mjs';
import { proxyRetentionChecks } from './proxy-retention.mjs';

const output=process.env.GPU_ZOOMER_TEST_DIR || 'F:/Coding/Temp/GPU-Zoomer-3-qualification/app-verification';
fs.mkdirSync(output,{recursive:true});
const context=await chromium.launchPersistentContext(path.join(output,'edge-profile'),{
  channel:'msedge',headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--enable-unsafe-swiftshader'],viewport:{width:720,height:480},
});
const page=await context.newPage();
const report={browser:null,adapter:null,checks:[],numerical:[],gpuChecks:[],errors:[],performance:null};
page.on('pageerror',e=>report.errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))report.errors.push(m.text());});
const app=async fn=>page.evaluate(fn);
const status=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.status();});
const check=(name,pass,detail)=>{report.checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail?' '+JSON.stringify(detail):''}`);};
const settle=async()=>{const started=Date.now();for(;;){const s=await status();if(s.error)throw Error(s.error);if(!s.busy&&!s.dirty&&s.quality===1)return s;if(Date.now()-started>120000)throw Error('Refinement timeout');await page.waitForTimeout(100);}};
async function compare(name, extraPoints=[]){
  const s=await settle();
  const data=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return {view:a.testing.snapshot(),field:Array.from(await a.testing.engine.debugReadField()),width:document.querySelector('canvas').width,height:document.querySelector('canvas').height};});
  const rows=[],points=[...extraPoints];
  for(let j=0;j<7;j++)for(let i=0;i<7;i++){
    const x=Math.floor((i+.5)*data.width/7),y=Math.floor((j+.5)*data.height/7);
    points.push([x,y]);
  }
  for(const [x,y] of points){
    const a=direct(data.view,x,y,data.width,data.height,512),b=direct(data.view,x,y,data.width,data.height,768),gpu=data.field[2*(y*data.width+x)];
    rows.push({x,y,oracle512:a,oracle768:b,gpu,delta:gpu-b});
  }
  const mismatches=rows.filter(r=>r.delta!==0),oracleMismatches=rows.filter(r=>r.oracle512!==r.oracle768);
  report.numerical.push({name,view:data.view,width:data.width,height:data.height,rows,mismatches,oracleMismatches,stats:s.stats});
  check(name, mismatches.length===0&&oracleMismatches.length===0,{countDisagreements:mismatches.length,oracleDisagreements:oracleMismatches.length});
  await page.screenshot({path:path.join(output,name+'.png')});
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
}
try{
  for(const result of await presentationChecks(context,process.env.GPU_ZOOMER_URL || 'http://127.0.0.1:5183')) check(result.name,result.pass,result.detail);
  for(const result of await streamingChecks(context,process.env.GPU_ZOOMER_URL || 'http://127.0.0.1:5183')) check(result.name,result.pass,result.detail);
  for(const result of await retargetChecks(context,process.env.GPU_ZOOMER_URL || 'http://127.0.0.1:5183')) check(result.name,result.pass,result.detail);
  for(const result of await proxyRetentionChecks(context,process.env.GPU_ZOOMER_URL || 'http://127.0.0.1:5183')) check(result.name,result.pass,result.detail);
  await page.goto(process.env.GPU_ZOOMER_URL || 'http://127.0.0.1:5183');
  report.adapter=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);await a.ready;const gpu=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});return {vendor:gpu.info.vendor,architecture:gpu.info.architecture,fallback:gpu.info.isFallbackAdapter};});
  report.browser=context.browser().version();
  check('physical AMD adapter',report.adapter.vendor==='amd'&&report.adapter.fallback===false,report.adapter);
  for(const [place,name] of [[0,'mandelbrot-home'],[1,'mandelbrot-seahorse'],[2,'mandelbrot-6e-42'],[3,'mandelbrot-1e50'],[4,'julia-1e50']]){
    await page.selectOption('#places',String(place));await compare(name);
  }
  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const {HOME}=await import('/src/state.ts');a.testing.load({...HOME,family:'julia',x:'0'});});await compare('julia-home');
  // An already-escaped Julia point must be reported at iteration zero.
  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);a.testing.load({...a.testing.snapshot(),x:'15',y:'15',span:'1e-30'});});await compare('julia-initial-bailout');
  // Preserve the reported view and its three failing pixels, plus each pixel's
  // immediate neighbours. Expected counts still come only from direct.mjs.
  await app(async()=>{
    const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);
    a.testing.load({family:'mandelbrot',
      x:'-0.7306415249567179674564126808137349766637195178413058594098862566062443058950219458733751053543136202285',
      y:'0.1618038929239254474321368117854708727846076829629497296639618850035467323583391272471056909498211475756',
      span:'5.34547864799099529616966098711236667733050369615924011990458268501488728289618249845607183383544102148e-18',
      iterations:10000,jx:'-0.8',jy:'0.156'});
  });
  const neighbours=[];
  for(const [x,y] of [[668,102],[668,171],[51,377]])for(const dx of [-1,0,1])for(const dy of [-1,0,1]){
    if(dx||dy)neighbours.push([x+dx,y+dy]);
  }
  await compare('mandelbrot-actual10000',neighbours);
  await page.selectOption('#places','2');await settle();
  const before=await status();await page.selectOption('#palette','2');await settle();const after=await status();
  check('palette reuses numeric field',after.fields===before.fields&&after.recolours>before.recolours,{before:before.fields,after:after.fields,beforeStats:before.stats,afterStats:after.stats});
  await page.selectOption('#places','4');await settle();const exact=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();});
  await page.locator('#location-name').fill('Deep Julia test');await page.locator('#save').click();await page.locator('#share').click();
  await page.reload();await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);await a.ready;});await settle();
  const restored=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();});check('exact share reload',JSON.stringify(exact)===JSON.stringify(restored));
  await page.selectOption('#places','0');await settle();await page.locator('#toggle').click();
  await page.mouse.move(220,240);await page.mouse.wheel(0,-30);await settle();
  check('short wheel settles without more input',(await status()).quality===1);
  await page.mouse.down();await page.waitForTimeout(35);await page.mouse.up();await settle();check('short hold release refines',(await status()).quality===1);
  const m=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();});
  await page.locator('#fractal').press('j');
  await page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const p=a.testing.juliaPreview();return p.enabled&&!p.busy&&!p.pending&&p.renderedEpoch===p.epoch;});
  check('J previews Julia without changing the Mandelbrot camera',JSON.stringify(m)===JSON.stringify(await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();}))&&await page.locator('#julia-preview').isVisible());
  const selected=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const p=a.testing.camera.point(360,280,innerWidth,innerHeight);return{x:p.x.toString(),y:p.y.toString()};});
  await page.mouse.move(330,260);await page.mouse.down();await page.mouse.move(360,280);await page.mouse.up();
  await page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const p=a.testing.juliaPreview();return !p.busy&&!p.pending&&p.renderedEpoch===p.epoch;});
  const preview=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.juliaPreview();});
  check('Julia selection drag changes c without moving the main view',JSON.stringify(selected)===JSON.stringify(preview.selected)&&JSON.stringify(m)===JSON.stringify(await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();})));
  await page.locator('#fractal').press('m');await settle();
  const promoted=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();});
  check('M promotes the exact selected Julia constant',promoted.family==='julia'&&promoted.jx===selected.x&&promoted.jy===selected.y);
  await page.locator('#fractal').press('m');await settle();
  check('M restores the exact Mandelbrot camera',JSON.stringify(m)===JSON.stringify(await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();})));
  await page.locator('#toggle').click();
  // Stale family results must never become the final field after a rapid switch.
  await page.selectOption('#places','2');await page.selectOption('#places','4');await settle();check('rapid switch completes latest family',(await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();})).family==='julia');
  await page.setViewportSize({width:390,height:844});await settle();
  check('narrow layout has no horizontal overflow',await app(()=>document.documentElement.scrollWidth===innerWidth));await page.screenshot({path:path.join(output,'narrow.png')});
  await page.setViewportSize({width:2560,height:1440});await page.selectOption('#places','2');await settle();
  await page.locator('#toggle').click();await page.mouse.move(1190,720);await page.locator('#fractal').focus();
  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);a.testing.resetTiming();});
  const span0=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot().span;});const fields0=(await status()).fields;
  const started=performance.now();await page.mouse.down();await page.waitForTimeout(2500);await page.mouse.up();
  const inward=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot().span;});
  await page.mouse.down({button:'right'});await page.waitForTimeout(2500);await page.mouse.up({button:'right'});const ended=performance.now();
  const timing=await status();const span1=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot().span;});
  const frames=timing.frameTimes.filter(x=>x>0).sort((a,b)=>a-b),sum=frames.reduce((a,b)=>a+b,0);
  report.performance={viewport:[2560,1440],durationMs:ended-started,presentationHz:1000*frames.length/sum,p50Ms:frames[Math.floor(frames.length*.5)],p95Ms:frames[Math.floor(frames.length*.95)],maxMs:frames.at(-1),frames:timing.frameCount,freshFieldsDuringMotion:timing.fields-fields0,span0,inward,span1};
  console.log('PERFORMANCE',JSON.stringify(report.performance));await settle();check('deep motion refines after reversal',(await status()).quality===1);await page.screenshot({path:path.join(output,'1440p.png')});
  report.gpuChecks=await app(async()=>{const {runSelfTest}=await import('/src/gpu/selftest.ts');const checks=[];await runSelfTest(c=>checks.push(c));return checks;});check('retained GPU arithmetic/orbits',report.gpuChecks.every(c=>c.passed),{checks:report.gpuChecks.length});
}catch(e){report.errors.push(String(e));console.error(e);}
finally{fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));await context.close();}
if(report.errors.length||report.checks.some(c=>!c.pass))process.exitCode=1;
