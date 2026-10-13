// Exercise production preparation with deferred compiler promises. No browser,
// shader compiler or GPU is used; these tests establish scheduling/lifecycle.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
const file=path.join(__dirname,'../src/render/webgpu-renderer.ts');
const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
const renderer=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='WebGpuRenderer');
const methods=['oncePipeline','ensureComputePipeline','ensureContinuationPipeline',
  'warmNavigationPipelines','trackOperation','renderRequest'];
const actual=methods.map(name=>renderer.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.text===name).getText(sf)).join('\n');
const transpile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const context={exports:{},GPUShaderStage:{COMPUTE:4},DEFAULT_TUNING:{workgroupShape:'16x4'},
  ORDINARY_WORKGROUP_X:16,ORDINARY_WORKGROUP_Y:4,
  COLD_CONTINUATION_OPERATIONS:4096,MANDATORY_CONTINUATION_ITERATIONS:1_000_000,
  Method:{Direct:0,Hdr:2},DOMException,LiveDemandChanged:class extends Error{},
  needsEndpoints:colors=>colors.effect===5,
  deliveryWorkgroup:shape=>shape==='16x4'?{x:16,y:4}:{x:8,y:8},
  continuationLaneLimit:bytes=>bytes>=880?1:0,
  compensatedSource:'',quadSource:'',quadFastSource:'',perturbationSource:'',wideSource:'',continuationSource:''};
vm.runInNewContext(transpile(`class Probe {${actual}} exports.Probe=Probe;`),context,{filename:file});
const {Probe}=context.exports;
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function request(changes={}){return{family:'mandelbrot',followView:true,maxIterations:1000,dynamicIterations:true,
  useApprox:true,colors:{mode:0,supersample:1,capped:0},tuning:{workgroupShape:'16x4'},...changes};}
function probe(){
  const p=new Probe(),pipelines=[],modules=[],layouts=[];
  context.compileShader=()=>{const gate=deferred();modules.push(gate);return gate.promise;};
  const device={limits:{maxStorageBuffersPerShaderStage:8,maxStorageBufferBindingSize:2**28,maxBufferSize:2**28,
    maxComputeWorkgroupSizeX:256,maxComputeWorkgroupSizeY:256,maxComputeInvocationsPerWorkgroup:256},
    createComputePipelineAsync(descriptor){const gate=deferred();pipelines.push({descriptor,...gate});return gate.promise;},
    createBindGroupLayout(descriptor){layouts.push(descriptor);return{descriptor};},
    createPipelineLayout(descriptor){return{descriptor};}};
  Object.assign(p,{ctx:{device},disposed:false,deviceLost:false,renderModule:{},pipelineLayout:{},bindLayout:{},
    pendingPipelines:new Map(),continuationPipelines:new Map(),ordinaryShapePipelines:new Map(),
    navigationPipelineWarmups:new Set(),activeOperations:new Set(),workRequest:r=>r,
    renderTarget:async()=>({completed:true,method:0}),isComplete:()=>true});
  return{p,pipelines,modules,layouts};
}
const labels=q=>q.pipelines.map(p=>p.descriptor.label);
async function finish(q){
  for(const gate of q.modules)gate.resolve({module:true});
  await tick();
  for(const gate of q.pipelines)gate.resolve({label:gate.descriptor.label});
  await Promise.allSettled([...q.p.activeOperations,...q.p.pendingPipelines.values()]);
  await tick();
}

test('initial Direct image returns while Dynamic crossover pipelines prepare in the background',async()=>{
  const q=probe(),result=await q.p.renderRequest(request());
  assert.equal(result.completed,true);
  assert.deepEqual(labels(q),['ordinary-approximation-compute']);
  assert.equal(q.modules.length,1,'Direct and approximation continuations share module compilation');
  assert.equal(q.p.activeOperations.size,1,'warmup is tracked without blocking the image');
  q.modules[0].resolve({module:true});await tick();
  assert.deepEqual(labels(q).sort(),['continuation-direct','continuation-ordinaryApprox','ordinary-approximation-compute'].sort());
  assert.equal(q.layouts.length,1);
  assert.equal(q.p.ordinaryApproxPipeline,undefined,'calculation is still pending');
  const foreground=q.p.ensureContinuationPipeline('ordinaryApprox');
  await tick();assert.equal(q.pipelines.length,3,'foreground shares the pending variant');
  await finish(q);await foreground;
});

