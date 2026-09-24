import {chromium} from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const base=process.env.GPU_ZOOMER_URL||'http://127.0.0.1:5183';
const output=process.env.GPU_ZOOMER_TEST_DIR||`F:/Coding/Temp/GPU-Zoomer-3-lean-editor/browser-smoke-${Date.now()}`;
fs.mkdirSync(output,{recursive:true});
const context=await chromium.launchPersistentContext(path.join(output,'edge-profile'),{channel:'msedge',headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--enable-unsafe-swiftshader'],acceptDownloads:true,viewport:{width:960,height:720}});
const page=await context.newPage(),checks=[],errors=[];
page.on('pageerror',error=>errors.push(`pageerror: ${String(error)}`));
page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('404'))errors.push(`console: ${message.text()}`);});
const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail?` ${JSON.stringify(detail)}`:''}`);};
const app=(fn,arg)=>page.evaluate(fn,arg);
const status=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.status();});
const snapshot=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();});
const settle=async()=>{const start=Date.now();for(;;){const s=await status();if(s.error)throw Error(s.error);if(!s.busy&&!s.dirty&&s.quality===1&&s.progress?.complete&&s.progress.percentage===100)return s;if(Date.now()-start>120000)throw Error('settle timeout');await page.waitForTimeout(50);}};

try{
  await page.goto(base);await page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);await a.ready;return !!a.testing?.engine;});await settle();
  check('safe Home startup',(await snapshot()).iterations===5000&&await page.locator('#speed').inputValue()==='0.7'&&await page.locator('#iteration-dynamic').getAttribute('aria-pressed')==='true');
  check('edge-connected keyboard tabs',await page.locator('[role=tab]').count()===3&&await page.locator('.panel-heading,#back,#forward,#palette-panel,#open-palette').count()===0);
  await page.locator('#tab-main').focus();await page.keyboard.press('ArrowRight');
  check('tab keyboard navigation',await page.locator('#tab-colouring').getAttribute('aria-selected')==='true');
  const choiceCounts={palettes:await page.locator('#palette option').count(),capped:await page.locator('#capped-mode option').count()};
  check('expanded colour choices',choiceCounts.palettes>=11&&choiceCounts.capped===13,choiceCounts);
  await page.locator('#edit-palette summary').click();await page.locator('#palette').selectOption('3');await settle();
  check('inline palette edit is seamless',(await snapshot()).appearance.repeating===true&&await page.locator('.palette-stop').count()>=2);
  await page.screenshot({path:path.join(output,'colouring-panel.png')});
  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);globalThis.__rawFrame=await a.testing.capture();});
  const beforeAa=await status();await page.locator('#tab-advanced').click();await page.locator('#post-antialias').check();const aa=await settle();
  const aaImage=await app(async()=>{
    const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src),raw=globalThis.__rawFrame,filtered=await a.testing.capture();
    const linear=v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);};let before=0,after=0,constantPixels=0,constantMax=0,darkMax=0;
    for(let y=1;y<raw.height-1;y++)for(let x=1;x<raw.width-1;x++){const i=(y*raw.width+x)*4;for(let c=0;c<3;c++){before+=linear(raw.pixels[i+c]);after+=linear(filtered.pixels[i+c]);}
      let constant=true;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const j=((y+dy)*raw.width+x+dx)*4;for(let c=0;c<3;c++)constant&&=raw.pixels[j+c]===raw.pixels[i+c];}
      if(constant){constantPixels++;for(let c=0;c<3;c++)constantMax=Math.max(constantMax,Math.abs(filtered.pixels[i+c]-raw.pixels[i+c]));if(raw.pixels[i]===0&&raw.pixels[i+1]===0&&raw.pixels[i+2]===0)darkMax=Math.max(darkMax,filtered.pixels[i],filtered.pixels[i+1],filtered.pixels[i+2]);}
    }return {relativeLinearLuminanceChange:(after-before)/before,constantPixels,constantMax,darkMax};
  });
  check('AA preserves flat colours and avoids global dark bias',Math.abs(aaImage.relativeLinearLuminanceChange)<.02&&aaImage.constantPixels>1000&&aaImage.constantMax<=1&&aaImage.darkMax<=1,aaImage);
  const aaFixture=await app(async()=>{
    const {ANTIALIAS_SHADER:code}=await import('/src/render/webgpu-renderer.ts'),adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('No WebGPU adapter for AA fixture');const device=await adapter.requestDevice();
    const module=device.createShaderModule({code}),pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba8unorm-srgb'}]},primitive:{topology:'triangle-strip'}}),sampler=device.createSampler({magFilter:'linear',minFilter:'linear'}),size=64,row=256;
    const run=async kind=>{const input=new Uint8Array(row*size);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=y*row+x*4,v=kind==='constant'?[32,96,192]:x===y?[255,255,255]:[0,0,0];input.set([...v,255],i);}
      const source=device.createTexture({size:[size,size],format:'rgba8unorm',viewFormats:['rgba8unorm-srgb'],usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),target=device.createTexture({size:[size,size],format:'rgba8unorm',viewFormats:['rgba8unorm-srgb'],usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),buffer=device.createBuffer({size:row*size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});device.queue.writeTexture({texture:source},input,{bytesPerRow:row},{width:size,height:size});
      const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView({format:'rgba8unorm-srgb'}),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:source.createView({format:'rgba8unorm-srgb'})},{binding:1,resource:sampler}]}));pass.draw(4);pass.end();encoder.copyTextureToBuffer({texture:target},{buffer,bytesPerRow:row},{width:size,height:size});device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const output=new Uint8Array(buffer.getMappedRange());let maxDelta=0,darkMax=0,before=0,after=0,alphaMin=255;const linear=v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);};for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=y*row+x*4;for(let c=0;c<3;c++){maxDelta=Math.max(maxDelta,Math.abs(output[i+c]-input[i+c]));before+=linear(input[i+c]);after+=linear(output[i+c]);if(kind==='line'&&Math.abs(x-y)>10)darkMax=Math.max(darkMax,output[i+c]);}alphaMin=Math.min(alphaMin,output[i+3]);}buffer.unmap();buffer.destroy();source.destroy();target.destroy();return {maxDelta,darkMax,relativeEnergy:(after-before)/Math.max(1,before),alphaMin};};
    const result={constant:await run('constant'),line:await run('line')};device.destroy();return result;
  });
  check('AA bright-line/dark-field fixture preserves energy without distant halos',aaFixture.constant.maxDelta<=1&&aaFixture.constant.alphaMin===255&&Math.abs(aaFixture.line.relativeEnergy)<.1&&aaFixture.line.darkMax<=1&&aaFixture.line.alphaMin===255,aaFixture);
  await page.waitForTimeout(500);const idle=await status();
  check('AA is cached without recurrence',aa.progress.antialiasPasses>beforeAa.progress.antialiasPasses&&idle.progress.antialiasPasses===aa.progress.antialiasPasses&&idle.progress.calculationSubmissions===aa.progress.calculationSubmissions,{before:beforeAa.progress,after:idle.progress});
  await page.locator('#tab-main').click();const canvas=await page.locator('#fractal').evaluate(n=>({width:n.width,height:n.height}));
  const downloadPromise=page.waitForEvent('download');await page.locator('#screenshot').click();const download=await downloadPromise;const png=path.join(output,'capture.png');await download.saveAs(png);const bytes=fs.readFileSync(png);
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  check('PNG uses backing dimensions',bytes.subarray(1,4).toString()==='PNG'&&width===canvas.width&&height===canvas.height,{png:[width,height],canvas});
  await page.locator('#location-entry').fill('Keep me');await page.locator('#save').click();await page.locator('#speed').fill('3');
  await page.locator('#fractal').focus();await page.keyboard.down('+');await page.waitForTimeout(2600);await page.keyboard.press('Escape');await page.keyboard.up('+');const settled=await settle();
  check('held zoom and Escape settle at the fixed cap',(await snapshot()).iterations===5000&&settled.effectiveLimit===5000&&settled.lastRevision===settled.revision&&settled.progress.percentage===100&&await page.locator('#freshness').innerText().then(text=>text.includes('Time taken:')),{effective:settled.effectiveLimit,revision:settled.revision});
  await page.locator('#full-reset').click();await settle();const reset=await snapshot();
  await page.locator('#location-entry').focus();
  check('full reset restores defaults and preserves saved locations',reset.iterations===5000&&reset.span==='2.8'&&reset.appearance.postAntialias===false&&await page.locator('#speed').inputValue()==='0.7'&&await page.locator('#location-options [data-location-kind="saved"]').filter({hasText:'Keep me'}).count()===1&&await page.locator('#tab-main').getAttribute('aria-selected')==='true',reset);
  await page.screenshot({path:path.join(output,'reset-main.png')});
}catch(error){errors.push(String(error));console.error(error);}finally{
  const report={checks,errors,browser:context.browser()?.version()};fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));await context.close();
  if(errors.length||checks.some(c=>!c.pass))process.exitCode=1;
}
