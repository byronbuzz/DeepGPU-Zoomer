import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import ts from 'typescript';
import {describe,expect,it,vi} from 'vitest';
import {Camera,HOME} from '../src/state';
import {DEFAULT_COLORS} from '../src/logic/colorSettings';
import {WebGpuRenderer} from '../src/render/webgpu-renderer';

// Execute the actual handlers/functions with bounded DOM/GPU substitutes. No
// testing entry points are added to the application or its production bundle.
const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function fn(name:string){
  const declaration=ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);
  if(!declaration)throw Error(`Missing application function: ${name}`);
  return declaration.getText(ast);
}
function run(source:string,box:any){runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,box);}
function inputHarness(){
  const handlers:Record<string,Record<string,((e:any)=>void)[]>>={canvas:{},document:{}};
  const target=(name:string)=>({addEventListener(type:string,handler:(e:any)=>void){(handlers[name][type]??=[]).push(handler);}});
  const camera=new Camera();camera.load(HOME);
  const box:any=createContext({camera,canvas:target('canvas'),document:{...target('document'),hidden:false},
    HTMLElement:class {},keys:new Set(),heldKeyActions:new Map(),rotationKeys:new Set(),
    direction:0,dragging:false,rotating:false,rotationSliderHeld:false,controlDown:false,wheelDirection:0,
    rotationPointerAngle:null,selecting:false,speed:.8,pointer:{x:400,y:300},innerWidth:800,innerHeight:600,
    performance:{now:()=>1000},previousTime:1000,statusTime:1e9,frameTimes:[],frameCount:0,
    engine:undefined,requestAnimationFrame(){},changed(){},persist:vi.fn(),currentFieldComplete:()=>false,
    refinementTime:{heldCameraChange(){},stopHeld:vi.fn()},refiningStatus:{finish:vi.fn()},
    setRotation:(angle:number)=>camera.setAngle(angle),releasePointer(){},
    toggleJuliaPreview(){},switchJuliaView(){},message(){}});
  run(['keyIdentity','stop','finishRotation','tick'].map(fn).join('\n'),box);
  run(source.slice(source.indexOf("canvas.addEventListener('keydown'"),source.indexOf("window.addEventListener('blur'")),box);
  const send=(name:string,type:string,key='',properties={})=>{
    const event={key,code:key,ctrlKey:false,metaKey:false,altKey:false,repeat:false,target:{},preventDefault(){},...properties};
    for(const handler of handlers[name][type]??[])handler(event);
    if(name==='canvas'&&type!=='blur')for(const handler of handlers.document[type]??[])handler(event);
  };
  return {box,send};
}

