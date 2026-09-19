// Gate the actual GPU fence, not a mocked field: the render remains in flight
// while its published pixels are read from the real presentation surface.
export async function streamingChecks(context, baseUrl) {
  const page = await context.newPage();
  await page.route('**/__streaming-check', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><canvas width="64" height="48"></canvas>',
  }));
  try {
    await page.goto(new URL('/__streaming-check', baseUrl).href);
    return await page.evaluate(async () => {
      const { default: Decimal } = await import('/node_modules/decimal.js/decimal.mjs');
      Decimal.set({ precision: 160 });
      const { acquireGpu } = await import('/src/gpu/device.ts');
      const { WebGpuRenderer } = await import('/src/render/webgpu-renderer.ts');
      const { DEFAULT_COLORS } = await import('/src/logic/colorSettings.ts');
      const gpu = await acquireGpu(), device = gpu.device, queue = device.queue;
      const canvas = document.querySelector('canvas'), renderer = new WebGpuRenderer(gpu, canvas);
      await renderer.init();
      renderer.context.configure({ device, format: renderer.format, alphaMode: 'opaque',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const readCanvas = async () => {
        const buffer = device.createBuffer({ size: 256*48, usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: renderer.context.getCurrentTexture() }, { buffer, bytesPerRow: 256 }, [64,48]);
        queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
        const result = new Uint8Array(buffer.getMappedRange()).slice(); buffer.unmap(); buffer.destroy();
        return result;
      };
      const base = { centerX: new Decimal('-.9'), centerY: new Decimal(0), unitsPerPixel: new Decimal('.05'),
        width:64, height:48, maxIterations:128, colors:{...DEFAULT_COLORS}, family:'mandelbrot',
        juliaX:new Decimal('-.8'),juliaY:new Decimal('.156'),tileRows:8 };
      await renderer.render(base);renderer.reproject(base);
      const fresh = {...base,centerX:new Decimal('-.45'),centerY:new Decimal('.1')};
      const wait = queue.onSubmittedWorkDone.bind(queue);
      let release, arrived, gated=false, completed=false;
      const gate = new Promise(resolve=>{release=resolve;});
      const paused = new Promise(resolve=>{arrived=resolve;});
      queue.onSubmittedWorkDone = async () => {
        await wait();
        if(!gated && renderer.debugProgress().regions>0 && renderer.debugProgress().active){
          gated=true;arrived();await gate;
        }
      };
      const rendering=renderer.render(fresh).then(result=>{completed=true;return result;});
      await Promise.race([paused,rendering.then(()=>{throw Error('Render completed without an observable partial region');}),
        new Promise((_,reject)=>setTimeout(()=>reject(Error('Partial region timeout')),30000))]);
      const progress=renderer.debugProgress();
      const presented=renderer.reproject(fresh), partial=await readCanvas();
      const points=[];for(let y=0;y<48;y++)for(let x=0;x<64;x++)points.push([x,y]);
      const target=await renderer.debugReadPixels(points), incoming=renderer.incomingFrame;
      renderer.incomingFrame=null;renderer.reproject(fresh);const retained=await readCanvas();renderer.incomingFrame=incoming;
      const blueFirst=renderer.format.startsWith('bgra');
      let known=0,unknown=0,wrongKnown=0,wrongUnknown=0,visibleChanges=0;
      for(let p=0;p<points.length;p++){
        const offset=p*4,source=target[p];
        if(source[3]!==0){
          known++;
          const wanted=blueFirst?[source[2],source[1],source[0]]:source;
          if([0,1,2].some(k=>partial[offset+k]!==wanted[k]))wrongKnown++;
          if([0,1,2].some(k=>partial[offset+k]!==retained[offset+k]))visibleChanges++;
        }else{
          unknown++;
          if([0,1,2].some(k=>partial[offset+k]!==retained[offset+k]))wrongUnknown++;
        }
      }
      const checks=[{name:'newly computed pixels are visible before their field completes',
        pass:presented&&!completed&&progress.active&&!progress.complete&&known>0&&unknown>0&&visibleChanges>0&&wrongKnown===0&&wrongUnknown===0,
        detail:{completed,presented,progress,known,unknown,visibleChanges,wrongKnown,wrongUnknown}}];
      renderer.invalidateHistory();
      const afterInvalidation=renderer.debugProgress(), stalePresented=renderer.reproject(fresh);
      release();const stale=await rendering;queue.onSubmittedWorkDone=wait;
      checks.push({name:'epoch invalidation prevents unfinished pixels from publishing later',
        pass:!afterInvalidation.active&&!stalePresented&&!stale.completed&&!renderer.debugProgress().active,
        detail:{afterInvalidation,stalePresented,completed:stale.completed}});
      const latest={...base,family:'julia',centerX:new Decimal(0),juliaX:new Decimal('-.4'),juliaY:new Decimal('.6')};
      const result=await renderer.render(latest);
      checks.push({name:'latest family completes after a partial field is invalidated',
        pass:result.completed&&renderer.reproject(latest)&&renderer.lastFrame.family==='julia'});

      // Changing c makes every old numerical sample incompatible, even where
      // the old and incoming textures have exactly the same geometry.
      let releaseC,arriveC,cGated=false;
      const cGate=new Promise(resolve=>{releaseC=resolve;}),cPaused=new Promise(resolve=>{arriveC=resolve;});
      queue.onSubmittedWorkDone=async()=>{await wait();if(!cGated&&renderer.debugProgress().active&&renderer.debugProgress().regions>0){cGated=true;arriveC();await cGate;}};
      const changedC={...latest,juliaX:new Decimal('-.8'),juliaY:new Decimal('.156')};
      const cRendering=renderer.render(changedC);
      await Promise.race([cPaused,cRendering.then(()=>{throw Error('Changed-c render completed without a partial region');}),
        new Promise((_,reject)=>setTimeout(()=>reject(Error('Changed-c partial region timeout')),30000))]);
      renderer.reproject(changedC);const withOldC=await readCanvas();
      const oldValid=renderer.historyValid,oldCoverage=renderer.coverageFrame;
      renderer.historyValid=false;renderer.coverageFrame=null;
      renderer.reproject(changedC);const withoutOldC=await readCanvas();
      renderer.historyValid=oldValid;renderer.coverageFrame=oldCoverage;
      const cTarget=await renderer.debugReadPixels(points);
      let cUnknown=0,cContaminated=0;
      for(let p=0;p<points.length;p++){
        if(cTarget[p][3]===0)cUnknown++;
        if([0,1,2].some(k=>withOldC[p*4+k]!==withoutOldC[p*4+k]))cContaminated++;
      }
      checks.push({name:'a partial Julia field never presents completed pixels from a different constant',
        pass:cUnknown>0&&cUnknown<points.length&&cContaminated===0,
        detail:{unknown:cUnknown,contaminated:cContaminated}});
      releaseC();await cRendering;queue.onSubmittedWorkDone=wait;

      let releaseFar,arriveFar,farGated=false,farCompleted=false;
      const farGate=new Promise(resolve=>{releaseFar=resolve;}),farPaused=new Promise(resolve=>{arriveFar=resolve;});
      queue.onSubmittedWorkDone=async()=>{await wait();if(!farGated&&renderer.debugProgress().active&&renderer.debugProgress().regions>0){farGated=true;arriveFar();await farGate;}};
      const far={...latest,centerX:new Decimal(20),unitsPerPixel:new Decimal('.000001')};
      const farRendering=renderer.render(far).then(value=>{farCompleted=true;return value;});
      await Promise.race([farPaused,farRendering.then(()=>{throw Error('Far render completed without a partial region');}),
        new Promise((_,reject)=>setTimeout(()=>reject(Error('Far partial region timeout')),30000))]);
      const farPresented=renderer.reproject(far),farCanvas=await readCanvas();
      const farTarget=await renderer.debugReadPixels(points),partialField=await renderer.debugReadField();
      let farKnown=0,farWrong=0;
      for(let p=0;p<points.length;p++)if(farTarget[p][3]!==0){
        farKnown++;const source=farTarget[p],wanted=blueFirst?[source[2],source[1],source[0]]:source;
        if([0,1,2].some(k=>farCanvas[p*4+k]!==wanted[k]))farWrong++;
      }
      checks.push({name:'incoming pixels present after a pan and zoom beyond completed history',
        pass:farPresented&&!farCompleted&&farKnown>0&&farKnown<64*48&&farWrong===0,
        detail:{presented:farPresented,completed:farCompleted,known:farKnown,wrong:farWrong}});
      renderer.abort();releaseFar();const interrupted=await farRendering;queue.onSubmittedWorkDone=wait;
      const replanned={...far,centerX:far.centerX.plus(far.unitsPerPixel)};
      const resumed=await renderer.render(replanned),resumedField=await renderer.debugReadField();
      let eligible=0,altered=0;
      for(let y=0;y<48;y++)for(let x=0;x<63;x++){
        const source=y*64+x+1,destination=y*64+x;
        if(farTarget[source][3]===0)continue;
        eligible++;
        if(partialField[2*source]!==resumedField[2*destination]||partialField[2*source+1]!==resumedField[2*destination+1])altered++;
      }
      checks.push({name:'compatible replanning copies only known samples from an unfinished field',
        pass:!interrupted.completed&&resumed.completed&&eligible>0&&resumed.reusedSamples===eligible&&altered===0,
        detail:{eligible,reused:resumed.reusedSamples,computed:resumed.computedSamples,altered}});
      device.destroy();return checks;
    });
  } finally { await page.close(); }
}
