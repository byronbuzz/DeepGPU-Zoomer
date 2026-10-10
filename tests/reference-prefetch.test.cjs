// Execute actual production prefetch/foreground/cancellation methods. GPU work
// stops at checkedGpu; numerical worker suffixes and CPU BLA tables are real.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),ts=require(root+'/node_modules/typescript'),Decimal=require(root+'/node_modules/decimal.js');
// Production raises Decimal precision before planning deep numerical geometry.
Decimal.set({precision:200});
const modules=new Map();
function load(file){
 file=path.resolve(root,file);if(!path.extname(file))file+='.ts';
 if(modules.has(file))return modules.get(file);
 const exports={};modules.set(file,exports);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','require',code)(exports,name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(root+'/node_modules/'+name));return exports;
}
const orbit=load('src/render/reference-orbit'),{prepareReference,REFERENCE_TRANSFER_FLOATS}=load('src/render/reference-preparation');
const {ReferenceOrbitCache}=load('src/render/reference-cache'),{BlaTableCache}=load('src/render/bla-cache'),{buildBlaAsync,ENTRY_FLOATS}=load('src/render/bla');
const {DEFAULT_TUNING,mandelbrotBlaEpsilon}=load('src/tuning'),{needsEndpoints}=load('src/logic/colorSettings');
const {coordinateToFixed}=load('src/coordinate'),{CoverageRegions}=load('src/render/regions');
const {createSampleGridAnchor}=load('src/render/sample-grid');
const {planNumericalView,containsNumericalView,outwardPadding,outwardHorizonMs}=load('src/render/numerical-grid');
const {oversampledView}=load('src/render/quality');
const {ExactGeometryCache}=load('src/render/exact-geometry-cache');
const sourceFile=path.join(root,'src/render/webgpu-renderer.ts');
const sf=ts.createSourceFile(sourceFile,fs.readFileSync(sourceFile,'utf8'),ts.ScriptTarget.Latest,true);
const renderer=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='WebGpuRenderer');
const methods=['referenceBudget','referenceDemand','referenceDemandCompatible','prefetchCompatible','startReferencePrefetch',
 'generateOrbit','cancelPendingReference','trackOperation','abort','dispose','clearContinuationWork','reproject','workRequest'];