describe('held input lifecycle through application handlers',()=>{
  it.each([true,false])('releases shifted zoom in either release order (Shift first: %s)',shiftFirst=>{
    const {box,send}=inputHarness();
    send('canvas','keydown','Shift',{code:'ShiftLeft',shiftKey:true});
    send('canvas','keydown','+',{code:'Equal',shiftKey:true});
    box.tick(1016);expect(box.camera.span.lt(HOME.span)).toBe(true);
    if(shiftFirst){
      send('canvas','keyup','Shift',{code:'ShiftLeft'});
      // A repeat after the modifier changes must not add a second held action.
      send('canvas','keydown','=',{code:'Equal',repeat:true});
      send('canvas','keyup','=',{code:'Equal'});
    }else{
      send('canvas','keyup','+',{code:'Equal',shiftKey:true});
      send('canvas','keyup','Shift',{code:'ShiftLeft'});
    }
    const span=box.camera.span.toString();box.tick(1032);
    expect(box.camera.span.toString()).toBe(span);
    expect(box.keys.size).toBe(0);expect(box.heldKeyActions.size).toBe(0);
  });
  it('clears movement on canvas focus loss before release on another control',()=>{
    const {box,send}=inputHarness();send('canvas','keydown','ArrowRight');box.tick(1016);
    send('canvas','blur');const x=box.camera.x.toString();box.tick(1032);
    send('document','keyup','ArrowRight');box.tick(1048);
    expect(box.camera.x.toString()).toBe(x);expect(box.keys.size).toBe(0);
  });
  it('also pairs release routed to the document and retains the layout-selected action',()=>{
    const {box,send}=inputHarness();
    send('canvas','keydown','+',{code:'BracketRight'});box.tick(1016);
    expect(box.camera.span.lt(HOME.span)).toBe(true);
    send('document','keyup','*',{code:'BracketRight'});
    const span=box.camera.span.toString();box.tick(1032);expect(box.camera.span.toString()).toBe(span);
  });
  it('keeps identical actions from separate keys held until both releases',()=>{
    const {box,send}=inputHarness();send('canvas','keydown','+',{code:'Equal'});send('canvas','keydown','+',{code:'NumpadAdd'});
    send('document','keyup','=',{code:'Equal'});expect(box.keys.has('+')).toBe(true);
    send('document','keyup','+',{code:'NumpadAdd'});expect(box.keys.size).toBe(0);
  });
  it.each([true,false])('preserves Ctrl rotation without leaking into pan (Ctrl first: %s)',controlFirst=>{
    const {box,send}=inputHarness();send('canvas','keydown','ArrowRight',{ctrlKey:true});box.tick(1016);
    expect(box.camera.angle).toBeGreaterThan(0);expect(box.camera.x.toString()).toBe(HOME.x);
    if(controlFirst){send('document','keyup','Control');send('canvas','keydown','ArrowRight',{repeat:true});send('document','keyup','ArrowRight');}
    else{send('document','keyup','ArrowRight',{ctrlKey:true});send('document','keyup','Control');}
    const angle=box.camera.angle;box.tick(1032);expect(box.camera.angle).toBe(angle);expect(box.keys.size).toBe(0);
  });
  it('Escape clears every held identity and ignores modified zoom shortcuts',()=>{
    const {box,send}=inputHarness();send('canvas','keydown','+',{code:'Equal',metaKey:true});expect(box.keys.size).toBe(0);
    send('canvas','keydown','+',{code:'Equal'});send('canvas','keydown','Escape');
    expect(box.keys.size).toBe(0);expect(box.heldKeyActions.size).toBe(0);
    send('canvas','keyup','=',{code:'Equal'});expect(box.keys.size).toBe(0);
  });
});

function pipelineHarness(){
  let rejectOld!:(reason:Error)=>void;
  const factory=vi.fn().mockImplementationOnce(()=>new Promise((_,reject)=>{rejectOld=reject;})).mockResolvedValue({});
  const renderer:any=Object.create(WebGpuRenderer.prototype);
  Object.assign(renderer,{ctx:{device:{createComputePipelineAsync:factory}},pendingPipelines:new Map(),renderModule:{},pipelineLayout:{},
    isComplete:()=>true,renderTarget:async()=>{await renderer.ensureComputePipeline('plain');return {completed:true,computed:true};}});
  const box:any=createContext({engine:renderer,busy:false,dirty:true,error:'',stopped:false,refreshPending:false,generation:1,
    camera:{revision:2},lastRevision:1,completedQuality:0,fields:0,recolours:0,stats:undefined,
    preparingColourData:false,refreshHolding:false,DOMException,performance,request:()=>({colors:DEFAULT_COLORS}),
    message:vi.fn(),captureStoppedPartial(){},refinementTime:{complete:vi.fn()}});
  run(fn('compute'),box);
  return {box,factory,reject:(error:Error)=>rejectOld(error)};
}
describe('obsolete pipeline errors through renderer and main lifecycle',()=>{
  it('lets a healthy new demand complete after a superseded pipeline rejects',async()=>{
    const {box,factory,reject}=pipelineHarness();const old=box.compute();
    expect(factory).toHaveBeenCalledOnce();box.generation++;
    reject(new Error('Injected obsolete pipeline compilation failure'));await old;
    expect(box.error).toBe('');expect(box.message).not.toHaveBeenCalled();expect(box.dirty).toBe(true);
    await box.compute();expect(factory).toHaveBeenCalledTimes(2);
    expect(box.fields).toBe(1);expect(box.completedQuality).toBe(1);expect(box.dirty).toBe(false);expect(box.busy).toBe(false);
  });
  it('keeps a current-demand pipeline error visible and blocks further computation',async()=>{
    const {box,factory,reject}=pipelineHarness();const current=box.compute();
    reject(new Error('Injected current pipeline compilation failure'));await current;await box.compute();
    expect(box.error).toContain('Injected current pipeline compilation failure');
    expect(box.message).toHaveBeenCalledWith(box.error);expect(factory).toHaveBeenCalledOnce();expect(box.fields).toBe(0);
  });
});

