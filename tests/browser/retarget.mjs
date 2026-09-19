export async function retargetChecks(context,baseUrl){
 const page=await context.newPage();
 await page.route('**/__retarget-check',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><canvas width="512" height="512"></canvas>'}));
 try{
  await page.goto(new URL('/__retarget-check',baseUrl).href);
  return await page.evaluate(async()=>{
   const {default:Decimal}=await import('/node_modules/decimal.js/decimal.mjs');Decimal.set({precision:160});
   const {acquireGpu}=await import('/src/gpu/device.ts');
   const {WebGpuRenderer}=await import('/src/render/webgpu-renderer.ts');
   const {DEFAULT_COLORS}=await import('/src/logic/colorSettings.ts');
   const ctx=await acquireGpu(),device=ctx.device,queue=device.queue,wait=queue.onSubmittedWorkDone.bind(queue);
   const canvas=document.querySelector('canvas'),engine=new WebGpuRenderer(ctx,canvas);await engine.init();
   const checks=[],errors=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
   const base={family:'julia',juliaX:new Decimal('-.8'),juliaY:new Decimal('.156'),centerX:new Decimal('0'),centerY:new Decimal('0'),
    unitsPerPixel:new Decimal('.01'),width:512,height:512,maxIterations:96,colors:{...DEFAULT_COLORS},tileRows:8,followView:true,interacting:true};
   let pending=null;
   const arm=predicate=>{
    let arrive,release;const reached=new Promise(resolve=>{arrive=resolve;}),resume=new Promise(resolve=>{release=resolve;});
    const gate={predicate,reached,resume,arrive,release,paused:false};pending=gate;return gate;
   };
   queue.onSubmittedWorkDone=async()=>{
    await wait();const gate=pending;
    if(gate&&!gate.paused&&gate.predicate()){gate.paused=true;gate.arrive();await gate.resume;}
   };
   const awaitGate=async(gate,rendering)=>{
    let timer;try{await Promise.race([gate.reached,rendering.then(()=>{throw Error('Stream completed before the requested partial gate');}),
     new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Partial gate timeout')),30000);})]);}finally{clearTimeout(timer);}
   };
   const target=async(renderer=engine)=>{
    const view=renderer.fieldView,width=view.width,height=view.height,stride=Math.ceil(width*4/256)*256;
    const buffer=device.createBuffer({size:stride*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:renderer.target},{buffer,bytesPerRow:stride},[width,height]);
    queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
    const bytes=new Uint8Array(buffer.getMappedRange()).slice();buffer.unmap();buffer.destroy();
    const alpha=new Uint8Array(width*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++)alpha[y*width+x]=bytes[y*stride+x*4+3];
    return{view:{...view},bytes,alpha,stride};
   };
   const partial=()=>engine.debugProgress().active&&engine.debugProgress().regions>0;
   const sameGeometry=(a,b)=>a&&a.width===b.width&&a.height===b.height&&a.centerX.eq(b.centerX)&&a.centerY.eq(b.centerY)&&a.unitsPerPixel.eq(b.unitsPerPixel);
   try{
    // Releasing the pointer changes scheduling demand, not numerical identity.
    engine.reproject(base);const gate=arm(partial);let completed=false;
    const rendering=engine.render(base).then(value=>{completed=true;return value;});await awaitGate(gate,rendering);
    const initial=await target(),initialField=await engine.debugReadField(),epoch=engine.debugProgress().epoch,completedBeforeRelease=completed;
    const known=initial.alpha.reduce((n,a)=>n+Number(a!==0),0);
    const released={...base,interacting:false};engine.reproject(released);gate.release();pending=null;
    const result=await rendering,finished=await target(),finishedField=await engine.debugReadField();
    let lost=0,changed=0;
    if(sameGeometry(initial.view,finished.view))for(let p=0;p<initial.alpha.length;p++)if(initial.alpha[p]){
     if(!finished.alpha[p])lost++;
     if(initialField[2*p]!==finishedField[2*p]||initialField[2*p+1]!==finishedField[2*p+1])changed++;
    }
    checks.push({name:'release with unchanged camera finishes the same partial stream',pass:!completedBeforeRelease&&known>0&&known<initial.alpha.length&&result.completed&&
     engine.debugProgress().epoch===epoch&&sameGeometry(initial.view,finished.view)&&finished.alpha.every(a=>a!==0)&&lost===0&&changed===0,
     detail:{known,total:initial.alpha.length,completedBeforeRelease,completed:result.completed,epochUnchanged:engine.debugProgress().epoch===epoch,lost,changed}});

    // Pan while the same public promise is pending. A16-column displacement
    // gives exact sample correspondence; presentation resampling cannot pass.
    engine.invalidateHistory();engine.reproject(base);const first=arm(partial);
    const streamed=engine.render(base);await awaitGate(first,streamed);
    const before=await target(),beforeField=await engine.debugReadField();
    const shifted={...base,centerX:base.centerX.plus(base.unitsPerPixel.times(16))};
    engine.reproject(shifted);
    const second=arm(()=>partial()&&sameGeometry(engine.fieldView,shifted));first.release();await awaitGate(second,streamed);
    const after=await target(),afterField=await engine.debugReadField();
    let eligible=0,lostCopies=0,alteredCopies=0;
    if(sameGeometry(before.view,base)&&sameGeometry(after.view,shifted))for(let y=0;y<512;y++)for(let x=0;x<496;x++){
     const source=y*512+x+16,destination=y*512+x;if(!before.alpha[source])continue;eligible++;
     if(!after.alpha[destination])lostCopies++;
     if(beforeField[2*source]!==afterField[2*destination]||beforeField[2*source+1]!==afterField[2*destination+1])alteredCopies++;
    }
    const finalRequest={...shifted,interacting:false};engine.reproject(finalRequest);second.release();pending=null;
    const finalResult=await streamed,actual=await engine.debugReadField(),actualPixels=await target();
    queue.onSubmittedWorkDone=wait;
    const referenceCanvas=document.createElement('canvas');referenceCanvas.width=512;referenceCanvas.height=512;
    const reference=new WebGpuRenderer(ctx,referenceCanvas);await reference.init();
    await reference.render({...finalRequest,followView:false});const expected=await reference.debugReadField();
    let countDifferences=0,scalarDifferences=0,validZeros=0,validInterior=0;
    for(let p=0;p<512*512;p++){
     if(actual[2*p]!==expected[2*p])countDifferences++;
     if(actual[2*p+1]!==expected[2*p+1])scalarDifferences++;
     if(actualPixels.alpha[p]&&actual[2*p]===0)validZeros++;
     if(actualPixels.alpha[p]&&actual[2*p]<0)validInterior++;
    }
    checks.push({name:'one live render retargets, retains exact samples and converges after release',pass:eligible>0&&lostCopies===0&&alteredCopies===0&&
     finalResult.completed&&sameGeometry(actualPixels.view,shifted)&&actualPixels.alpha.every(a=>a!==0)&&countDifferences===0&&scalarDifferences===0&&validInterior>0,
     detail:{eligible,lostCopies,alteredCopies,completed:finalResult.completed,countDifferences,scalarDifferences,validZeros,validInterior}});
    // New demand can arrive while the final statistics buffer is mapping.
    // It must not be overwritten by a stale "completed" result.
    const createBuffer=device.createBuffer.bind(device); let injected=false;
    const late={...finalRequest,centerX:finalRequest.centerX.plus(finalRequest.unitsPerPixel),colors:{...finalRequest.colors,palette:2}};
    device.createBuffer=descriptor=>{
     const buffer=createBuffer(descriptor);
     if(descriptor.size===32&&(descriptor.usage&GPUBufferUsage.MAP_READ)){
      const map=buffer.mapAsync.bind(buffer);
      buffer.mapAsync=async(...args)=>{await map(...args);if(!injected&&engine.fieldComplete){injected=true;engine.reproject(late);}};
     }
     return buffer;
    };
    const firstLate={...finalRequest,colors:{...finalRequest.colors,palette:3}};
    engine.reproject(firstLate);await engine.render(firstLate);device.createBuffer=createBuffer;
    checks.push({name:'demand arriving during final counter readback is completed before return',pass:injected&&engine.isComplete(late),detail:{injected,complete:engine.isComplete(late)}});
    // Sparse display blocks must not become scalar truth or a release stage.
    const sparseCanvas=document.createElement('canvas');sparseCanvas.width=512;sparseCanvas.height=512;
    const sparse=new WebGpuRenderer(ctx,sparseCanvas);await sparse.init();
    const sparseRequest={...finalRequest,tileRows:undefined,zoom:-1};
    sparse.reproject(sparseRequest);
    let sparseResume, sparseArrive;
    const sparseGate=new Promise(resolve=>{sparseArrive=resolve;}),sparseWait=new Promise(resolve=>{sparseResume=resolve;});
    let paused=false,firstKnown=0,filledUnknown=0,invalidAnchors=0,step=0;
    const sparseRun=sparse.render({...sparseRequest,betweenBatches:async()=>{
      if(paused)return;paused=true;
      step=sparse.latestRegion.stride;
      const field=await sparse.debugReadField(),pixels=await target(sparse);
      for(let p=0;p<512*512;p++){
        if(field[2*p+1]>=0)firstKnown++;
        else if(pixels.alpha[p]>0&&pixels.alpha[p]<255)filledUnknown++;
        if(pixels.alpha[p]===255&&field[2*p+1]<0)invalidAnchors++;
      }
      sparseArrive();await sparseWait;
    }});
    await sparseGate;
    const sparseEpoch=sparse.debugProgress().epoch;
    sparse.reproject({...sparseRequest,interacting:false});sparseResume();
    await sparseRun;const sparseField=await sparse.debugReadField();let sparseDifferences=0;
    for(let p=0;p<512*512*2;p++)if(sparseField[p]!==expected[p])sparseDifferences++;
    checks.push({name:'sparse display holes stay unknown scalars and converge in the same release stream',
      pass:step>1&&firstKnown===(512/step)**2&&filledUnknown===512*512-firstKnown&&invalidAnchors===0&&
        sparseDifferences===0&&sparse.debugProgress().epoch===sparseEpoch&&sparse.isComplete(sparseRequest),
      detail:{step,firstKnown,filledUnknown,invalidAnchors,sparseDifferences,epochUnchanged:sparse.debugProgress().epoch===sparseEpoch}});
    checks.push({name:'continuous stream has no GPU validation errors',pass:errors.length===0,detail:{errors}});
    return checks;
   }finally{pending?.release();queue.onSubmittedWorkDone=wait;engine.abort();device.destroy();}
  });
 }finally{await page.close();}
}
