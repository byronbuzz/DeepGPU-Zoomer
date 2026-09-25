import Decimal from 'decimal.js';
import { DEFAULT_TUNING } from '../tuning';
import type { GpuContext } from '../gpu/device';
import { WebGpuRenderer, type RenderRequest } from '../render/webgpu-renderer';
import { needsEndpoints } from '../logic/colorSettings';
import { frameForExport, planExport } from './layout';
import { createStreamingPng } from './png';
export interface ExportChoice { width:number; height:number }

/** Freeze view and appearance before any permission, GPU or encoding await. */
export function snapshotExportRequest(request:RenderRequest):RenderRequest {
  const clone=(value:Decimal|undefined)=>value===undefined?undefined:new Decimal(value);
  return {...request,centerX:new Decimal(request.centerX),centerY:new Decimal(request.centerY),
    unitsPerPixel:new Decimal(request.unitsPerPixel),juliaX:clone(request.juliaX),juliaY:clone(request.juliaY),
    colors:{...request.colors,stops:[...request.colors.stops],positions:request.colors.positions?.slice(),locks:request.colors.locks?.slice()},
    // Tiled export uses the ordinary complete-sample path. Continuation's local
    // coordinate scratch protocol is deliberately outside this export port.
    tuning:{...(request.tuning??DEFAULT_TUNING),hardPixelBudget:0},
    followView:false,publishPartial:false,dynamicIterations:false,provisionalNavigationCap:false,
    betweenBatches:undefined,isCurrent:undefined,isCalculationCurrent:undefined,focus:undefined,zoom:0,
    interacting:false,overscanPixels:undefined,workView:undefined,exportDomain:undefined,tileRows:undefined};
}

/** One private renderer, one full-output reference domain, sequential bounded strips. */
export async function renderPng(ctx:GpuContext,snapshot:RenderRequest,choice:ExportChoice,signal:AbortSignal,progress:(text:string)=>void):Promise<Blob>{
  snapshot=snapshotExportRequest(snapshot);
  choice={...choice};
  signal.throwIfAborted();
  if(typeof CompressionStream==='undefined')throw Error('This browser cannot encode streaming PNG files.');
  const colors=snapshot.colors;
  const plan=planExport(choice.width,choice.height,{
    limits:ctx.device.limits,sampleGrid:colors.supersample,
    endpointBytesPerSample:needsEndpoints(colors)||colors.mode===1?16:0,
    halo:colors.postAntialias?6:1,
  });
  const unitsPerPixel=frameForExport(snapshot,choice.width,choice.height);
  const surface=document.createElement('canvas');
  const renderer=new WebGpuRenderer(ctx,surface);
  const abort=()=>renderer.abort();signal.addEventListener('abort',abort,{once:true});
  let writer:ReturnType<typeof createStreamingPng>|undefined;
  try{
    progress('Preparing export…');await renderer.init();signal.throwIfAborted();
    writer=createStreamingPng(choice.width,choice.height,{maxEncodedBytes:plan.maxEncodedBytes,signal});
    let done=0;
    for(const strip of plan.strips()){
      signal.throwIfAborted();
      const rows=new Uint8Array(choice.width*strip.height*4);
      for(const tile of strip.tiles){
        signal.throwIfAborted();
        const {padded,core}=tile;
        surface.width=padded.width;surface.height=padded.height;
        const request:RenderRequest={...snapshot,colors,unitsPerPixel,width:padded.width,height:padded.height,
          exportDomain:{width:choice.width,height:choice.height,x:padded.x,y:padded.y},
          followView:false,publishPartial:false,dynamicIterations:false,provisionalNavigationCap:false,interacting:false,betweenBatches:undefined,focus:undefined,zoom:0,
          isCurrent:()=>!signal.aborted,isCalculationCurrent:()=>!signal.aborted};
        progress(`Rendering tile ${done+1} of ${plan.tileCount}…`);
        const result=await renderer.render(request);signal.throwIfAborted();
        if(!result.completed)throw Error('Export tile did not complete.');
        const frame=await renderer.capturePixels(request);signal.throwIfAborted();
        for(let row=0;row<core.height;row++){
          const from=((core.y-padded.y+row)*padded.width+core.x-padded.x)*4;
          rows.set(frame.pixels.subarray(from,from+core.width*4),((core.y-strip.y+row)*choice.width+core.x)*4);
        }
        done++;
      }
      progress(`Encoding rows ${strip.y+1}–${strip.y+strip.height} of ${choice.height}…`);
      await writer.appendRows(rows);signal.throwIfAborted();
      // Yield even cheap tiles/encoding so a pending Cancel can run before more work.
      await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
    signal.throwIfAborted();progress('Finishing PNG…');
    const blob=await writer.finish();signal.throwIfAborted();return blob;
  }finally{
    signal.removeEventListener('abort',abort);
    try{await writer?.cancel();}finally{await renderer.dispose();surface.width=surface.height=1;}
  }
}