function retentionHarness(){
  let resolve!:(captured:boolean)=>void;
  const pending=new Promise<boolean>(done=>{resolve=done;});
  const box:any=createContext({engine:{retainDisplayedPartial:vi.fn(()=>pending),restartCalculation:vi.fn()},
    busy:false,generation:1,retainedRequest:{id:1},retainedPartialCaptured:false,
    refreshPending:true,stopSnapshotPending:true,dirty:false,stopped:false});
  run(['captureStoppedPartial','refreshCalculation'].map(fn).join('\n'),box);
  return {box,resolve,pending};
}
describe('main retained validation lifecycle',()=>{
  it('waits for retention validation before restarting refresh',async()=>{
    const {box,resolve}=retentionHarness();const refresh=box.refreshCalculation();
    expect(box.busy).toBe(true);expect(box.engine.restartCalculation).not.toHaveBeenCalled();
    expect(box.retainedRequest).not.toBeNull();expect(box.refreshPending).toBe(true);
    resolve(true);await refresh;
    expect(box.engine.restartCalculation).toHaveBeenCalledOnce();expect(box.retainedRequest).toBeNull();
    expect(box.refreshPending).toBe(false);expect(box.dirty).toBe(true);expect(box.busy).toBe(false);
  });
  it('also permits refresh after validation safely declines a snapshot',async()=>{
    const {box,resolve}=retentionHarness();const refresh=box.refreshCalculation();resolve(false);await refresh;
    expect(box.engine.restartCalculation).toHaveBeenCalledOnce();expect(box.retainedPartialCaptured).toBe(false);
  });
  it.each(['generation','cancelled'])('does not restart superseded refresh (%s)',async change=>{
    const {box,resolve}=retentionHarness();const original=box.retainedRequest,refresh=box.refreshCalculation();
    if(change==='generation')box.generation++;else box.refreshPending=false;
    resolve(true);await refresh;
    expect(box.engine.restartCalculation).not.toHaveBeenCalled();expect(box.retainedRequest).toBe(original);expect(box.busy).toBe(false);
  });
  it.each([true,false])('publishes stopped captured flag only after validation returns %s',async captured=>{
    const {box,resolve,pending}=retentionHarness();box.captureStoppedPartial();
    expect(box.retainedPartialCaptured).toBe(false);expect(box.stopSnapshotPending).toBe(false);
    expect(box.engine.retainDisplayedPartial).toHaveBeenCalledWith(box.retainedRequest,true);
    box.captureStoppedPartial();expect(box.engine.retainDisplayedPartial).toHaveBeenCalledOnce();
    resolve(captured);await pending;await Promise.resolve();expect(box.retainedPartialCaptured).toBe(captured);
  });
  it.each(['generation','identity'])('does not publish a stopped capture after %s changed',async change=>{
    const {box,resolve,pending}=retentionHarness();box.captureStoppedPartial();
    if(change==='generation')box.generation++;else box.retainedRequest={id:2};
    resolve(true);await pending;await Promise.resolve();expect(box.retainedPartialCaptured).toBe(false);
  });
  it('skips a redundant refresh capture after an already validated stopped snapshot',async()=>{
    const {box}=retentionHarness();box.retainedPartialCaptured=true;await box.refreshCalculation();
    expect(box.engine.retainDisplayedPartial).not.toHaveBeenCalled();expect(box.engine.restartCalculation).toHaveBeenCalledOnce();
  });
});
