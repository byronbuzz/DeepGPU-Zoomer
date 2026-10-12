// Execute renderer policies and identity methods extracted from production AST.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ts=require(root+'/node_modules/typescript'),Decimal=require(root+'/node_modules/decimal.js');
Decimal.set({precision:200});
const modules=new Map();
function load(file){file=path.resolve(root,file);if(!path.extname(file))file+='.ts';if(modules.has(file))return modules.get(file);
 const exports={};modules.set(file,exports);new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(root+'/node_modules/'+name));return exports;}
const sf=ts.createSourceFile('renderer.ts',fs.readFileSync(root+'/src/render/webgpu-renderer.ts','utf8'),ts.ScriptTarget.Latest,true);
const renderer=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='WebGpuRenderer');
const nodes=new Map();
(function walk(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)){const list=nodes.get(n.name.text)||[];list.push(n);nodes.set(n.name.text,list);}ts.forEachChild(n,walk);})(sf);
const common={Decimal,DOMException,performance,...load('src/render/continuation'),...load('src/render/numerical-grid'),...load('src/logic/colorSettings'),...load('src/render/sample-grid'),...load('src/render/reference-orbit'),Method:{Direct:0,Perturbation:1}};
function expression(name,scope={},index=-1){const list=nodes.get(name);assert.ok(list?.length,`production ${name}`);const node=list.at(index);
 const context={...common,...scope,exports:{}};vm.runInNewContext(ts.transpileModule(`exports.evaluate=function(){return ${node.initializer.getText(sf)}};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);return context.exports.evaluate.call(scope.receiver??{});}
function probe(names,context={}){const actual=names.map(name=>{const node=renderer.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.text===name);assert.ok(node,`production ${name}`);return node.getText(sf);}).join('\n');
 const env={...common,...context,exports:{}};vm.runInNewContext(ts.transpileModule(`class Probe {${actual}} exports.Probe=Probe;`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,env);return new env.exports.Probe();}
const D=x=>new Decimal(x);
function request(changes={}){return {family:'julia',juliaX:D('-.8'),juliaY:D('.156'),centerX:D(0),centerY:D(0),unitsPerPixel:D('1e-20'),width:512,height:256,maxIterations:1_000_000,colors:{mode:0,supersample:1,capped:0},followView:true,publishPartial:true,interacting:true,heldInwardZoom:true,zoom:1,useApprox:true,...changes};}
function policies(r=request(),changes={}){const scope={request:r,family:r.family,colors:r.colors,grid:1,initialGrid:1,progressive:true,pipelineKind:'juliaApprox',method:1,costly:false,continuationSupported:true,receiver:{retainEndpoints:false,isInteracting:()=>false},...changes};scope.ordinary=expression('ordinary',scope);scope.ordinaryBlaEligible=expression('ordinaryBlaEligible',scope);scope.measuredBlaEligible=expression('measuredBlaEligible',scope);return scope;}

test('ordinary Julia admission excludes endpoint, capped, quality and supersampled work',()=>{
 for(const kind of ['julia','juliaApprox'])assert.equal(expression('ordinarySpecialized',policies(request(),{pipelineKind:kind})),true);
 for(const changes of [{colors:{mode:1,supersample:1}},{colors:{mode:0,supersample:1,capped:1}},{colors:{mode:0,supersample:1,effect:5}}])assert.equal(expression('ordinarySpecialized',policies(request(changes))),false);
 assert.equal(expression('ordinarySpecialized',policies(request(),{initialGrid:2})),false);
 assert.equal(expression('ordinary',policies(request({colors:{mode:0,supersample:2}}))),false);
 assert.equal(expression('ordinary',policies(request(),{receiver:{retainEndpoints:true}})),false);
});

test('Julia delivery chooses the ordinary variant while preserving generic endpoint and Direct arithmetic routes',()=>{
 for(const [method,levels,kind,expected] of [[0,0,'juliaDirect','ordinaryJuliaDirect'],[1,0,'julia','ordinaryJulia'],[1,2,'juliaApprox','ordinaryJuliaApprox']]){
  const scope=policies(request(),{method,approximationLevels:levels,pipelineKind:kind});scope.ordinarySpecialized=expression('ordinarySpecialized',scope);
  assert.equal(expression('calculationKind',scope),expected);
  scope.ordinarySpecialized=false;assert.equal(expression('calculationKind',scope),kind,'channel-rich requests retain generic specialization');
 }
});

test('full Julia shares timed batches and settled preview while Direct and costly work retain safeguards',()=>{
 assert.equal(expression('gpuControlled',policies()),true);
 assert.equal(expression('settledPreviewEligible',policies()),true);
 for(const changes of [{method:0},{costly:true},{ordinary:false}])assert.equal(expression('gpuControlled',{...policies(),...changes}),false);
 const preview=request({followView:false,publishPartial:false});assert.equal(expression('gpuControlled',policies(preview)),false);assert.equal(expression('settledPreviewEligible',policies(preview,{progressive:false})),false);
 const inward=policies(request(),{interacting:true,zoom:1,crossover:false});assert.equal(expression('inwardIncumbent',inward),false,'Julia does not inherit the Mandelbrot 32x seed');
});

test('changing Julia constant invalidates every timing policy and saved-sample identity',()=>{
 const scope={...policies(),constant:'-.8,.156',limbs:8,epsilonPolicy:undefined,freshWork:true};
 for(const key of ['ordinaryCostKey','gpuPolicy','feedbackPolicy'])assert.notEqual(expression(key,scope),expression(key,{...scope,constant:'-.8000000001,.156'}),key);
 const p=probe(['sampleIdentity'],{exportIdentity:()=>'',linearBlaPolicy:()=>undefined});p.refLimbs=8;
 assert.notEqual(p.sampleIdentity(scope.request,'julia',scope.constant,1,1,8,2),p.sampleIdentity(scope.request,'julia','-.8000000001,.156',1,1,8,2));
});

test('qualifying Julia BLA retains incumbent cold lanes and rejects measured bulk and survivor pooling',()=>{
 const base=policies();assert.equal(base.ordinaryBlaEligible,true);assert.equal(base.measuredBlaEligible,false);assert.equal(expression('cohortEligible',base),false);assert.equal(expression('poolEligible',base),false);
 const rotated=policies(request({angle:.5}));assert.equal(rotated.ordinaryBlaEligible,true);assert.equal(rotated.measuredBlaEligible,false);assert.equal(expression('cohortEligible',rotated),false);assert.equal(expression('poolEligible',rotated),false);
 assert.equal(policies(request(),{pipelineKind:'julia'}).measuredBlaEligible,false,'an available Julia family is not proof of an admitted table');
 for(const change of [{followView:false},{exportDomain:{}},{stationaryOversampling:true},{colors:{mode:0,supersample:1,effect:5}},{colors:{mode:0,supersample:1,capped:1}}]){const p=policies(request(change));assert.equal(p.measuredBlaEligible,false);assert.equal(expression('poolEligible',p),false);}
 for(const cost of [0,-1,NaN,Infinity,9])assert.equal(common.continuationOperations(10_000_000,cost,8,base.measuredBlaEligible),4096,'cold/invalid/expensive work cannot bypass bounded slicing');
 assert.equal(common.continuationOperations(10_000_000,.000001,8,base.measuredBlaEligible),4096);
 const mandel=policies(request({family:'mandelbrot'}),{pipelineKind:'approx'});assert.equal(mandel.measuredBlaEligible,true);assert.equal(common.continuationOperations(10_000_000,.000001,8,mandel.measuredBlaEligible),0,'accepted Mandelbrot admission remains');
 assert.equal(common.continuationOperations(10_000_000,.000001,8,false),4096,'non-BLA Julia stays mandatory');
 for(const still of [false,true])for(const lanes of [1,256,4096,32768])assert.ok(common.coldCohortOperations(lanes,still)*lanes<=common.CONTINUATION_DISPATCH_OPERATIONS*(still?4:2));
});

test('accepted Mandelbrot cohorts and pooling preserve all incumbent channel and geometry guards',()=>{
 const requestM=changes=>request({family:'mandelbrot',...changes}),scope=policies(requestM(),{pipelineKind:'approx'});
 assert.equal(expression('cohortEligible',scope),true);assert.equal(expression('poolEligible',scope),true);
 for(const change of [{followView:false},{angle:.5},{exportDomain:{}},{stationaryOversampling:true},{colors:{mode:1,supersample:1}},{colors:{mode:0,supersample:2}},{colors:{mode:0,supersample:1,effect:5}},{colors:{mode:0,supersample:1,capped:1}}]){
  const p=policies(requestM(change),{pipelineKind:'approx'});assert.equal(expression('cohortEligible',p),false);assert.equal(expression('poolEligible',p),false);
 }
 for(const change of [{progressive:false},{method:0},{receiver:{retainEndpoints:true,isInteracting:()=>false}}])assert.equal(expression('poolEligible',policies(requestM(),{pipelineKind:'approx',...change})),false);
 assert.equal(expression('poolEligible',policies(requestM({maxIterations:999999}),{pipelineKind:'approx'})),false);
});

test('Julia million-iteration latency safeguard survives arbitrarily cheap or invalid measured feedback',()=>{
 for(const maxIterations of [1_000_000,1_963_041,10_000_000])for(const angle of [0,.5]){
  const scope=policies(request({maxIterations,angle}));assert.equal(scope.measuredBlaEligible,false);
  for(const cost of [0,-1,NaN,Infinity,Number.MIN_VALUE,.000001,8,9])assert.equal(common.continuationOperations(maxIterations,cost,8,scope.measuredBlaEligible),common.COLD_CONTINUATION_OPERATIONS,'cheap average cannot admit an unbounded Julia dispatch');
 }
});

test('stationary Julia continuation responds to live motion without changing per-pixel bounds',()=>{
 const p=policies();assert.equal(expression('stationarySlice',p),true);assert.equal(expression('stationarySlice',{...p,receiver:{isInteracting:()=>true}}),false);
 for(const change of [{followView:false},{maxIterations:999999}])assert.equal(expression('stationarySlice',policies(request(change))),false);
 assert.equal(expression('stationarySlice',policies(request(),{method:0})),false);
 assert.equal(common.resumedContinuationOperations(4096,4096,true),1024);assert.equal(common.resumedContinuationOperations(4096,4096,false),512);assert.equal(common.resumedContinuationOperations(4096,1,true),4096);
});

test('contained inward Julia preparation requires an unchanged family and constant',()=>{
 const p=probe(['inwardPreparationContinues']),initial=request(),live={...initial,unitsPerPixel:initial.unitsPerPixel.div(4)};
 assert.equal(p.inwardPreparationContinues(initial,live),true);
 for(const change of [{family:'mandelbrot'},{juliaX:D('-.8000000001')},{juliaY:D('.1560000001')},{juliaX:undefined},{juliaY:undefined},{heldInwardZoom:false},{interacting:false},{zoom:-1},{angle:.5},{colors:{mode:0,supersample:1,effect:5}},{centerX:initial.unitsPerPixel.times(512)}])assert.equal(p.inwardPreparationContinues(initial,{...live,...change}),false);
 const mandel={...initial,family:'mandelbrot'};assert.equal(p.inwardPreparationContinues(mandel,{...mandel,unitsPerPixel:mandel.unitsPerPixel.div(4)}),true,'incumbent Mandelbrot admission remains');
});

test('Julia continuation carry retains exact-coordinate and constant provenance',()=>{
 const r=request(),scope=policies(r);assert.equal(expression('carryEligible',scope),true);
 for(const change of [{angle:.5},{exportDomain:{}},{stationaryOversampling:true}])assert.equal(expression('carryEligible',policies(request(change))),false);
 const {PendingContinuationSlot}=load('src/render/pending-continuation');let destroyed=0;
 const identity={epoch:1,policy:'julia|-.8,.156',reference:{},orbit:{},table:{},index:{}},pending={scratch:{destroy:()=>destroyed++},capacity:3520,region:{x:128,y:64,width:16,height:16,stride:1},view:r,identity,unfinished:4,operations:4096};
 const slot=new PendingContinuationSlot();slot.park(pending);assert.ok(slot.claim(identity,{...r,centerX:r.centerX.plus(r.unitsPerPixel)}));
 slot.park(pending);assert.equal(slot.claim({...identity,policy:'julia|-.8000000001,.156'},r),undefined);assert.equal(destroyed,1);
 slot.park(pending);assert.equal(slot.claim(identity,{...r,unitsPerPixel:r.unitsPerPixel.div(2)}),undefined);assert.equal(destroyed,2,'saved lanes cannot be moved onto a different sample spacing');
});

test('ordinary Julia pipelines specialize all delivery shapes and distinguish Direct without Mandelbrot DIRECT',async()=>{
 const {DEFAULT_TUNING}=load('src/tuning'),{deliveryWorkgroup}=load('src/render/delivery-workgroup');
 const descriptors=[],p=probe(['ensureComputePipeline'],{DEFAULT_TUNING,deliveryWorkgroup,ORDINARY_WORKGROUP_X:8,ORDINARY_WORKGROUP_Y:4});
 Object.assign(p,{ordinaryShapePipelines:new Map(),renderModule:{},pipelineLayout:{},ctx:{device:{limits:{maxComputeWorkgroupSizeX:256,maxComputeWorkgroupSizeY:256,maxComputeInvocationsPerWorkgroup:256},createComputePipelineAsync:async d=>{descriptors.push(d);return {descriptor:d};}}},oncePipeline:async(_key,ready,build)=>{if(!ready())await build();}});
 for(const shape of [DEFAULT_TUNING.workgroupShape,'16x2'])for(const kind of ['ordinaryJulia','ordinaryJuliaApprox','ordinaryJuliaDirect']){
  const pipeline=await p.ensureComputePipeline(kind,shape),c=pipeline.descriptor.compute.constants;
  assert.equal(c.ORDINARY,1);assert.equal(c.JULIA,1);assert.equal(c.JULIA_DIRECT,kind.endsWith('Direct')?1:0);assert.equal(c.APPROX,kind.endsWith('Approx')?1:0);assert.ok(!c.DIRECT,'Julia Direct uses its existing Wide arithmetic');
  const expected=deliveryWorkgroup(shape);assert.equal(c.SAMPLE_WORKGROUP_X,expected.x);assert.equal(c.SAMPLE_WORKGROUP_Y,expected.y);
  assert.equal(await p.ensureComputePipeline(kind,shape),pipeline,'same numerical specialization is cached');
 }
 assert.equal(descriptors.length,p.ordinaryShapePipelines.size,'one descriptor per cached ordinary specialization');
 const generic=await p.ensureComputePipeline('juliaDirect',DEFAULT_TUNING.workgroupShape),before=descriptors.length;
 assert.equal(await p.ensureComputePipeline('juliaDirect','16x2'),generic,'generic Direct keeps one specialization across requested delivery shapes');
 assert.equal(descriptors.length,before,'generic Direct reuses its existing descriptor');
 const c=generic.descriptor.compute.constants;
 assert.equal(c.ORDINARY,0);assert.equal(c.JULIA,1);assert.equal(c.JULIA_DIRECT,1);assert.ok(!c.DIRECT);
 assert.equal(c.SAMPLE_WORKGROUP_X,8);assert.equal(c.SAMPLE_WORKGROUP_Y,4,'generic Julia preserves its incumbent workgroup');
});

test('Julia continuation descriptors retain Julia arithmetic for ordinary, pooled and generic Direct variants',async()=>{
 const descriptors=[],compiled=[],p=probe(['ensureContinuationPipeline'],{
  GPUShaderStage:{COMPUTE:4},compileShader:async(_device,source,label)=>{compiled.push({source,label});return {label};},
  compensatedSource:'compensated',quadSource:'quad',quadFastSource:'quadFast',perturbationSource:'perturbation',wideSource:'wide',continuationSource:'continuation',
 });
 Object.assign(p,{continuationPipelines:new Map(),bindLayout:{label:'main-bindings'},ctx:{device:{limits:{maxStorageBuffersPerShaderStage:8},createBindGroupLayout:d=>({descriptor:d}),createPipelineLayout:d=>({descriptor:d}),createComputePipelineAsync:async d=>{descriptors.push(d);return {descriptor:d};}}},oncePipeline:async(_key,ready,build)=>{if(!ready())await build();}});
 for(const kind of ['ordinaryJulia','ordinaryJuliaApprox','ordinaryJuliaDirect','juliaDirect'])for(const [pooled,coordinates] of [[false,false],[false,true],[true,true]]){
  const pipeline=await p.ensureContinuationPipeline(kind,pooled,coordinates),before=descriptors.length,d=pipeline.descriptor,c=d.compute.constants;
  assert.equal(c.JULIA,1);assert.equal(c.DIRECT,0,'Julia Direct never activates the Mandelbrot Direct branch');
  assert.equal(c.JULIA_DIRECT,kind.endsWith('Direct')?1:0);assert.equal(c.ORDINARY,kind.startsWith('ordinary')?1:0);assert.equal(c.APPROX,kind.endsWith('Approx')?1:0);assert.equal(c.POOL_COORDINATES,coordinates?1:0);
  assert.equal(d.compute.entryPoint,pooled?'computePooled':'computeContinued');
  assert.equal(d.layout.descriptor.bindGroupLayouts[0],p.bindLayout);assert.equal(d.layout.descriptor.bindGroupLayouts[1],p.continuationLayout);
  assert.equal(await p.ensureContinuationPipeline(kind,pooled,coordinates),pipeline);assert.equal(descriptors.length,before,'continuation specialization is cached');
 }
 assert.equal(descriptors.length,p.continuationPipelines.size);assert.equal(compiled.length,1,'all Julia continuation specializations share one shader module');assert.equal(compiled[0].label,'continuation');
 p.ctx.device.limits.maxStorageBuffersPerShaderStage=7;p.continuationPipelines.clear();
 await assert.rejects(p.ensureContinuationPipeline('ordinaryJulia'),/eight storage bindings/);
});

function prefetchProbe(changes={}){
 const calls=[],remembered=[],live=request({zoomRate:2,isCurrent:()=>true,...changes}),limits={maxStorageBufferBindingSize:96000,maxBufferSize:96000,maxTextureDimension2D:8192};
 const p=probe(['startReferencePrefetch','prefetchCompatible','referenceDemand','referenceBudget'],{
  ...load('src/coordinate'),LIMB_PROFILES:[8,16,32,64,128,256],
  limbsForScale:scale=>scale.lt('1e-20')?16:8,
  renderDomain:r=>({width:r.width,height:r.height}),
  blaTableEpsilon:r=>r.family==='julia'?-40:-24,
  approximationDeltaBound:(family)=>family==='julia'?D(0):D(1),
  planNumericalView:r=>({...r,unitsPerPixel:r.unitsPerPixel.div(2).div(1-1e-12)}),
  ENTRY_FLOATS:16,REFERENCE_CHUNK_ITERATIONS:100000,
  yieldToEvents:async()=>{},
  prepareReference:async(input,generate,check)=>{check();await generate(input,undefined);check();return {samples:new Float32Array(20),length:1,sampleWords:20,terminal:{iteration:input.maxIterations}};},
  buildBlaAsync:async(_samples,_length,delta,_yield,options)=>{calls.push({delta,options});return {};},
 });
 Object.assign(p,{ctx:{device:{limits}},currentView:live,refValid:true,refLimbs:8,refTerminal:null,numericalAnchor:{},
  referenceWorker:{active:false,generate:async(input,resume,budget)=>{calls.push({input,resume,budget});}},
  referenceCache:{get:()=>undefined,remember:(...args)=>remembered.push(args)},blaCache:{remember:(...args)=>remembered.push(args)},
  workRequest:r=>r,trackOperation:f=>f(),referencePrefetch:null});
 return {p,live,calls,remembered,limits};
}

test('Julia reference prefetch keeps fixed constant, doubled transport budgets and conservative cancellation',async()=>{
 const {p,live,calls,limits}=prefetchProbe();p.startReferencePrefetch(live);const job=p.referencePrefetch;assert.ok(job,'eligible Julia precision forecast starts');
 assert.equal(job.demand.input.family,'julia');assert.equal(job.demand.input.juliaX,live.juliaX.toFixed());assert.equal(job.demand.input.juliaY,live.juliaY.toFixed());
 assert.equal(p.prefetchCompatible(job,live),true);
 for(const change of [{family:'mandelbrot'},{juliaX:D('-.8000000001')},{juliaY:D('.1560000001')},{centerX:D('.000000001')},{focus:{x:.51,y:.5}},{colors:{mode:0,supersample:1,effect:5}},{angle:.5}])assert.equal(p.prefetchCompatible(job,{...live,...change}),false);
 await job.promise;assert.equal(calls[0].budget,Math.floor(limits.maxBufferSize/96)-1,'Julia decoded capacity uses 96 bytes per sample');
 assert.equal(calls[1].delta.toString(),'0','Julia table preserves zero parameter perturbation');assert.equal(calls[1].options.sampleWords,20);assert.equal(calls[1].options.epsilonLog2,-40);
 const tooLarge=prefetchProbe({maxIterations:1_700_000});tooLarge.p.startReferencePrefetch(tooLarge.live);assert.equal(tooLarge.p.referencePrefetch,null,'Julia packed budget counts 80 bytes per sample');assert.equal(tooLarge.calls.length,0);
 const invalid=prefetchProbe({juliaX:undefined});assert.doesNotThrow(()=>invalid.p.startReferencePrefetch(invalid.live));assert.equal(Boolean(invalid.p.referencePrefetch),false,'missing Julia identity cannot start speculation');
});
