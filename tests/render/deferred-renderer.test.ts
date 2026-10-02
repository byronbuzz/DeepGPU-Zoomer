import Decimal from 'decimal.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {WebGpuRenderer} from '../../src/render/webgpu-renderer';
import {CoverageRegions,PendingRegions,type Region} from '../../src/render/regions';
import {PendingContinuationSlot} from '../../src/render/pending-continuation';
import {BatchFeedback} from '../../src/render/batch-feedback';
import {CONTINUATION_DISPATCH_OPERATIONS} from '../../src/render/continuation';
import {DEFAULT_COLORS} from '../../src/logic/colorSettings';
import {DEFAULT_TUNING} from '../../src/tuning';

afterEach(()=>vi.unstubAllGlobals());
type Pass={kind:string;x:number;y:number;resume:boolean;operations:number;lanes:number;buffer?:any};
type Outcome={computed?:number;reused?:number;unfinished?:number};

/** Execute the actual renderer loop against scripted compute results. Buffer
 * copies and submissions retain their order; no shader or GPU is executed. */
function fixture(regions:Region[],outcome:(pass:Pass,index:number)=>Outcome){
  vi.stubGlobal('GPUBufferUsage',{UNIFORM:1,STORAGE:2,COPY_DST:4,COPY_SRC:8,MAP_READ:16});
  vi.stubGlobal('GPUMapMode',{READ:1});
  const buffers:any[]=[],passes:Pass[]=[],commands:string[]=[];
  const r:any=Object.create(WebGpuRenderer.prototype);
  let onRead:((pass:Pass)=>void)|undefined;
  const buffer=(d:any)=>{
    const value:any={...d,data:new ArrayBuffer(d.size),mapState:'unmapped',destroy:vi.fn(),
      mapAsync:async()=>{value.mapState='mapped';if(value.label==='continuation-counter-readback')onRead?.(passes.at(-1)!);},
      getMappedRange:()=>value.data,unmap:()=>{value.mapState='unmapped';}};
    buffers.push(value);return value;
  };
  const device:any={limits:{maxStorageBufferBindingSize:128*1024*1024,maxBufferSize:128*1024*1024,
      maxTextureDimension2D:8192,maxStorageBuffersPerShaderStage:8,maxComputeInvocationsPerWorkgroup:256,
      maxComputeWorkgroupSizeX:256,maxComputeWorkgroupSizeY:256},
    createBuffer:buffer,createBindGroup:(d:any)=>d,pushErrorScope:vi.fn(),popErrorScope:async()=>null,
    queue:{writeBuffer:(target:any,offset:number,data:ArrayBuffer|ArrayBufferView)=>{
      const bytes=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);
      new Uint8Array(target.data).set(bytes,offset);
    },submit:(submissions:Array<Array<()=>void>>)=>{for(const submission of submissions)for(const call of submission)call();},
    onSubmittedWorkDone:async()=>{}},
    createCommandEncoder:(descriptor:any={})=>{
      const calls:Array<()=>void>=[];commands.push(descriptor.label??'copy');
      return {copyBufferToBuffer:(from:any,fromOffset:number,to:any,toOffset:number,length:number)=>{
        calls.push(()=>new Uint8Array(to.data).set(new Uint8Array(from.data,fromOffset,length),toOffset));
      },beginComputePass:()=>{
        let pipeline:any;const bindings:any[]=[];
        return {setPipeline:(p:any)=>pipeline=p,setBindGroup:(i:number,b:any)=>bindings[i]=b,
          dispatchWorkgroups:()=>calls.push(()=>{
            const u=new Uint32Array(r.uniformBuffer.data),width=u[43]-u[42],height=u[26]-u[40],stride=u[54];
            const scratch=bindings[1]?.entries[0].resource.buffer;
            const control=scratch?new Uint32Array(scratch.data,0,4):undefined;
            const pass:Pass={kind:pipeline.kind,x:u[42],y:u[40],resume:!!control?.[1],operations:control?.[0]??0,
              lanes:Math.ceil(width/stride)*Math.ceil(height/stride),buffer:scratch};
            passes.push(pass);const result=outcome(pass,passes.length-1),stats=new Uint32Array(r.statsBuffer.data);
            stats[5]+=result.computed??0;stats[6]+=result.reused??0;stats[7]=result.unfinished??0;
          }),end:()=>{}};
      },finish:()=>calls};
    }};
  let remaining:Region[]=[];
  const pending={get size(){return remaining.length;},reset:()=>{remaining=regions.map(region=>({...region}));},
    settle:()=>{},take:vi.fn(()=>remaining.shift())};
  const tuning={...DEFAULT_TUNING,hardPixelCutoff:128,targetResidencyMs:100000};
  const width=Math.max(...regions.map(region=>region.x+region.width)),height=Math.max(...regions.map(region=>region.y+region.height));
  const request:any={family:'mandelbrot',centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal('1e-30'),
    width,height,maxIterations:10000,colors:{...DEFAULT_COLORS,mode:0,supersample:1,postAntialias:false,capped:0},
    useApprox:false,followView:true,interacting:false,zoom:0,tuning,isCurrent:()=>true};
  const uniformBuffer=buffer({label:'uniform',size:416}),statsBuffer=buffer({label:'stats',size:56});
  Object.assign(r,{ctx:{device},publicationEpoch:1,numericalQuadratic:false,disposed:false,deviceLost:false,
    directPipeline:{},shadePipeline:{},reusePipeline:{},blitPipeline:{},currentView:request,
    uniformBuffer,statsBuffer,stopsBuffer:buffer({label:'stops',size:16}),orbitBuffer:buffer({label:'orbit',size:96}),
    refX:new Decimal(0),refY:new Decimal(0),refLength:1,refSamples:new Float32Array(10),refValid:true,
    laBuffer:{},laIndexBuffer:{},laLevels:0,laHasUsableMultiStep:false,tableQuadratic:false,tableMaxDelta:new Decimal(1),
    retainEndpoints:false,endpointBuffer:buffer({label:'endpoints',size:16}),endpointCapacity:1,
    fieldKey:'old',sampleKey:'policy',fieldBuffer:null,fieldComplete:false,aborted:false,
    pending,pendingContinuation:new PendingContinuationSlot(),pendingDeferrals:[new PendingContinuationSlot(),new PendingContinuationSlot()],
    determined:new CoverageRegions(),partialSerial:0,streamTargets:0,calculationSubmissions:0,continuationCarried:0,continuationParked:0,
    ordinaryBatchCostKey:'',gpuBatchPolicy:'',gpuBatchCost:{msPerVisit:0},batchMsPerSample:0,batchCostKey:'',batchFeedback:new BatchFeedback(),
    predictionCost:{key:'',reference:null,table:null},predictionAnchor:null,
    deferredPassEstimate:{key:'',reference:null,table:null,msPerOperation:0,lastBudget:CONTINUATION_DISPATCH_OPERATIONS},
    timing:{supported:true,enabled:false,begin:()=>({}),writes:()=>undefined,resolve:()=>{},collect:(_sample:any,cb?:Function)=>cb?.(1)},
    recolorCompleted:async()=>null,beginAppearanceHold:()=>false,convertDistanceToIteration:async()=>false,
    affordableGrid:()=>1,preparationRequest:(value:any)=>value,referenceNeedsPreparation:()=>false,
    approximationPreparation:()=>({requiredDelta:new Decimal(1),deferred:false,needed:false}),
    ensureOrbitCapacity:()=>{},ensureComputePipeline:vi.fn(async()=>({kind:'ordinary'})),
    ensureDeferredPipeline:vi.fn(async()=>({kind:'deferred'})),ensureContinuationPipeline:vi.fn(async()=>({kind:'cold'})),
    workRequest:(value:any)=>value,requireLiveMethod:()=>{},requirePreparedInwardView:()=>{},
    fieldIdentity:()=> 'new-field',sampleIdentity:()=> 'policy',fillAppearance:()=>new Float32Array(4),
    moveField:()=>{r.fieldBuffer=buffer({label:'field',size:width*height*8});r.reuseMapping=null;},
    ensureTarget:async()=>{r.target={destroy:vi.fn()};},createRenderBind:()=>({}),
    regionDemand:()=>({x:0,y:0,zoom:0,covered:[],visible:{x:0,y:0,width,height}}),isInteracting:()=>false,
    encodeShadePass:vi.fn(),reproject:vi.fn(),snapshotFrame:(frame:any)=>({...frame}),
    candidateTexture:()=>({destroy:vi.fn()}),encodeCompletedSnapshot:()=>{},commitHistory:()=>{},
    samePresentation:()=>true,
  });
  return {r,request,passes,buffers,commands,pending,setRead:(callback:typeof onRead)=>{onRead=callback;},
    run:(next=request)=>r.renderTarget(next),scratch:()=>buffers.filter(b=>b.label==='deferred-region')};
}

