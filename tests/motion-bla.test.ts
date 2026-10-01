import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {WebGpuRenderer,Method,effectiveBlaEpsilon,blaTableEpsilon,linearBlaPolicy,
  appearanceUpgradeCompatible,type RenderRequest} from '../src/render/webgpu-renderer';
import * as bla from '../src/render/bla';
import {automaticCapRemap} from '../src/render/cap-reuse';
import {PendingContinuationSlot} from '../src/render/pending-continuation';
import {snapshotExportRequest} from '../src/export/render';
import {DEFAULT_COLORS} from '../src/logic/colorSettings';
import {DEFAULT_TUNING} from '../src/tuning';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const request=(extra:Partial<RenderRequest>={}):RenderRequest=>({
  centerX:new Decimal('-.7'),centerY:new Decimal('.1'),unitsPerPixel:new Decimal('1e-20'),
  width:64,height:64,maxIterations:10000,family:'mandelbrot',useApprox:true,forceMethod:Method.Hdr,
  colors:{...DEFAULT_COLORS,mode:0,capped:0,effect:0,supersample:1,postAntialias:false},
  tuning:{...DEFAULT_TUNING},followView:true,workView:true,interacting:true,zoom:1,isCurrent:()=>true,...extra,
});

// Use the actual captured frame, including its stored precision policy, rather
// than supplying a more complete identity than production records.
const rendererSource=readFileSync(new URL('../src/render/webgpu-renderer.ts',import.meta.url),'utf8');
const frameStart=rendererSource.indexOf('const frame = {',rendererSource.indexOf('private async renderTarget('));
if(frameStart<0)throw Error('The renderer frame capture could not be located');
const frameLiteral=rendererSource.slice(rendererSource.indexOf('{',frameStart),rendererSource.indexOf('};',frameStart)+1);
const capturedFrame=new Function('request','colors','method','grid',`return (${frameLiteral});`) as
  (request:RenderRequest,colors:RenderRequest['colors'],method:Method,grid:number)=>any;
function owner(q=request()):any{
  const frame=capturedFrame(q,q.colors,q.forceMethod??Method.Hdr,1);
  return Object.assign(Object.create(WebGpuRenderer.prototype),{
    ctx:{device:{limits:{maxStorageBufferBindingSize:256*1024*1024,maxBufferSize:256*1024*1024,maxTextureDimension2D:8192}}},
    publicationEpoch:1,refLength:10001,refLimbs:8,refSamples:{},orbitBuffer:{},laBuffer:{},laIndexBuffer:{},
    refValid:true,refEscaped:true,refFamily:'mandelbrot',refConstant:'',refIterations:10000,refX:q.centerX,refY:q.centerY,
    tableQuadratic:false,tableEpsilonLog2:effectiveBlaEpsilon(q),tableMaxDelta:new Decimal(1),laHasUsableMultiStep:true,
    fieldView:q,fieldComplete:true,currentImageValid:true,currentView:q,completedFrame:frame,
    historyValid:true,fieldUniforms:new ArrayBuffer(416),fieldStats:{},target:{},fieldBuffer:{},endpointBuffer:{},
    retainEndpoints:false,fieldKey:'complete',
    fieldDescriptor:{family:q.family,constant:'',maxIterations:q.maxIterations,mode:q.colors.mode,grid:1,
      method:q.forceMethod??Method.Hdr,useApprox:q.useApprox===true,retainEndpoints:false,interiorEndpoints:false,
      linearBlaEpsilon:linearBlaPolicy(q,q.forceMethod??Method.Hdr)},
  });
}
const sampleKey=(r:any,q:RenderRequest)=>r.sampleIdentity(q,q.family??'mandelbrot','',q.forceMethod??Method.Hdr,1,8,20);
const fieldKey=(r:any,q:RenderRequest)=>r.fieldIdentity(q,q.family??'mandelbrot','',q.forceMethod??Method.Hdr,1,false,20);