test('warmup chooses current shape and BLA policy; fixed low cap avoids continuation',async()=>{
  const q=probe();q.p.warmNavigationPipelines(request({dynamicIterations:false,useApprox:false,tuning:{workgroupShape:'8x8'}}));
  assert.deepEqual(labels(q),['ordinaryPlain:8x8']);assert.equal(q.modules.length,0);
  q.p.warmNavigationPipelines(request({dynamicIterations:false,useApprox:false,tuning:{workgroupShape:'8x8'}}));
  assert.equal(q.pipelines.length,1);
  await finish(q);
});

test('speculative warmup excludes preview, export, Julia and other appearances',()=>{
  for(const change of [{followView:false},{family:'julia'},{exportDomain:{}},{stationaryOversampling:true},
    {publishPartial:false},{colors:{mode:1,supersample:1}},{colors:{mode:0,supersample:2}},
    {colors:{mode:0,supersample:1,capped:1}},{colors:{mode:0,supersample:1,effect:5}}]){
    const q=probe();q.p.warmNavigationPipelines(request(change));
    assert.equal(q.pipelines.length,0);assert.equal(q.modules.length,0);
  }
});

test('incomplete or perturbation images do not trigger the Direct warmup hook',async()=>{
  for(const result of [{completed:false,method:0},{completed:true,method:2}]){
    const q=probe();q.p.renderTarget=async()=>result;
    await q.p.renderRequest(request());assert.equal(q.pipelines.length,0);
  }
});

test('failed speculation neither retries every image nor hides foreground failure',async()=>{
  const q=probe(),r=request({dynamicIterations:false});
  q.p.warmNavigationPipelines(r);
  q.pipelines[0].reject(new Error('cold compilation failed'));await tick();
  assert.equal(q.p.pendingPipelines.size,0);
  assert.equal(q.p.activeOperations.size,0);
  q.p.warmNavigationPipelines(r);assert.equal(q.pipelines.length,1);
  const foreground=q.p.ensureComputePipeline('ordinaryApprox');
  const failed=assert.rejects(foreground,/foreground compilation failed/);
  assert.equal(q.pipelines.length,2,'actual demand retries');
  q.pipelines[1].reject(new Error('foreground compilation failed'));await failed;
  const retry=q.p.ensureComputePipeline('ordinaryApprox');
  q.pipelines[2].resolve({ready:true});assert.equal((await retry).ready,true);
});

for(const state of ['disposed','deviceLost']){
  test(`${state} after a cached module prevents new GPU preparation`,async()=>{
    const q=probe();q.p.continuationModule={};
    const pending=q.p.ensureContinuationPipeline('ordinaryApprox');
    const failure=assert.rejects(pending,/disposed|GPU connection lost/);
    q.p[state]=true;await failure;
    assert.equal(q.modules.length,0);assert.equal(q.layouts.length,0);
    assert.equal(q.pipelines.length,0);assert.equal(q.p.continuationPipelines.size,0);
  });
  test(`${state} during shared module preparation prevents publication and variant creation`,async()=>{
    const q=probe(),first=q.p.ensureContinuationPipeline('direct'),second=q.p.ensureContinuationPipeline('ordinaryApprox');
    const failures=[assert.rejects(first,/disposed|GPU connection lost/),assert.rejects(second,/disposed|GPU connection lost/)];
    assert.equal(q.modules.length,1);q.p[state]=true;q.modules[0].resolve({});await Promise.all(failures);
    assert.equal(q.p.continuationModule,undefined);assert.equal(q.layouts.length,0);
    assert.equal(q.pipelines.length,0);assert.equal(q.p.continuationPipelines.size,0);
  });
  test(`${state} during continuation pipeline preparation prevents cache insertion`,async()=>{
    const q=probe(),pending=q.p.ensureContinuationPipeline('direct');
    const failure=assert.rejects(pending,/disposed|GPU connection lost/);
    q.modules[0].resolve({});await tick();q.p[state]=true;q.pipelines[0].resolve({});await failure;
    assert.equal(q.p.continuationPipelines.size,0);
  });
}

