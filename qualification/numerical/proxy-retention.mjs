// Synthetic presentation-only regression. No numerical render is invoked.
export async function proxyRetentionChecks(context, baseUrl) {
  const page = await context.newPage();
  await page.route('**/__proxy-retention-check', route => route.fulfill({contentType:'text/html',body:'<!doctype html><canvas width="64" height="48"></canvas>'}));
  try {
    await page.goto(new URL('/__proxy-retention-check',baseUrl).href);
    return await page.evaluate(async () => {
      const {default:Decimal}=await import('/node_modules/decimal.js/decimal.mjs'); Decimal.set({precision:160});
      const {acquireGpu}=await import('/src/gpu/device.ts');
      const {WebGpuRenderer}=await import('/src/render/webgpu-renderer.ts');
      const {reprojectionFor}=await import('/src/render/reprojection.ts');
      const {DEFAULT_COLORS}=await import('/src/logic/colorSettings.ts');
      const ctx=await acquireGpu(),device=ctx.device,queue=device.queue;
      const renderer=new WebGpuRenderer(ctx,document.querySelector('canvas')); await renderer.init();
      const errors=[],checks=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const W=64,H=48,base={family:'mandelbrot',maxIterations:96,colors:{...DEFAULT_COLORS},
        width:W,height:H,centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal('.01')};
      const texture=(label,data)=>{
        const value=device.createTexture({label,size:[W,H],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT});
        if(data)queue.writeTexture({texture:value},data,{bytesPerRow:W*4},[W,H]);return value;
      };
      const bytes=new Uint8Array(W*H*4);
      for(let y=0;y<H;y++)for(let x=0;x<W;x++)bytes.set([(x*37+y*11)%256,(x*13+y*47)%256,(x*71+y*3)%256,255],4*(y*W+x));
      const poison=bytes.slice();for(let p=3;p<poison.length;p+=4)poison[p]=0;
      const original=texture('unchanged-reference',bytes),empty=texture('empty-incoming',poison);
      const output=texture('readback-output');
      const read=async()=>{
        const buffer=device.createBuffer({size:W*H*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:output},{buffer,bytesPerRow:W*4},[W,H]);queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);const result=new Uint8Array(buffer.getMappedRange()).slice();buffer.unmap();buffer.destroy();return result;
      };
      const present=async(source,from,to)=>{
        const m=reprojectionFor(from,to,true);if(!m)throw Error('Comparison geometry unexpectedly unmappable');
        renderer.currentView=to;
        const encoder=device.createCommandEncoder();renderer.encodeBlit(encoder,source,new Float32Array([m.scaleX,m.scaleY,m.offsetX,m.offsetY]),output);queue.submit([encoder.finish()]);
        return read();
      };
      try {
        // Begin from inherited proxy pixels with no completed coverage source.
        // Otherwise the original coverage texture could conceal recursive drift.
        renderer.history=texture('initial-proxy',bytes);renderer.historyValid=true;
        renderer.lastFrame={...base,proxy:true,covered:{x:0,y:0,width:W,height:H}};
        renderer.historySize={width:W,height:H};renderer.coverageHistory=null;renderer.coverageFrame=null;
        renderer.target=empty;renderer.targetSize={width:W,height:H};renderer.partialRegions=1;renderer.determinedRegion=null;
        let compared=0,changed=0,missing=0,firstDifference=null;
        for(let step=1;step<=40;step++){
          const view={...base,centerX:base.unitsPerPixel.times(new Decimal('.4').times(step))};
          renderer.currentView=view;renderer.incomingFrame={...view};renderer.retainPartial();
          const inherited=await present(renderer.history,renderer.lastFrame,view);
          const expected=await present(original,base,view),m=reprojectionFor(base,view);
          for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){
            const u=(x+.5)/W*m.scaleX+m.offsetX,v=(y+.5)/H*m.scaleY+m.offsetY;
            if(u<=1/W||u>=1-1/W||v<=1/H||v>=1-1/H)continue;
            const p=4*(y*W+x);compared++;if(inherited[p+3]!==255)missing++;
            if([0,1,2,3].some(k=>inherited[p+k]!==expected[p+k])){changed++;firstDifference??={step,x,y,actual:[...inherited.slice(p,p+4)],expected:[...expected.slice(p,p+4)]};}
          }
        }
        checks.push({name:'40 fractional pans preserve untouched inherited pixels against original reprojection',pass:compared>0&&changed===0&&missing===0,
          detail:{steps:40,pixelsPerStep:.4,compared,changed,missing,firstDifference}});

        // Force the old proxy beyond the accepted mapping range. Empty incoming
        // pixels must remain holes. Read compositor RGB as well as alpha: the
        // production canvas is opaque and therefore displays emitted RGB.
        const distant={...base,centerX:base.unitsPerPixel.times(W*20)};
        const previous=renderer.lastFrame;renderer.currentView=distant;renderer.incomingFrame={...distant};renderer.determinedRegion=null;renderer.partialRegions=1;
        const oldMapping=reprojectionFor(previous,distant);renderer.retainPartial();
        const blank=await present(renderer.history,renderer.lastFrame,distant);
        let opaque=0,staleRGB=0;for(let p=0;p<blank.length;p+=4){if(blank[p+3])opaque++;if(blank[p]||blank[p+1]||blank[p+2])staleRGB++;}
        const covered=renderer.lastFrame.covered,area=covered?covered.width*covered.height:0;
        checks.push({name:'unmappable history and transparent RGB cannot leak through opaque presentation',pass:oldMapping===null&&opaque===0&&staleRGB===0&&area===0,
          detail:{mappingWasNull:oldMapping===null,opaque,staleRGB,coverageArea:area}});
        // A very broad completed source is still useful behind partial detail;
        // the normal magnification cutoff must not create holes on reversal.
        const close={...base,unitsPerPixel:base.unitsPerPixel.div(128)};
        renderer.history=texture('transparent-proxy',poison);renderer.historyValid=true;
        renderer.lastFrame={...close,proxy:true};renderer.incomingFrame=null;
        renderer.coverageFrame=base;renderer.coverageHistory=original;
        const fallback=await present(renderer.history,renderer.lastFrame,close);
        const coarse=await present(original,base,close);let disagreements=0,holes=0;
        for(let p=0;p<fallback.length;p+=4){if(fallback[p+3]===0)holes++;if([0,1,2].some(k=>fallback[p+k]!==coarse[p+k]))disagreements++;}
        checks.push({name:'broad completed coverage fills holes beyond the normal magnification cutoff',
          pass:reprojectionFor(base,close)===null&&holes===0&&disagreements===0,detail:{compared:W*H,holes,disagreements}});
        // Retention must preserve small positive density; byte alpha would
        // round this broad source to zero and erase it on the second snapshot.
        const veryClose={...base,unitsPerPixel:base.unitsPerPixel.div(1024)};
        renderer.retainedAnchor=null;renderer.historyValid=true;renderer.history=original;renderer.lastFrame=base;
        renderer.coverageFrame=null;renderer.coverageHistory=null;
        renderer.currentView=veryClose;renderer.incomingFrame=veryClose;renderer.target=empty;
        renderer.partialRegions=1;renderer.determinedRegion=null;renderer.retainPartial();
        const expectedBroad=await present(original,base,veryClose);
        renderer.coverageFrame=null;renderer.coverageHistory=null;
        renderer.currentView=veryClose;renderer.incomingFrame=veryClose;renderer.retainPartial();
        renderer.incomingFrame=null;
        const retainedBroad=await present(renderer.history,renderer.lastFrame,veryClose);let dropped=0;const differences=[];
        for(let p=0;p<retainedBroad.length;p+=4)if([0,1,2].some(k=>retainedBroad[p+k]!==expectedBroad[p+k])){
          dropped++;if(differences.length<4)differences.push({x:p/4%W,y:Math.floor(p/4/W),actual:[...retainedBroad.slice(p,p+4)],expected:[...expectedBroad.slice(p,p+4)]});
        }
        checks.push({name:'1024x broad source survives repeated proxy retention',pass:dropped===0,detail:{compared:W*H,dropped,differences}});
        // Coarser incoming actual anchors have alpha one too. While moving,
        // they must not beat finer retained source pixels simply by being new.
        const red=new Uint8Array(W*H*4);for(let p=0;p<red.length;p+=4)red.set([255,0,0,255],p);
        renderer.history=texture('fine-proxy',bytes);renderer.lastFrame={...base,proxy:true};renderer.historyValid=true;
        renderer.coverageFrame=null;renderer.coverageHistory=null;
        renderer.target=texture('coarser-incoming',red);renderer.incomingFrame={...base,unitsPerPixel:base.unitsPerPixel.times(2)};
        const chosen=await present(renderer.history,renderer.lastFrame,base);let replaced=0;
        for(let p=0;p<chosen.length;p+=4)if([0,1,2].some(k=>chosen[p+k]!==bytes[p+k]))replaced++;
        checks.push({name:'coarser incoming anchors cannot replace finer retained pixels',pass:replaced===0,detail:{compared:W*H,replaced}});
        await queue.onSubmittedWorkDone();checks.push({name:'proxy retention has no GPU validation errors',pass:errors.length===0,detail:{errors}});return checks;
      } finally {device.destroy();}
    });
  } finally {await page.close();}
}