describe('one BLA precision throughout motion and rest',()=>{
  it.each([-32,-21,-16,-14])('uses selected precision %s across motion, rest and export',precision=>{
    const q=request({tuning:{...DEFAULT_TUNING,blaPrecisionLog2:precision}});
    for(const extra of [{zoom:1},{zoom:-1},{zoom:0},{interacting:false},{followView:false},{exportDomain:{width:64,height:64,x:0,y:0}}]){
      expect(effectiveBlaEpsilon({...q,...extra})).toBe(precision);
    }
    expect(blaTableEpsilon({...q,family:'julia'})).toBe(-40);
    expect(blaTableEpsilon(q,true)).toBe(-29);
    expect(linearBlaPolicy(q,Method.Direct)).toBeUndefined();
    expect(linearBlaPolicy({...q,useApprox:false},Method.Hdr)).toBeUndefined();
  });

  it.each([1,-1])('keeps actual captured direction %s samples valid after same-camera release',zoom=>{
    const beforePreparation=vi.fn(()=>11000),q=request({zoom,dynamicIterations:true,beforePreparation});
    const released={...q,zoom:0},rested={...released,interacting:false},r=owner(q),frame=r.completedFrame;
    expect(effectiveBlaEpsilon(frame)).toBe(-16);expect(r.isComplete(q)).toBe(true);
    for(const next of [released,rested]){
      expect(sampleKey(r,q)).toBe(sampleKey(r,next));expect(fieldKey(r,q)).toBe(fieldKey(r,next));
      expect(r.isComplete(next)).toBe(true);expect(r.samePresentation(frame,next)).toBe(true);
      expect(r.fieldSupportsAppearance(next,Method.Hdr,1)).toBe(true);
      expect(appearanceUpgradeCompatible(frame,next,Method.Hdr,1)).toBe(true);
      expect(r.capUpgradeBase({...next,maxIterations:11000})).toBe(frame);
      r.currentView=next;expect(()=>r.requireLiveMethod(q)).not.toThrow();
      expect(r.approximationPreparation(next).needed).toBe(false);
      expect(r.preparationRequest(next,8)).toBe(next);
    }
    expect(beforePreparation).not.toHaveBeenCalled();
  });

  it('preserves compatible cap reuse and carried scratch through release',()=>{
    const q=request(),released={...q,zoom:0,maxIterations:11000},r=owner(q),reference={},table={};
    const policy=(v:RenderRequest)=>sampleKey(r,{...v,maxIterations:0});
    const admitted=(v:RenderRequest)=>({view:v,policy:policy(v),maxIterations:v.maxIterations,ordinary:true,reference,approximation:table});
    expect(automaticCapRemap(admitted(q),admitted({...q,maxIterations:11000}),true)).not.toBeNull();
    expect(automaticCapRemap(admitted(q),admitted(released),true)).not.toBeNull();
    const slot=new PendingContinuationSlot(),destroy=vi.fn();
    const identity={epoch:1,policy:policy(q),reference,orbit:r.orbitBuffer,table,index:r.laIndexBuffer};
    slot.park({scratch:{destroy} as any,capacity:832,region:{x:0,y:0,width:1,height:1,stride:1,order:0},view:q,identity,unfinished:1,operations:256});
    const claimed=slot.claim({...identity,policy:policy(released)},released);
    expect(claimed?.scratch.destroy).toBe(destroy);expect(destroy).not.toHaveBeenCalled();expect(slot.size).toBe(0);
  });

  it('freezes the same export precision independently of later live changes',()=>{
    const beforePreparation=vi.fn(()=>11000),q=request({beforePreparation}),r=owner(q),snapshot=snapshotExportRequest(q);
    expect(effectiveBlaEpsilon(snapshot)).toBe(-16);expect(snapshot).toMatchObject({followView:false,interacting:false,zoom:0});
    expect(snapshot.beforePreparation).toBeUndefined();
    expect(r.isComplete(snapshot)).toBe(true);expect(r.fieldSupportsAppearance(snapshot,Method.Hdr,1)).toBe(true);
    expect(appearanceUpgradeCompatible(r.completedFrame,snapshot,Method.Hdr,1)).toBe(true);
    (q.tuning as any).blaPrecisionLog2=-32;
    expect(snapshot.tuning?.blaPrecisionLog2).toBe(-16);expect(effectiveBlaEpsilon(snapshot)).toBe(-16);
    expect(beforePreparation).not.toHaveBeenCalled();
  });

  it.each(['release-during-build','release-during-upload','enter-during-upload','precision-during-build','precision-during-upload'] as const)(
      'keeps preparation valid for motion alone and cancels changed precision: %s',async transition=>{
    vi.stubGlobal('GPUBufferUsage',{STORAGE:128,COPY_DST:8});
    const precisionChanged=transition.startsWith('precision'),duringBuild=transition.endsWith('build');
    const q=request({zoom:transition==='enter-during-upload'?0:1});
    const next=precisionChanged?{...q,tuning:{...DEFAULT_TUNING,blaPrecisionLog2:-24}}:{...q,zoom:transition==='enter-during-upload'?1:0};
    const r=owner(q);
    const oldTable={destroy:vi.fn()},oldIndex={destroy:vi.fn()},created:any[]=[];
    Object.assign(r,{refSamples:new Float32Array(30),refLength:3,refSampleWords:10,refX:q.centerX,refY:q.centerY,
      laBuffer:oldTable,laIndexBuffer:oldIndex,laLevels:7,laHasUsableMultiStep:true,tableMaxDelta:new Decimal(1),
      tableQuadratic:false,tableEpsilonLog2:effectiveBlaEpsilon(q),tableMs:17,pendingContinuation:{clear:vi.fn()}});
    const epsilon=r.tableEpsilonLog2;
    vi.spyOn(bla,'buildBlaAsync').mockImplementation(async(_samples,_length,_radius,checkpoint,options)=>{
      expect(options?.epsilonLog2).toBe(epsilon);
      if(duringBuild){r.currentView=next;await checkpoint();}
      return {data:new Float32Array(12),levelOffsets:[0],levelCounts:[1],levels:1,entryCount:1,hasUsableMultiStep:true};
    });
    Object.assign(r.ctx.device,{pushErrorScope:()=>{},popErrorScope:async()=>null,
      createBuffer:({size,label}:{size:number;label:string})=>{const buffer={label,size,destroy:vi.fn()};created.push(buffer);return buffer;},
      queue:{writeBuffer:(buffer:any)=>{if(buffer.label==='la-table')r.currentView=next;}}});
    if(precisionChanged){
      await expect(r.buildApproxTable(q)).rejects.toThrow();
      expect(r.laBuffer).toBe(oldTable);expect(r.laIndexBuffer).toBe(oldIndex);
      expect(r.tableEpsilonLog2).toBe(epsilon);expect(r.laLevels).toBe(7);expect(r.tableMs).toBe(17);
      expect(oldTable.destroy).not.toHaveBeenCalled();expect(oldIndex.destroy).not.toHaveBeenCalled();
      expect(r.pendingContinuation.clear).not.toHaveBeenCalled();
      expect(created).toHaveLength(duringBuild?0:2);
      for(const buffer of created)expect(buffer.destroy).toHaveBeenCalledOnce();
    }else{
      await r.buildApproxTable(q);
      expect(created).toHaveLength(2);expect(r.laBuffer).toBe(created[0]);expect(r.laIndexBuffer).toBe(created[1]);
      expect(r.tableEpsilonLog2).toBe(epsilon);expect(r.laLevels).toBe(1);
      expect(oldTable.destroy).toHaveBeenCalledOnce();expect(oldIndex.destroy).toHaveBeenCalledOnce();
      expect(r.pendingContinuation.clear).toHaveBeenCalledOnce();
      for(const buffer of created)expect(buffer.destroy).not.toHaveBeenCalled();
    }
  });
});