// Run the exact production declarations at the foreground preparation boundary.
// Holding calculation unresolved must not delay starting continuation.
const target=renderer.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.text==='renderTarget');
const declarations=new Map();
function walk(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name))declarations.set(n.name.text,n);ts.forEachChild(n,walk);}walk(target);
const startForeground=new Function('request','device','family','initialGrid','calculationKind','ordinaryShape',
  'COLD_CONTINUATION_OPERATIONS','MANDATORY_CONTINUATION_ITERATIONS','needsEndpoints','continuationLaneLimit',transpile(`
  const ${declarations.get('calculationPreparation').getText(sf)};
  const ${declarations.get('continuationPreparation').getText(sf)};
  void calculationPreparation.catch(()=>{});void continuationPreparation?.catch(()=>{});
  return {calculationPreparation,continuationPreparation};`));
function foreground(q,r){return startForeground.call(q.p,r,q.p.ctx.device,r.family,r.colors.supersample,
  'ordinaryApprox','16x4',4096,1_000_000,context.needsEndpoints,context.continuationLaneLimit);}

test('cold foreground starts continuation before calculation resolves and reuses both promises',async()=>{
  const q=probe(),r=request({maxIterations:18000}),first=foreground(q,r),second=foreground(q,r);
  assert.ok(first.continuationPreparation);assert.equal(q.modules.length,1);
  assert.equal(q.pipelines.length,1,'calculation creation is shared');
  q.modules[0].resolve({});await tick();
  assert.deepEqual(labels(q).sort(),['continuation-ordinaryApprox','ordinary-approximation-compute'].sort());
  assert.equal(q.p.ordinaryApproxPipeline,undefined,'continuation started while calculation is unresolved');
  await finish(q);await Promise.all([first.calculationPreparation,first.continuationPreparation,second.calculationPreparation,second.continuationPreparation]);
});

test('an unusable BLA table prepares the plain fallback without waiting for speculative approximation',async()=>{
  const q=probe(),r=request({maxIterations:18000});q.p.warmNavigationPipelines(r);
  const jobs=startForeground.call(q.p,r,q.p.ctx.device,r.family,1,'ordinaryPlain','16x4',
    4096,1_000_000,context.needsEndpoints,context.continuationLaneLimit);
  assert.equal(q.modules.length,1);
  assert.deepEqual(labels(q).sort(),['ordinary-approximation-compute','ordinary-perturbation-compute'].sort());
  q.modules[0].resolve({});await tick();
  assert.ok(labels(q).includes('continuation-ordinaryPlain'));
  assert.equal(q.p.ordinaryApproxPipeline,undefined,'the speculative variant remains unresolved');
  await finish(q);await Promise.all([jobs.calculationPreparation,jobs.continuationPreparation]);
});

test('foreground continuation remains demand-driven for low caps, cohorts and excluded callers',async()=>{
  for(const change of [{maxIterations:4096},{maxIterations:1_000_000},{followView:false},
    {family:'julia'},{exportDomain:{}},{stationaryOversampling:true},{colors:{mode:1,supersample:1}},
    {colors:{mode:0,supersample:2}},{colors:{mode:0,supersample:1,capped:1}},
    {colors:{mode:0,supersample:1,effect:5}}]){
    const q=probe(),jobs=foreground(q,request({maxIterations:18000,...change}));
    assert.equal(jobs.continuationPreparation,null);assert.equal(q.modules.length,0);
    await finish(q);await jobs.calculationPreparation;
  }
});