const actual=methods.map(name=>{
 const node=renderer.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.text===name);assert.ok(node,`production ${name}`);return node.getText(sf);
}).join('\n');
const globals=['renderDomain','methodForScale','limbsForScale','referenceViewportRadius','approximationDeltaBound','effectiveBlaEpsilon','blaTableEpsilon'];
const declarations=globals.map(name=>{
 const node=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node,`production ${name}`);return node.getText(sf);
});
declarations.push(sf.statements.find(n=>ts.isEnumDeclaration(n)&&n.name.text==='Method').getText(sf));
declarations.push(sf.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf)==='LIMB_PROFILES')).getText(sf));
declarations.push(sf.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf)==='viewportRadii')).getText(sf));
const compiled=ts.transpileModule(`${declarations.join('\n')}\nclass Probe {${actual}}\nexports.Probe=Probe;`,
 {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const boundary=new Error('GPU boundary');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function view(changes={}){
 return {centerX:new Decimal('.25'),centerY:new Decimal(0),unitsPerPixel:new Decimal('1e-33'),width:32,height:24,
  family:'mandelbrot',juliaX:new Decimal(0),juliaY:new Decimal(0),maxIterations:128,useApprox:true,
  colors:{mode:0,supersample:1,capped:0},tuning:{...DEFAULT_TUNING,blaPrecisionLog2:-24},
  followView:true,interacting:true,heldInwardZoom:true,zoom:1,zoomRate:2,focus:{x:.5,y:.5},isCurrent:()=>true,...changes};
}
function makeProbe(options={}){
 const calls=[],cancelled=[],yieldReached=deferred(),yieldGate=deferred();
 let hold=!!options.holdWorker,fail=options.failOnce,heldYield=false,gpuEntries=0,fences=0;
 const worker={current:null,get active(){return this.current!==null;},generate(input,resume,budget){
  assert.equal(this.active,false,'single production worker cannot accept overlapping jobs');
  const gate=deferred(),call={input:{...input},resume,budget,gate,cancelled:false};calls.push(call);this.current=call;
  if(!hold){if(fail){const error=fail;fail=null;gate.reject(error);}else gate.resolve(orbit.generatePackedReference(input,resume,Math.min(budget,options.chunkLimit??71)));}
  return gate.promise.finally(()=>{if(this.current===call)this.current=null;});
 },cancel(message){
  cancelled.push(message);const call=this.current;this.current=null;
  if(call){call.cancelled=true;call.gate.reject(new DOMException(message,'AbortError'));}
 }};
 const context={exports:{},performance,DOMException,Set,Map,Float32Array,Uint32Array,ArrayBuffer,Decimal,ExactGeometryCache,
  DEFAULT_TUNING,mandelbrotBlaEpsilon,needsEndpoints,coordinateToFixed,CoverageRegions,
  createSampleGridAnchor,planNumericalView,containsNumericalView,outwardPadding,outwardHorizonMs,oversampledView,
  MAX_REFERENCE_ITERATIONS:orbit.MAX_REFERENCE_ITERATIONS,REFERENCE_CHUNK_ITERATIONS:orbit.REFERENCE_CHUNK_ITERATIONS,
  REFERENCE_FORMAT_VERSION:orbit.REFERENCE_FORMAT_VERSION,REFERENCE_TRANSFER_FLOATS,referenceIdentity:orbit.referenceIdentity,
  prepareReference,buildBlaAsync,ENTRY_FLOATS,
  yieldToEvents:async()=>{
   if(options.holdFirstYield&&!heldYield){heldYield=true;yieldReached.resolve();await yieldGate.promise;}
  },
  checkedGpu:()=>{gpuEntries++;throw boundary;},
 };
 vm.runInNewContext(compiled,context);
 const e=new context.exports.Probe(),base=view(options.view),limbs=context.limbsForScale(base.unitsPerPixel,96),
  oldInput={family:'mandelbrot',centerX:coordinateToFixed(base.centerX),centerY:coordinateToFixed(base.centerY),
  juliaX:'0',juliaY:'0',limbs,maxIterations:128};
 const old=orbit.generatePackedReference(oldInput),samples=new Float32Array(old.buffer);
 const referenceCache=new ReferenceOrbitCache(4,128*1024*1024),blaCache=new BlaTableCache();
 referenceCache.remember(oldInput,{...old,samples});
 Object.assign(e,{ctx:{device:{limits:{maxStorageBufferBindingSize:2**28,maxBufferSize:2**28,maxTextureDimension2D:8192,...options.limits},
  queue:{onSubmittedWorkDone:async()=>{fences++;}},destroy:()=>{throw Error('shared device cannot be destroyed');}}},
  referenceWorker:worker,referenceCache,blaCache,referencePrefetch:null,pendingReferenceDemand:null,referencePreparing:false,
  refValid:true,refLimbs:limbs,refFamily:'mandelbrot',refConstant:'',refIterations:128,refX:base.centerX,refY:base.centerY,
  refSamples:samples,refTerminal:old.terminal,refFormatVersion:old.formatVersion,refSampleWords:old.sampleWords,refLength:old.length,refEscaped:false,
  orbitBuffer:{destroy:()=>{}},laBuffer:{destroy:()=>{}},laIndexBuffer:{destroy:()=>{}},laLevels:7,
  currentView:base,disposed:false,abortRequested:false,deviceLost:false,publicationEpoch:0,
  activeOperations:new Set(),pendingPipelines:new Map(),ordinaryShapePipelines:new Map(),lossHook:{notify:()=>{}},
  pendingContinuation:{clear:()=>{}},pending:{reset:()=>{}},timing:{dispose:()=>{}},context:{unconfigure:()=>{}},
  ensureComputePipeline:async()=>{},inwardPreparationContinues:()=>false,
  validateCoordinates:()=>{},capUpgradeBase:()=>false,appearanceHoldActive:()=>false,
  currentImageValid:false,completedFrame:null,historyValid:false,lastFrame:null,incomingFrame:null,blitPipeline:null,
  numericalAnchor:createSampleGridAnchor(base),numericalView:null,numericalGuardMs:0,outwardBatchDelayMs:0,
 });
 return {e,base,worker,calls,cancelled,yieldReached,yieldGate,gpuEntries:()=>gpuEntries,fences:()=>fences,
  releaseWorker(){hold=false;const c=worker.current;if(c)c.gate.resolve(orbit.generatePackedReference(c.input,c.resume,Math.min(c.budget,options.chunkLimit??71)));},
 };
}
function gpuState(e){return {orbit:e.orbitBuffer,table:e.laBuffer,index:e.laIndexBuffer,levels:e.laLevels,
 samples:e.refSamples,terminal:e.refTerminal,limbs:e.refLimbs,x:e.refX,y:e.refY};}
function begin(p){p.e.startReferencePrefetch(p.base);assert.ok(p.e.referencePrefetch,'next profile speculation starts');return p.e.referencePrefetch;}
function firstFuture(p,job,change={}){return {...p.base,unitsPerPixel:job.demand.view.unitsPerPixel.times('1.99'),...change};}

test('finite forecast predicts the immediate next-profile grid while preserving its visible owner',async()=>{
 const p=makeProbe({holdWorker:true}),before=gpuState(p.e),job=begin(p);
 assert.equal(job.demand.input.limbs,16);assert.equal(job.owner,p.base);
 assert(!job.demand.referenceX.eq(p.base.centerX));assert(job.demand.referenceX.eq(job.demand.view.centerX));
 assert.equal(job.demand.input.centerX,coordinateToFixed(job.demand.view.centerX));
 assert.equal(job.demand.input.centerY,coordinateToFixed(job.demand.view.centerY));
 assert.equal(p.calls.length,1);assert(p.e.activeOperations.has(job.promise));
 p.releaseWorker();await job.promise;await tick();assert.deepEqual(gpuState(p.e),before);
 for(const changes of [{zoomRate:0},{zoomRate:-1},{zoomRate:NaN},{zoomRate:Infinity},
  {zoomRate:1000},{zoomRate:150},{unitsPerPixel:new Decimal('1e-15')}]){
  const other=makeProbe({view:changes});other.e.startReferencePrefetch(other.base);
  assert.equal(other.e.referencePrefetch,null);assert.equal(other.calls.length,0,'invalid, absent or multi-profile forecast does not start a worker');
 }
});

test('real dyadic planner agrees with predicted foreground identity across consecutive tiers and precision boundaries',async()=>{
 for(const unitsPerPixel of ['1e-32','1e-33','1e-110','1e-264']){
  const p=makeProbe({holdWorker:true,view:{unitsPerPixel:new Decimal(unitsPerPixel)}}),job=begin(p),
   retained=p.e.numericalView,spacing=job.demand.view.unitsPerPixel;
  assert.notEqual(retained,job.demand.view,'prediction does not install its grid');
  assert(retained.unitsPerPixel.gt(spacing));
  // Traverse actual intermediate dyadic grids before first reaching the new
  // profile. Use a distinct point inside each tier, not the prediction's probe.
  let step=retained.unitsPerPixel.div(2);
  while(step.gt(spacing)){
   const visible={...p.base,unitsPerPixel:step.times('1.99')};p.e.reproject(visible);
   const work=p.e.workRequest(visible),demand=p.e.referenceDemand(work,p.e.refLimbs);
   assert(work.unitsPerPixel.eq(step));assert.equal(demand.input.centerX,coordinateToFixed(work.centerX));
   assert.equal(p.e.referencePrefetch,job);assert.equal(job.cancelled,false);step=step.div(2);
  }
  const visible=firstFuture(p,job);p.e.reproject(visible);
  const work=p.e.workRequest(visible),demand=p.e.referenceDemand(work,job.demand.input.limbs);
  assert(work.unitsPerPixel.eq(spacing));assert.equal(demand.input.centerX,coordinateToFixed(work.centerX));
  assert.equal(demand.input.centerY,coordinateToFixed(work.centerY));
  assert.equal(orbit.referenceIdentity(demand.input),orbit.referenceIdentity(job.demand.input));
  p.e.abort();await assert.rejects(job.promise,e=>e.name==='AbortError');
 }
});

test('a missed first grid cancels speculation and uses the exact ordinary foreground reference',async()=>{
 const p=makeProbe({holdWorker:true,view:{width:128,height:128}}),before=gpuState(p.e),job=begin(p),
  visible=firstFuture(p,job,{unitsPerPixel:job.demand.view.unitsPerPixel.times('1.1')});
 p.e.reproject(visible);assert.equal(p.e.referencePrefetch,job,'visible owner is unchanged');
 const work=p.e.workRequest(visible),demand=p.e.referenceDemand(work,job.demand.input.limbs);
 assert(work.width<job.demand.view.width);assert(!work.centerX.eq(job.demand.referenceX));
 assert.equal(demand.input.centerX,coordinateToFixed(work.centerX));
 assert.notEqual(orbit.referenceIdentity(demand.input),orbit.referenceIdentity(job.demand.input));
 const foreground=p.e.generateOrbit(work,job.demand.input.limbs);
 assert.equal(job.cancelled,true);await assert.rejects(job.promise,e=>e.name==='AbortError');
 assert.equal(p.e.referenceCache.get(job.demand.input),undefined);assert.deepEqual(p.calls[1].input,{...demand.input});
 p.releaseWorker();await assert.rejects(foreground,e=>e===boundary);
 assert.equal(p.calls.filter(call=>call.cancelled).length,1);assert.equal(p.gpuEntries(),1);
 assert.deepEqual(gpuState(p.e),before);assert.ok(p.e.referenceCache.get(demand.input));
});

test('ordinary held centre-focused eligibility and occupied-worker guards prevent speculative collisions',async()=>{
 const changes=[{followView:false},{interacting:false},{heldInwardZoom:false},{zoom:0},{zoom:-1},{family:'julia'},
  {angle:1},{exportDomain:{width:32,height:24,x:0,y:0}},{stationaryOversampling:true},{useApprox:false},
  {colors:{mode:1,supersample:1,capped:0}},{colors:{mode:0,supersample:2,capped:0}},
  {colors:{mode:0,supersample:1,capped:1}},{focus:{x:.4,y:.5}},{focus:{x:.5,y:.4}},
  {maxIterations:4_000_000}];
 for(const change of changes){const p=makeProbe({view:change,holdWorker:true});p.e.startReferencePrefetch(p.base);assert.equal(p.calls.length,0,JSON.stringify(change));}
 for(const guard of [{pendingReferenceDemand:{}},{referencePreparing:true},{refValid:false},{disposed:true},{abortRequested:true}]){
  const p=makeProbe();Object.assign(p.e,guard);p.e.startReferencePrefetch(p.base);assert.equal(p.calls.length,0);
 }
 const occupied=makeProbe();occupied.worker.current={};occupied.e.startReferencePrefetch(occupied.base);assert.equal(occupied.calls.length,0);
 const p=makeProbe({holdWorker:true}),job=begin(p);p.e.startReferencePrefetch(p.base);assert.equal(p.calls.length,1);
 p.e.abort();await assert.rejects(job.promise,e=>e.name==='AbortError');
});

test('a large Dynamic cap can prefetch an early-escaping orbit and its small actual table',async()=>{
 const p=makeProbe({view:{centerX:new Decimal(2),maxIterations:1_306_982,dynamicIterations:true}}),before=gpuState(p.e),job=begin(p);
 assert.equal(job.demand.input.maxIterations,2**21);await job.promise;
 const stored=p.e.referenceCache.get(job.demand.input);assert.ok(stored);assert.equal(stored.escaped,true);
 assert(stored.terminal.iteration<128);assert.equal(p.calls.length,1);
 assert.deepEqual(Buffer.from(stored.samples.buffer),Buffer.from(orbit.generatePackedReference(job.demand.input).buffer));
 assert.ok(p.e.blaCache.tables.some(entry=>entry.samples===stored.samples));assert.equal(p.gpuEntries(),0);
 assert.deepEqual(gpuState(p.e),before);
});

test('completed speculation stores real CPU orbit and BLA data without admitting or touching GPU reference state',async()=>{
 const p=makeProbe(),before=gpuState(p.e),job=begin(p);await job.promise;await tick();
 const stored=p.e.referenceCache.get(job.demand.input);assert.ok(stored);
 assert.deepEqual(Buffer.from(stored.samples.buffer),Buffer.from(orbit.generatePackedReference(job.demand.input).buffer));
 // Read the admitted CPU table record to obtain its actual captured domain;
 // verify the real cache API returns it for that exact orbit/domain/tolerance.
 const entry=p.e.blaCache.tables.find(t=>t.samples===stored.samples);assert.ok(entry);
 assert.ok(p.e.blaCache.get(stored.samples,stored.length,stored.sampleWords,job.epsilonLog2,entry.maxDelta));
 assert.equal(p.e.referencePrefetch,null);assert.equal(p.e.activeOperations.size,0);assert.equal(p.gpuEntries(),0);assert.equal(p.fences(),0);
 assert.deepEqual(gpuState(p.e),before);
 p.e.startReferencePrefetch(p.base);assert.equal(p.calls.length,2,'a sufficient completed cache entry avoids another speculative worker');
});

test('foreground claims the same in-flight prefetch and held release preserves its foreground ownership',async()=>{
 const p=makeProbe({holdWorker:true}),job=begin(p),next=firstFuture(p,job);
 p.e.reproject(next);const foreground=p.e.generateOrbit(p.e.workRequest(next),16);
 assert.equal(job.claimed,p.e.pendingReferenceDemand);assert.equal(p.calls.length,1);
 const released={...next,interacting:false,heldInwardZoom:false,zoom:0};p.e.reproject(released);
 assert.equal(p.e.referencePrefetch,job);assert.equal(job.cancelled,false);
 p.releaseWorker();await assert.rejects(foreground,e=>e===boundary);await job.promise;
 assert.equal(p.calls.length,2,'only the speculative worker suffixes run');assert.equal(p.gpuEntries(),1);
 assert.equal(p.e.pendingReferenceDemand,null);assert.equal(p.e.referencePrefetch,null);
});

test('foreground identity or higher-cap mismatch cancels speculation before using the single worker normally',async()=>{
 for(const change of [{centerX:new Decimal('.25001')},{maxIterations:129}]){
  const p=makeProbe({holdWorker:true}),job=begin(p),next=firstFuture(p,job,change);
  // Bypass reproject deliberately: generateOrbit itself must own the mismatch.
  p.e.currentView=next;const foreground=p.e.generateOrbit(p.e.workRequest(next),16);
  assert.equal(job.cancelled,true);assert(p.cancelled.includes('Foreground reference changed'));
  await assert.rejects(job.promise,e=>e.name==='AbortError');
  assert.equal(p.e.referenceCache.get(job.demand.input),undefined,'cancelled speculative payload was never cached');p.releaseWorker();
  await assert.rejects(foreground,e=>e===boundary);assert.equal(p.gpuEntries(),1);
  assert.equal(p.calls.filter(c=>c.cancelled).length,1);
  if(change.centerX)assert.equal(p.e.referenceCache.get(job.demand.input),undefined);
  else assert.equal(p.e.referenceCache.get(job.demand.input).terminal.iteration,129,'cap-independent identity contains only the fresh higher-cap payload');
 }
});

test('reproject cancels changed speculation before presentation/export early returns',async()=>{
 for(const change of [{centerX:new Decimal('.25001')},{maxIterations:129},{family:'julia'},
  {interacting:false,heldInwardZoom:false,zoom:0},{useApprox:false},
  {tuning:{...DEFAULT_TUNING,blaPrecisionLog2:-14}},{exportDomain:{width:32,height:24,x:0,y:0}},
  {unitsPerPixel:new Decimal('1e-3000')},{focus:{x:.4,y:.5}}]){
  const p=makeProbe({holdWorker:true}),job=begin(p);assert.equal(p.e.reproject({...p.base,...change}),false);
  assert.equal(job.cancelled,true);await assert.rejects(job.promise,e=>e.name==='AbortError');
  assert.equal(p.e.referencePrefetch,null);assert.equal(p.gpuEntries(),0);assert.equal(p.e.referenceCache.get(job.demand.input),undefined);
 }
});

test('abort while worker is inactive during bounded assembly prevents completed cache commit',async()=>{
 const p=makeProbe({holdFirstYield:true}),before=gpuState(p.e),job=begin(p);await p.yieldReached.promise;
 assert.equal(p.worker.active,false);assert.equal(p.calls.length,2);assert.equal(p.e.referenceCache.get(job.demand.input),undefined);
 p.e.abort();assert.equal(job.cancelled,true);p.yieldGate.resolve();await assert.rejects(job.promise,e=>e.name==='AbortError');await tick();
 assert.equal(p.e.referenceCache.get(job.demand.input),undefined);assert.equal(p.e.blaCache.tables.length,0);assert.equal(p.gpuEntries(),0);
 assert.deepEqual(gpuState(p.e),before);
});

test('abort during CPU table preparation retains only the already completed CPU orbit',async()=>{
 const p=makeProbe({holdFirstYield:true,chunkLimit:128}),job=begin(p);await p.yieldReached.promise;
 assert.equal(p.worker.active,false);const completed=p.e.referenceCache.get(job.demand.input);assert.ok(completed);
 p.e.abort();p.yieldGate.resolve();await assert.rejects(job.promise,e=>e.name==='AbortError');
 assert.equal(p.e.referenceCache.get(job.demand.input),completed);assert.equal(p.e.blaCache.tables.length,0);assert.equal(p.gpuEntries(),0);
});

test('detached worker failure is observed and later foreground demand retries the ordinary preparation path',async()=>{
 const failure=new Error('speculative CPU failure'),p=makeProbe({failOnce:failure}),before=gpuState(p.e),job=begin(p);
 // Do not attach a test consumer until the event turn has passed: production's
 // detached handler must observe rejection itself (node:test reports unhandled rejection).
 await tick();await tick();assert.equal(p.e.referencePrefetch,null);assert.equal(p.e.activeOperations.size,0);
 assert.deepEqual(gpuState(p.e),before);assert.equal(p.e.referenceCache.get(job.demand.input),undefined);
 const next=firstFuture(p,job);p.e.reproject(next);
 await assert.rejects(p.e.generateOrbit(p.e.workRequest(next),16),e=>e===boundary);
 assert.equal(p.calls.length,3);assert.equal(p.gpuEntries(),1);assert.ok(p.e.referenceCache.get(job.demand.input));
});

test('disposal cancels and awaits detached speculation before clearing CPU caches and renderer resources',async()=>{
 const p=makeProbe({holdWorker:true}),job=begin(p),disposing=p.e.dispose();
 assert.equal(job.cancelled,true);await assert.rejects(job.promise,e=>e.name==='AbortError');await disposing;
 assert.equal(p.worker.active,false);assert.equal(p.e.referencePrefetch,null);assert.equal(p.e.activeOperations.size,0);
 assert.equal(p.e.referenceCache.get(job.demand.input),undefined);assert.equal(p.e.blaCache.tables.length,0);
 assert.equal(p.e.refSamples,null);assert.equal(p.e.orbitBuffer,null);assert.equal(p.gpuEntries(),0);assert.equal(p.fences(),1);
 assert.equal(await p.e.dispose(),undefined);
});
