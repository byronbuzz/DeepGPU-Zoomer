const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.join(__dirname,'..');
const transpile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exportsObject={};vm.runInNewContext(transpile(fs.readFileSync(path.join(root,'src/render/survivor-cohort.ts'),'utf8')),{exports:exportsObject});
const {SurvivorCohort,SURVIVOR_CAPACITY}=exportsObject;
const r=(x=0,stride=1)=>({x,y:0,width:64,height:64,order:0,stride});

test('sparse admission is bounded and flushes by size, age or exhausted work',()=>{
  const c=new SurvivorCohort();
  assert.equal(c.accepts(r(),32,3200),true);
  for(const [survivors,lanes] of [[33,4096],[1,99],[0,100],[NaN,100],[1,Infinity],[1.5,1000]])
    assert.equal(c.accepts(r(),survivors,lanes),false);
  assert.equal(c.ready(100,false),false);
  c.add(r(),1,100,10);
  assert.equal(c.ready(25,true),false);assert.equal(c.ready(26,true),true);
  assert.equal(c.ready(10,false),true);
  c.clear();
  for(let n=0;n<4;n++)c.add(r(n*64),32,3200,10);
  assert.equal(c.lanes,128);assert.equal(c.ready(10,true),true);
  for(let n=4;n<8;n++)c.add(r(n*64),32,3200,10);
  assert.equal(c.lanes,SURVIVOR_CAPACITY);assert.equal(c.accepts(r(512),1,100),false);
  assert.throws(()=>c.add(r(512),1,100,10));
});
test('coarse/fine and intersecting owners serialize before any cold dispatch',()=>{
  const c=new SurvivorCohort();c.add(r(0,16),1,100,0);
  assert.equal(c.conflicts(r(0,1)),true);
  assert.equal(c.conflicts(r(32,16)),true);
  assert.equal(c.conflicts(r(64,16)),false);
  assert.equal(c.conflicts(r(64,1)),true,'even disjoint density changes flush first');
  c.clear();assert.equal(c.conflicts(r()),false);
});