const region=(x:number):Region=>({x,y:0,width:8,height:8,stride:1,order:x});

describe('deferred renderer lifecycle with ordered mock submissions',()=>{
  it('does not learn or publish a final slice canceled during its readback',async()=>{
    const f=fixture([region(0)],pass=>({computed:pass.lanes}));
    f.setRead(()=>{f.r.abortRequested=true;});
    const result=await f.run();
    expect(result.completed).toBe(false);expect(f.r.partialSerial).toBe(0);
    expect(f.r.batchMsPerSample).toBe(0);expect(f.r.gpuBatchCost.msPerVisit).toBe(0);
    expect(f.r.exactCompletedSamples).toBe(0);
    expect(f.scratch()).toHaveLength(1);expect(f.scratch()[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('interleaves a bounded pair, then drains both without duplicating admission counts',async()=>{
    const f=fixture([region(0),region(8),region(16)],pass=>pass.resume?{computed:pass.lanes}:{unfinished:pass.lanes});
    const result=await f.run();
    expect(result.completed).toBe(true);expect(result.computedSamples).toBe(192);
    expect(f.passes.map(p=>[p.x,p.resume])).toEqual([[0,false],[8,false],[0,true],[16,false],[8,true],[16,true]]);
    expect(f.r.exactCompletedSamples).toBe(192);expect(f.r.partialSerial).toBe(3);
    expect(f.scratch()).toHaveLength(2);
    for(const buffer of f.scratch())expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  it('preserves parked work when Off is selected and resumes with a bounded larger slice',async()=>{
    const f=fixture([region(0),region(8)],pass=>pass.x===0&&!pass.resume?{unfinished:pass.lanes}:{computed:pass.lanes});
    f.setRead(()=>{f.request.tuning={...f.request.tuning,hardPixelCutoff:0};});
    const result=await f.run();
    expect(result.completed).toBe(true);expect(result.computedSamples).toBe(128);
    expect(f.passes.map(p=>[p.kind,p.x,p.resume])).toEqual([['deferred',0,false],['cold',8,false],['deferred',0,true]]);
    expect(f.passes.at(-1)!.operations).toBe(4096);
    for(const buffer of f.scratch())expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not publish new detail for a retirement-only resume',async()=>{
    const overlapping={...region(0),stride:2};
    const f=fixture([overlapping,region(0)],pass=>pass.resume?{reused:pass.lanes}:pass.lanes===16?{unfinished:16}:{computed:64});
    const result=await f.run();
    expect(result.completed).toBe(true);expect(result.computedSamples).toBe(64);expect(result.reusedSamples).toBe(16);
    expect(f.r.partialSerial).toBe(1);
    expect(f.commands.filter(label=>label==='shade-deferred-completions')).toHaveLength(1);
    expect(f.r.exactCompletedSamples).toBe(64);
  });

  it('drains parked work when taking the last fresh region prunes it as already covered',async()=>{
    const coarse={...region(0),stride:2};
    const f=fixture([coarse,region(0),{...coarse,order:99}],pass=>
      pass.resume?{reused:pass.lanes}:pass.lanes===16?{unfinished:16}:{computed:64});
    const take=f.pending.take.getMockImplementation()!;
    const pruned=new PendingRegions();pruned.reset(8,8,2);
    // Select the exact obligation first, leaving only its coarse supplement.
    pruned.take(64,{x:0,y:0,zoom:0,covered:[]},undefined,{pointer:0,distributed:0,oldest:1,pointerRadius:64});
    f.pending.take.mockImplementation(()=>{
      const selected=take();
      return selected?.order===99?pruned.take(64,{x:0,y:0,zoom:0,covered:[{x:0,y:0,width:8,height:8,spacing:1}]}):selected;
    });
    const result=await f.run();
    expect(pruned.size).toBe(0);expect(f.pending.take).toHaveBeenCalledTimes(3);
    expect(result.completed).toBe(true);expect(result.computedSamples).toBe(64);expect(result.reusedSamples).toBe(16);
    expect(f.passes.map(p=>[p.lanes,p.resume])).toEqual([[16,false],[64,false],[16,true]]);
    expect(f.r.partialSerial).toBe(1);expect(f.r.exactCompletedSamples).toBe(64);
    for(const buffer of f.scratch())expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  it('transfers a compatible parked buffer to a new target without double-counting exact coverage',async()=>{
    const f=fixture([region(8),region(0)],(pass,index)=>index===0?{unfinished:pass.lanes}:{computed:pass.lanes});
    const next={...f.request,centerX:f.request.centerX.plus(f.request.unitsPerPixel),
      tuning:{...f.request.tuning,targetResidencyMs:0}};
    f.setRead(()=>{f.r.currentView=next;});
    expect((await f.run()).completed).toBe(false);
    const saved=f.scratch()[0];
    expect(f.r.pendingDeferrals[0].size).toBe(1);expect(saved.destroy).not.toHaveBeenCalled();
    f.setRead(undefined);
    const result=await f.run(next);
    expect(result.completed).toBe(true);expect(f.r.pendingDeferrals.map((slot:any)=>slot.size)).toEqual([0,0]);
    const resumed=f.passes.find(pass=>pass.resume)!;
    expect(resumed.x).toBe(7);expect(resumed.buffer).toBe(saved);
    expect(f.r.exactCompletedSamples).toBe(128);expect(f.r.continuationCarried).toBe(1);
    for(const buffer of f.scratch())expect(buffer.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a popped job once when resumed pipeline preparation rejects',async()=>{
    const f=fixture([region(0)],pass=>({unfinished:pass.lanes}));
    f.r.ensureDeferredPipeline.mockResolvedValueOnce({kind:'deferred'}).mockRejectedValueOnce(new Error('resume pipeline failed'));
    await expect(f.run()).rejects.toThrow('resume pipeline failed');
    expect(f.scratch()).toHaveLength(1);expect(f.scratch()[0].destroy).toHaveBeenCalledTimes(1);
  });

  it.each(['before','after'] as const)('joins timestamps delivered %s survivor readback before growing the next allowance',async order=>{
    const f=fixture([{...region(0),width:64,height:64}],(pass,index)=>
      index===0?{unfinished:pass.lanes}:{computed:pass.lanes});
    const callbacks:Array<(ms:number)=>void>=[],costsAtRead:number[]=[];
    f.r.timing.collect=(_sample:any,callback?:(ms:number)=>void)=>{
      if(callback){if(order==='before')callback(1);else callbacks.push(callback);}
    };
    f.request.betweenBatches=()=>{for(const callback of callbacks.splice(0))callback(1);};
    f.setRead(()=>costsAtRead.push(f.r.deferredPassEstimate.msPerOperation));
    const seed=f.request.tuning.publicationTargetMs/CONTINUATION_DISPATCH_OPERATIONS;
    const result=await f.run();
    expect(result.completed).toBe(true);expect(f.passes.map(pass=>pass.operations)).toEqual([128,256]);
    // A timestamp alone cannot train until its own survivor counter arrives.
    expect(costsAtRead[0]).toBe(seed);
    expect(f.r.deferredPassEstimate.msPerOperation).toBe(seed/2);
    // The completion-only second pass cannot underprice the next full batch.
    expect(f.r.deferredPassEstimate.lastBudget).toBe(128*4096);
    expect(f.r.exactCompletedSamples).toBe(4096);
  });
});
