// Exercise the production presentation path with real GPU commands, while
// yielding at a GPU fence to make publication ordering deterministic.
export async function presentationChecks(context, baseUrl) {
  const page = await context.newPage();
  await page.route('**/__presentation-check', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><canvas width="64" height="48"></canvas>',
  }));
  try {
    await page.goto(new URL('/__presentation-check', baseUrl).href);
    return await page.evaluate(async () => {
      const { default: Decimal } = await import('/node_modules/decimal.js/decimal.mjs');
      // This direct module import has its own constructor configuration.
      Decimal.set({ precision: 160 });
      const { acquireGpu } = await import('/src/gpu/device.ts');
      const { WebGpuRenderer } = await import('/src/render/webgpu-renderer.ts');
      const { DEFAULT_COLORS } = await import('/src/logic/colorSettings.ts');
      const gpu = await acquireGpu(), device = gpu.device, queue = device.queue;
      const canvas = document.querySelector('canvas');
      const renderer = new WebGpuRenderer(gpu, canvas);
      await renderer.init();
      const checks = [], disagreements = [], content = new WeakMap();
      const commandCopies = new WeakMap();
      let active = null, observations = 0;
      const geometry = r => r && [r.centerX.toString(), r.centerY.toString(),
        r.unitsPerPixel.toString(), r.width, r.height, r.family, r.maxIterations,
        r.juliaX?.toString(), r.juliaY?.toString(), JSON.stringify(r.colors)].join('|');
      const createEncoder = device.createCommandEncoder.bind(device);
      const submit = queue.submit.bind(queue), wait = queue.onSubmittedWorkDone.bind(queue);
      const blit = renderer.encodeBlit.bind(renderer);
      device.createCommandEncoder = descriptor => {
        const encoder = createEncoder(descriptor), copies = [];
        const copy = encoder.copyTextureToTexture.bind(encoder), finish = encoder.finish.bind(encoder);
        encoder.copyTextureToTexture = (source, destination, size) => {
          if (source.texture === renderer.target) copies.push([destination.texture, geometry({ ...active, ...renderer.fieldView })]);
          return copy(source, destination, size);
        };
        encoder.finish = descriptor => {
          const command = finish(descriptor); commandCopies.set(command, copies); return command;
        };
        return encoder;
      };
      queue.submit = commands => {
        const list = [...commands]; submit(list);
        for (const command of list) for (const [texture, view] of commandCopies.get(command) || []) content.set(texture, view);
      };
      renderer.encodeBlit = (encoder, source, transform) => {
        const pixels = content.get(source);
        if (pixels) {
          observations++;
          if (pixels !== geometry(renderer.lastFrame)) disagreements.push({ pixels, metadata: geometry(renderer.lastFrame) });
        }
        const secondary = renderer.coverageHistory && content.get(renderer.coverageHistory);
        if (secondary) {
          observations++;
          if (secondary !== geometry(renderer.coverageFrame)) disagreements.push({ coveragePixels: secondary, metadata: geometry(renderer.coverageFrame) });
        }
        return blit(encoder, source, transform);
      };
      queue.onSubmittedWorkDone = async () => {
        await wait();
        // This occurs before render() resumes after its publication fence.
        if (active) renderer.reproject(active);
      };
      const request = (x, width = 32, height = 24) => ({
        centerX: new Decimal(x), centerY: new Decimal(0), unitsPerPixel: new Decimal(2.8).div(height),
        width, height, maxIterations: 96, colors: { ...DEFAULT_COLORS }, family: 'mandelbrot',
        juliaX: new Decimal('-0.8'), juliaY: new Decimal('0.156'),
      });
      for (const next of [request('-.6'), request('-.5'), request('-.4',64,48)]) {
        active = next; await renderer.render(next); renderer.reproject(next);
      }
      checks.push({ name: 'history pixels and camera metadata publish atomically',
        pass: observations >= 3 && disagreements.length === 0, detail: { observations, disagreements } });
      checks.push({ name: 'history refuses incompatible family and Julia constant', pass:
        !renderer.reproject({ ...active, family: 'julia' }) });
      active = { ...request('0'), family: 'julia' }; await renderer.render(active);
      checks.at(-1).pass &&= !renderer.reproject({ ...active, juliaX: new Decimal('-0.7') });
      const before = await renderer.render(active);
      active = { ...active, colors: { ...active.colors, palette: 2 } };
      const recoloured = await renderer.render(active);
      checks.push({ name: 'palette recolour reuses the numerical field', pass: before.completed && recoloured.completed && !recoloured.computed });
      active.colors.palette = 3;
      renderer.reproject(active);
      checks.push({ name: 'published colour metadata is an immutable snapshot', pass: renderer.lastFrame.colors.palette===2 });
      active = { ...request('-.6'), unitsPerPixel: new Decimal('.1') }; await renderer.render(active);
      const previousView = { ...renderer.fieldView }, previousField = await renderer.debugReadField();
      active = { ...active, centerX: active.centerX.plus(active.unitsPerPixel.times(5)), interacting: true };
      const reused = await renderer.render(active), nextView = renderer.fieldView, nextField = await renderer.debugReadField();
      const first = view => ({ x: view.centerX.minus(view.unitsPerPixel.times(view.width-1).div(2)),
        y: view.centerY.plus(view.unitsPerPixel.times(view.height-1).div(2)) });
      const oldFirst = first(previousView), newFirst = first(nextView);
      let copied = 0, altered = 0;
      for (let y = 0; y < nextView.height; y++) for (let x = 0; x < nextView.width; x++) {
        const ox = newFirst.x.plus(nextView.unitsPerPixel.times(x)).minus(oldFirst.x).div(previousView.unitsPerPixel);
        const oy = oldFirst.y.minus(newFirst.y.minus(nextView.unitsPerPixel.times(y))).div(previousView.unitsPerPixel);
        if (!ox.isInteger() || !oy.isInteger() || ox.lt(0) || oy.lt(0) || ox.gte(previousView.width) || oy.gte(previousView.height)) continue;
        copied++;
        const beforeIndex = 2*(oy.toNumber()*previousView.width+ox.toNumber()), afterIndex = 2*(y*nextView.width+x);
        if (previousField[beforeIndex]!==nextField[afterIndex] || previousField[beforeIndex+1]!==nextField[afterIndex+1]) altered++;
      }
      checks.push({ name: 'motion reuses unchanged samples at identical complex coordinates',
        pass: reused.reusedSamples>0 && copied>0 && altered===0 && reused.computedSamples>0,
        detail: { reusedSamples: reused.reusedSamples, computedSamples: reused.computedSamples, compared: copied, altered } });

      renderer.context.configure({ device, format: renderer.format, alphaMode: 'opaque',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const readCanvas = async () => {
        const stride = Math.ceil(canvas.width*4/256)*256;
        const buffer = device.createBuffer({ size: stride*canvas.height, usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ });
        const encoder = createEncoder();
        encoder.copyTextureToBuffer({ texture: renderer.context.getCurrentTexture() }, { buffer, bytesPerRow: stride }, [canvas.width,canvas.height]);
        submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(buffer.getMappedRange()).slice(); buffer.unmap(); buffer.destroy();
        return { bytes, stride };
      };
      renderer.invalidateHistory();
      const wide = { ...request('-.6',64,48), unitsPerPixel: new Decimal('.04') };
      active = wide; await renderer.render(active); renderer.reproject(wide);
      const widePixels = await readCanvas();
      active = { ...wide, unitsPerPixel: new Decimal('.02') };
      await renderer.render(active); renderer.reproject(wide);
      const returnedPixels = await readCanvas(); let retained = 0, changed = 0;
      for (let y=0;y<48;y++) for (let x=0;x<64;x++) {
        if (x>=16&&x<48&&y>=12&&y<36) continue;
        retained++;
        const at=y*widePixels.stride+x*4;
        if ([0,1,2,3].some(k=>widePixels.bytes[at+k]!==returnedPixels.bytes[at+k])) changed++;
      }
      checks.push({ name: 'zoom reversal preserves prior computed pixels outside the narrow field',
        pass: retained>0&&changed===0, detail: { compared: retained, changed } });
      active = { ...wide, unitsPerPixel: new Decimal('.001') };
      await renderer.render(active);
      const covered = renderer.reproject(wide), distantPixels = await readCanvas();
      let outsideCompared = 0, outsideChanged = 0;
      for(let y=0;y<48;y++)for(let x=0;x<64;x++){
        if(x>=30&&x<34&&y>=22&&y<26)continue;
        outsideCompared++; const at=y*widePixels.stride+x*4;
        if([0,1,2,3].some(k=>widePixels.bytes[at+k]!==distantPixels.bytes[at+k]))outsideChanged++;
      }
      checks.push({ name: 'broader history presents when the narrow front exceeds its mapping range',
        pass: covered&&outsideChanged===0, detail: { presented: covered, compared: outsideCompared, changed: outsideChanged } });

      renderer.invalidateHistory(); active=wide;
      await renderer.render(active); renderer.reproject(wide);
      const finePixels=await readCanvas();
      for(const [width,height,spacing] of [[32,24,'.08'],[16,12,'.16']]){
        active={...wide,width,height,unitsPerPixel:new Decimal(spacing)};
        await renderer.render(active); renderer.reproject({...wide,interacting:true});
      }
      const coarsePixels=await readCanvas();let lostFine=0;
      for(let y=0;y<48;y++)for(let x=0;x<64;x++){
        const at=y*finePixels.stride+x*4;
        if([0,1,2,3].some(k=>finePixels.bytes[at+k]!==coarsePixels.bytes[at+k]))lostFine++;
      }
      checks.push({ name: 'successive coarser fields retain the finest equal-coverage source',
        pass: lostFine===0, detail: { compared:64*48, changed:lostFine } });

      renderer.invalidateHistory();
      active={...wide,width:128,height:96,unitsPerPixel:new Decimal('.02'),centerX:wide.centerX.plus('.007')};
      await renderer.render(active); renderer.reproject(wide);
      const offGridPixels=await readCanvas();
      active=wide; await renderer.render(active); renderer.reproject(wide);
      const stationaryWithCoverage=await readCanvas(), savedCoverage=renderer.coverageHistory;
      renderer.coverageHistory=null; renderer.reproject(wide);
      const stationaryAlone=await readCanvas(); renderer.coverageHistory=savedCoverage;
      let stationaryChanged=0, distinguishable=0;
      for(let y=0;y<48;y++)for(let x=0;x<64;x++){
        const at=y*stationaryAlone.stride+x*4;
        if([0,1,2,3].some(k=>stationaryWithCoverage.bytes[at+k]!==stationaryAlone.bytes[at+k]))stationaryChanged++;
        if([0,1,2,3].some(k=>offGridPixels.bytes[at+k]!==stationaryAlone.bytes[at+k]))distinguishable++;
      }
      checks.push({ name: 'exact stationary field wins over finer off-grid retained coverage',
        pass: !!savedCoverage&&stationaryChanged===0&&distinguishable>0,
        detail: { compared:64*48, changed:stationaryChanged, distinctHistoricalPixels:distinguishable } });

      const { PLACES } = await import('/src/places.ts'), { direct } = await import('/qualification/numerical/direct.mjs');
      const deep = PLACES[2]; renderer.invalidateHistory();
      active = { ...request(deep.x), centerY: new Decimal(deep.y), unitsPerPixel: new Decimal(deep.span).div(24), maxIterations: deep.iterations, useApprox:true };
      await renderer.render(active); const firstBound = renderer.tableMaxDelta;
      active = { ...active, centerX: active.centerX.plus(new Decimal(deep.span).times('.2')), interacting: true };
      const expanded = await renderer.render(active), expandedView = renderer.fieldView, expandedField = await renderer.debugReadField();
      const exactView = { ...deep, x: expandedView.centerX.toString(), y: expandedView.centerY.toString(),
        span: expandedView.unitsPerPixel.times(expandedView.height).toString() };
      const numerical = [];
      for(let y=0;y<3;y++)for(let x=0;x<3;x++){
        const px=Math.floor((x+.5)*expandedView.width/3),py=Math.floor((y+.5)*expandedView.height/3);
        const a=direct(exactView,px,py,expandedView.width,expandedView.height,512),b=direct(exactView,px,py,expandedView.width,expandedView.height,768);
        const value=expandedField[2*(py*expandedView.width+px)];
        if(a!==b||value!==b)numerical.push({x:px,y:py,oracle512:a,oracle768:b,gpu:value});
      }
      checks.push({ name: 'BLA expands its bound for a moved field on a retained reference',
        pass: renderer.tableMaxDelta.gt(firstBound)&&renderer.tableMaxDelta.lt(firstBound.times(4))&&expanded.orbitMs===0&&expanded.skippedIterations>0&&expanded.computedSamples>0&&numerical.length===0,
        detail: { firstBound, expandedBound: renderer.tableMaxDelta, orbitMs: expanded.orbitMs,
          skippedIterations: expanded.skippedIterations, computedSamples: expanded.computedSamples, numerical } });
      // Crossing the existing geometric drift threshold refreshes the
      // reference even with the pointer held. Check the moved field directly.
      active = {...active,centerX:active.centerX.plus(new Decimal(deep.span).times('.4')),interacting:true};
      const moved=await renderer.render(active),movedField=await renderer.debugReadField();
      const movedView={...deep,x:active.centerX.toString(),y:active.centerY.toString(),span:deep.span};
      const movedErrors=[];
      for(let y=0;y<3;y++)for(let x=0;x<3;x++){
        const px=Math.floor((x+.5)*active.width/3),py=Math.floor((y+.5)*active.height/3);
        const a=direct(movedView,px,py,active.width,active.height,512),b=direct(movedView,px,py,active.width,active.height,768);
        if(a!==b||movedField[2*(py*active.width+px)]!==b)movedErrors.push({px,py,a,b,gpu:movedField[2*(py*active.width+px)]});
      }
      checks.push({name:'geometric reference refresh remains active during motion',pass:moved.orbitMs>0&&movedErrors.length===0,detail:{orbitMs:moved.orbitMs,movedErrors}});
      checks[0].pass = observations >= 3 && disagreements.length === 0;
      checks[0].detail.observations = observations;
      active = null;
      device.createCommandEncoder = createEncoder; queue.submit = submit;
      queue.onSubmittedWorkDone = wait; renderer.encodeBlit = blit;

      // Pure red/blue texels reveal invented interpolated colours directly.
      canvas.width = 16; canvas.height = 8;
      renderer.context.configure({ device, format: renderer.format, alphaMode: 'opaque',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      for (const width of [2, 32]) {
        const texture = device.createTexture({ size: [width, 1], format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const texels = new Uint8Array(width * 4);
        for (let x = 0; x < width; x++) texels.set(x % 2 ? [0,0,255,255] : [255,0,0,255], x*4);
        queue.writeTexture({ texture }, texels, { bytesPerRow: width*4 }, [width,1]);
        const buffer = device.createBuffer({ size: 256*8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = createEncoder(); blit(encoder, texture, new Float32Array([1,1,0,0]));
        encoder.copyTextureToBuffer({ texture: renderer.context.getCurrentTexture() }, { buffer, bytesPerRow: 256 }, [16,8]);
        submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(buffer.getMappedRange()); let mixed = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
          const p = y*256+x*4;
          if (bytes[p+1] !== 0 || !((bytes[p]===255 && bytes[p+2]===0) || (bytes[p]===0 && bytes[p+2]===255))) mixed++;
        }
        checks.push({ name: `nearest ${width===2?'magnification':'minification'} preserves source colours`, pass: mixed===0, detail: { mixedPixels: mixed } });
        buffer.unmap(); buffer.destroy(); texture.destroy();
      }
      device.destroy();
      return checks;
    });
  } finally { await page.close(); }
}