const filename=path.join(root,'src/render/webgpu-renderer.ts');
const source=ts.createSourceFile(filename,fs.readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true);
const declarations=new Map();
function walk(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name))declarations.set(n.name.text,n);ts.forEachChild(n,walk);}walk(source);
const flush=declarations.get('flushPool').getText(source);
test('production pool allocation permits its independent GPU counter readback',()=>{
  let allocation;function find(n){if(ts.isIfStatement(n)&&n.expression.getText(source)==='!pool')allocation=n;ts.forEachChild(n,find);}find(source);
  assert.ok(allocation);
  const deviceSource=ts.createSourceFile('device.ts',fs.readFileSync(path.join(root,'src/gpu/device.ts'),'utf8'),ts.ScriptTarget.Latest,true);
  const helper=deviceSource.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='storageBuffer').getText(deviceSource).replace(/^export /,'');
  const create=new Function('device','GPUBufferUsage',transpile(`
    ${helper}
    const CONTINUATION_HEADER_BYTES=528,SURVIVOR_CAPACITY=256,CONTINUATION_STATE_BYTES=352;
    let pool,poolBind;${allocation.getText(source)};return pool;`));
  const fake={createBuffer:descriptor=>descriptor,createBindGroup:()=>({})};
  const pool=create.call({continuationLayout:{}},fake,{STORAGE:1,COPY_DST:2,COPY_SRC:4});
  assert.equal(pool.size,528+256*352);assert.equal(pool.usage,7);
});
test('cold publication uses determined samples while prior logical visits remain pooled',()=>{
  const initial=declarations.get('publishedCompleted').initializer.getText(source);
  const previous=new Function('observedCompletions','submittedVisits',transpile(`return ${initial};`))(98,100);
  assert.ok(99>previous,'one new completed anchor must publish even while two older visits are unfinished');
});
// Execute the production asynchronous drain against a deterministic queue. No
// browser, device, shader compiler or GPU is involved in these tests.
const createProbe=new Function('ctx',transpile(`
  const {device,cohort,request,uniforms,u32,bind,pool,poolBind,pooledPipeline,continuationReadback,
    records,metric,tuning,gpuCost,COLD_CONTINUATION_OPERATIONS,resumedContinuationOperations,
    GPUMapMode,yieldToEvents,performance,frame}=ctx;
  let completed=true,prefixes=records,poolCost=metric,observedCompletions=ctx.initialCompleted;
  const family='mandelbrot',epoch=1,continuationOrbit=ctx.orbit;
  let continuationProbe,exactCoverage=0;
  const targetStarted=0,newCost=()=>({expected:0,reported:0,gpuMs:0,unavailable:false,notify:()=>{}});
  const ${declarations.get('poolCurrent').getText(source)};
  const serviceAppearance=()=>ctx.appearanceCompatible;
  const shade=(encoder,width,height)=>ctx.shades.push({bounds:[...u32.slice(40,44)],width,height,stride:u32[54]});
  const ${declarations.get('collectTiming').getText(source)};
  const ${flush};
  return {flush:flushPool,state:()=>({completed,exactCoverage,observedCompletions,continuationProbe})};
`));
function probe(sequence,regions=[r(0),r(64)]){
  const p={abortRequested:false,partialSerial:0,partialRegions:0,publicationEpoch:1,aborted:false,
    ctx:{},statsBuffer:{},uniformBuffer:{},batchMsPerSample:0,
    timing:{begin(){},writes(){},resolve(){}},
    batchFeedback:{submit(visits,stride,targetMs){return{visits,stride,targetMs};},observe(m,ms,kind){feedback.push({m,ms,kind});}},
    requireLiveMethod(){},isInteracting(){return true;},sameView(){return true;},workRequest(v){return v;},reproject(){},
    determined:{add(r){certificates.push(r);}},determinedRegion:null};
  const writes=[],submits=[],copies=[],shades=[],certificates=[],feedback=[],timings=[];
  p.timing.collect=(sample,onElapsed,onUnavailable)=>timings.push({onElapsed,onUnavailable});
  const u32=new Uint32Array(56),cohort=new SurvivorCohort();
  for(const region of regions)cohort.add(region,1,4096,0);
  const mapped=new Uint32Array(15);let maps=0,unmaps=0;
  const pool={},pass={setPipeline(){},setBindGroup(){},dispatchWorkgroups(x){assert.equal(x,Math.ceil(cohort.lanes/32));},end(){}};
  const device={queue:{writeBuffer(buffer,offset,data){writes.push({buffer,offset,data:Array.from(new Uint32Array(data.buffer??data,data.byteOffset??0,data.byteLength/4))});},
    submit(){submits.push(writes.length);}},createCommandEncoder(){return{beginComputePass(){return pass;},
    copyBufferToBuffer(...args){copies.push(args);},finish(){return{};}};}};
  const readback={async mapAsync(){
    const next=sequence[maps++];assert.ok(next,'unexpected extra map');mapped.fill(0);
    mapped[5]=next.completed;mapped[7]=next.unfinished;mapped[14]=next.append??cohort.lanes;
    if(next.cancel)p.abortRequested=true;
    if(next.epoch)p.publicationEpoch++;
    if(next.orbit)p.orbitBuffer={};
    if(next.current)ctx.current=false;
  },getMappedRange(){return mapped.buffer;},unmap(){unmaps++;}};
  let clock=0;
  const ctx={device,cohort,request:{followView:true,width:128,height:64,maxIterations:1_000_000,presentationOwner:'animation',isCurrent:()=>ctx.current},
    uniforms:u32.buffer,u32,bind:{},pool,poolBind:{},pooledPipeline:{},continuationReadback:readback,
    records:regions.map(()=>({visits:4096,wallMs:2,cost:()=>({expected:0,reported:0,gpuMs:0,unavailable:true}),notify(){}})),
    metric:{expected:0,reported:0,gpuMs:0,unavailable:false,notify(){}},tuning:{batchTargetMs:8},gpuCost:{msPerVisit:0},
    COLD_CONTINUATION_OPERATIONS:4096,resumedContinuationOperations:(admitted)=>admitted,GPUMapMode:{READ:1},
    yieldToEvents:async()=>{},performance:{now:()=>++clock},frame:{},initialCompleted:10,shades,appearanceCompatible:true,current:true,orbit:{}};
  p.orbitBuffer=ctx.orbit;
  const runner=createProbe.call(p,ctx);
  return {p,ctx,runner,writes,submits,copies,shades,certificates,feedback,pool,timings,unmaps:()=>unmaps};
}
test('actual drain preserves append count, waits for detail and certifies all owners exactly once',async()=>{
  const q=probe([{completed:10,unfinished:2},{completed:11,unfinished:1},{completed:12,unfinished:0}]);
  await q.runner.flush();
  assert.equal(q.unmaps(),3);assert.equal(q.p.partialSerial,2,'no fake publication on the first unchanged counter');
  assert.equal(q.shades.length,4);assert.equal(q.certificates.length,2);
  assert.equal(q.runner.state().exactCoverage,8192);assert.equal(q.ctx.cohort.lanes,0);
  const controls=q.writes.filter(w=>w.buffer===q.pool);
  assert.equal(controls.length,3);assert.ok(controls.every(w=>w.offset===0&&w.data.length===3),'byte 12 remains GPU-owned');
  assert.ok(controls.every(w=>w.data[0]===4096&&w.data[1]===1&&w.data[2]===2));
  assert.ok(q.copies.some(c=>c[0]===q.pool&&c[1]===12&&c[3]===56&&c[4]===4));
  assert.equal(q.feedback.length,1);assert.equal(q.feedback[0].m.visits,8192,'aggregate full logical visits, never tail-only feedback');
  assert.equal(q.shades[0].bounds[0],0);assert.equal(q.shades[0].bounds[2],0);
  assert.equal(q.shades[1].bounds[2],64);
  assert.ok(q.submits.length>=7,'calculate and each uniform-backed shade have their own submission');
});
test('actual drain fails closed on copying or survivor accounting disagreements',async()=>{
  for(const state of [{completed:12,unfinished:0,append:1},{completed:12,unfinished:3}]){
    const q=probe([state]);await assert.rejects(q.runner.flush());
    assert.equal(q.unmaps(),1);assert.equal(q.certificates.length,0);assert.equal(q.runner.state().exactCoverage,0);
  }
});
test('actual drain cannot publish or certify an aborted or incompatible target',async()=>{
  for(const reason of ['cancel','epoch','orbit','current']){
    const q=probe([{completed:12,unfinished:0,[reason]:true}]);await q.runner.flush();
    assert.equal(q.runner.state().completed,false);assert.equal(q.shades.length,0);assert.equal(q.certificates.length,0);
  }
  const a=probe([{completed:10,unfinished:2}]);a.ctx.appearanceCompatible=false;
  await a.runner.flush();assert.equal(a.p.retarget,true);assert.equal(a.runner.state().completed,false);
  assert.equal(a.certificates.length,0);assert.equal(a.feedback.length,0);
});
test('completed sparse coarse work never claims native exact coverage',async()=>{
  const q=probe([{completed:12,unfinished:0}],[r(0,16),r(64,16)]);await q.runner.flush();
  assert.equal(q.certificates.length,2);assert.equal(q.runner.state().exactCoverage,0);
  assert.ok(q.shades.every(s=>s.stride===16));
});
test('cohort GPU feedback waits for every prefix and tail timestamp',async()=>{
  const q=probe([{completed:12,unfinished:0}]);q.p.timing.begin=()=>({});
  const costs=[{expected:1,reported:0,gpuMs:0,unavailable:false},{expected:1,reported:0,gpuMs:0,unavailable:false}];
  const notices=[];
  q.ctx.records.forEach((record,i)=>{record.cost=()=>costs[i];record.notify=f=>notices[i]=f;});
  await q.runner.flush();assert.equal(q.feedback.length,0);
  q.timings[0].onElapsed(3);assert.equal(q.feedback.length,0);
  costs[0].reported=1;costs[0].gpuMs=5;notices[0]();assert.equal(q.feedback.length,0);
  costs[1].reported=1;costs[1].gpuMs=7;notices[1]();
  assert.equal(q.feedback.length,1);assert.equal(q.feedback[0].kind,'gpu');assert.equal(q.feedback[0].ms,15);
  assert.equal(q.ctx.gpuCost.msPerVisit,15/8192);notices[1]();assert.equal(q.feedback.length,1);
});
