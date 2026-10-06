const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),ts=require(root+'/node_modules/typescript');
const modules=new Map();
function load(file){
 file=path.resolve(root,file);if(!path.extname(file))file+='.ts';
 if(modules.has(file))return modules.get(file);
 const exports={};modules.set(file,exports);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','require',code)(exports,name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(root+'/node_modules/'+name));return exports;
}
const {ReferenceOrbitCache}=load('src/render/reference-cache.ts'),{prepareReference}=load('src/render/reference-preparation.ts'),{generatePackedReference,referenceIdentity}=load('src/render/reference-orbit.ts');
const input={family:'mandelbrot',centerX:'.25',centerY:'0',juliaX:'0',juliaY:'0',limbs:8,maxIterations:1000};
const hash=o=>crypto.createHash('sha256').update(Buffer.from(o.samples.buffer)).digest('hex');
const prep=async(i,previous)=>prepareReference(i,async(input,resume)=>generatePackedReference(input,resume,71),()=>{},previous);
test('exact revisit retains byte-identical completed payload with no worker iteration',async()=>{
 const c=new ReferenceOrbitCache(4,128*1024*1024),a=await prep(input);c.remember(input,a);
 const hit=c.get(input);assert.equal(hit,a);assert.equal(hit.samples.buffer,a.samples.buffer);
 assert.equal(hash(hit),hash(await prep(input)));assert.equal(c.get({...input,maxIterations:500}),a);
 c.remember({...input,maxIterations:500},hit);assert.equal(c.get(input),a);
});
test('cached prefix resumes without rounding and equals a fresh orbit',async()=>{
 const c=new ReferenceOrbitCache(4,128*1024*1024),short=await prep(input);c.remember(input,short);
 const extended={...input,maxIterations:1800},a=await prep(extended,c.get(extended));
 assert.equal(hash(a),hash(await prep(extended)));assert.equal(a.terminal.identity,referenceIdentity(extended));
 c.remember(extended,a);assert.equal(c.get(input),a);
});
test('identity includes precision, family, centre and Julia constant',async()=>{
 const c=new ReferenceOrbitCache(4,128*1024*1024);c.remember(input,await prep(input));
 for(const change of [{limbs:16},{family:'julia'},{centerX:'.2500001'},{centerY:'.1'},{juliaX:'.2'},{juliaY:'.3'}])assert.equal(c.get({...input,...change}),undefined);
});
test('LRU count and hard byte caps do not retain oversize or incomplete arrays',async()=>{
 const a=await prep(input),c=new ReferenceOrbitCache(1,a.samples.byteLength*2);
 c.remember(input,a);const binput={...input,centerX:'.26'},b=await prep(binput);c.remember(binput,b);
 assert.equal(c.get(input),undefined);assert.equal(c.get(binput),b);
 const small=new ReferenceOrbitCache(4,a.samples.byteLength-1);small.remember(input,a);assert.equal(small.get(input),undefined);
 assert.throws(()=>c.remember({...input,maxIterations:2000},a),/incomplete|incompatible/);
 assert.throws(()=>c.remember(input,{...a,sampleWords:20}),/incomplete|incompatible/);
 c.clear();assert.equal(c.get(binput),undefined);
});

test('reads promote LRU entries and retained bytes independently evict oldest payloads',async()=>{
 const inputs=[input,{...input,centerX:'.24'},{...input,centerX:'.23'}],payloads=await Promise.all(inputs.map(i=>prep(i)));
 for(const [count,bytes] of [[2,Infinity],[4,payloads[0].samples.byteLength*2]]){
  const c=new ReferenceOrbitCache(count,bytes);c.remember(inputs[0],payloads[0]);c.remember(inputs[1],payloads[1]);
  assert.equal(c.get(inputs[0]),payloads[0]);c.remember(inputs[2],payloads[2]);
  assert.equal(c.get(inputs[1]),undefined);assert.equal(c.get(inputs[0]),payloads[0]);assert.equal(c.get(inputs[2]),payloads[2]);
 }
});

test('an escaped completed trajectory satisfies higher caps without replacing its prefix',async()=>{
 const i={...input,centerX:'2'},a=await prep(i),c=new ReferenceOrbitCache(4,128*1024*1024);
 assert.equal(a.escaped,true);assert.ok(a.terminal.iteration<i.maxIterations);c.remember(i,a);
 assert.equal(c.get({...i,maxIterations:10000000}),a);c.remember({...i,maxIterations:10000000},a);assert.equal(c.get(i),a);
});

test('cache admits only compatible complete whole-buffer payloads',async()=>{
 const a=await prep(input),c=new ReferenceOrbitCache(4,128*1024*1024),backing=new Float32Array(a.samples.length+20);
 const sliced=backing.subarray(10,10+a.samples.length);sliced.set(a.samples);
 for(const invalid of [{...a,formatVersion:a.formatVersion+1},{...a,length:a.length-1},
  {...a,terminal:{...a.terminal,identity:'other'}},{...a,escaped:!a.escaped},{...a,samples:sliced}]){
  assert.throws(()=>c.remember(input,invalid),/incomplete|incompatible/);assert.equal(c.get(input),undefined);
 }
});

test('cancelled extension leaves the cached exact prefix unchanged',async()=>{
 const c=new ReferenceOrbitCache(4,128*1024*1024),a=await prep(input),before=hash(a);c.remember(input,a);
 let current=true,workers=0;const failure=new Error('superseded');
 await assert.rejects(prepareReference({...input,maxIterations:1800},async(i,resume)=>{
  workers++;const result=generatePackedReference(i,resume,71);current=false;return result;
 },()=>{if(!current)throw failure;},c.get(input)),e=>e===failure);
 assert.equal(workers,1);assert.equal(c.get(input),a);assert.equal(hash(a),before);assert.equal(a.terminal.iteration,1000);
});

// Execute the production renderer methods up to their GPU boundary. These
// tests inspect real cache/preparation/abort decisions without any GPU work.
const vm=require('node:vm'),sourceFile=path.join(root,'src/render/webgpu-renderer.ts');
const sf=ts.createSourceFile(sourceFile,fs.readFileSync(sourceFile,'utf8'),ts.ScriptTarget.Latest,true);
const renderer=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='WebGpuRenderer');
const names=['generateOrbit','dispose','abort','clearContinuationWork','cancelPendingReference'];
const actual=names.map(name=>{const node=renderer.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.text===name);assert.ok(node);return node.getText(sf);}).join('\n');
const stopBeforeGpu=new Error('GPU boundary'),context={exports:{},performance,DOMException,Set,Map,CoverageRegions:load('src/render/regions.ts').CoverageRegions,
 REFERENCE_CHUNK_ITERATIONS:65536,REFERENCE_FORMAT_VERSION:2,REFERENCE_TRANSFER_FLOATS:1048576,referenceIdentity,
 prepareReference:async(i,generate,check,previous,yieldForCopy)=>prepareReference(i,generate,check,previous,yieldForCopy),
 yieldToEvents:async()=>{},checkedGpu:()=>{context.gpuEntries++;throw stopBeforeGpu;},gpuEntries:0};
vm.runInNewContext(ts.transpileModule(`class Probe { ${actual} } exports.Probe=Probe;`,
 {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
function probe(c,active){
 const p=new context.exports.Probe();let workers=0;const request={input,followView:false,isCurrent:()=>true};
 Object.assign(p,{ctx:{device:{limits:{maxStorageBufferBindingSize:2**28,maxBufferSize:2**28},queue:{onSubmittedWorkDone:async()=>{}}}},
  referenceCache:c,referenceDemand:()=>({...request,referenceX:0,referenceY:0}),referenceDemandCompatible:()=>true,
  ensureComputePipeline:async()=>{},referenceWorker:{generate:async(i,resume,budget)=>{workers++;return generatePackedReference(i,resume,Math.min(budget,71));},cancel:()=>{}},
  refValid:!!active,refSamples:active?.samples,refTerminal:active?.terminal,refFormatVersion:active?.formatVersion,refSampleWords:active?.sampleWords,
  activeOperations:new Set(),pendingPipelines:new Map(),ordinaryShapePipelines:new Map(),lossHook:{notify:()=>{}},
  timing:{dispose:()=>{}},context:{unconfigure:()=>{}},pending:{reset:()=>{}},pendingContinuation:{clear:()=>{}},publicationEpoch:0,
  orbitBuffer:{destroy:()=>{}},abortRequested:false,disposed:false});
 return {p,request,workers:()=>workers};
}

test('renderer cache hit bypasses worker but checks cancellation before GPU adoption',async()=>{
 const a=await prep(input),c=new ReferenceOrbitCache(4,128*1024*1024);c.remember(input,a);
 const {p,request,workers}=probe(c);context.gpuEntries=0;
 await assert.rejects(p.generateOrbit(request,8),e=>e===stopBeforeGpu);assert.equal(workers(),0);assert.equal(context.gpuEntries,1);
 const oldGpu=p.orbitBuffer;p.abortRequested=true;context.gpuEntries=0;
 await assert.rejects(p.generateOrbit(request,8),e=>e.name==='AbortError');
 assert.equal(workers(),0);assert.equal(context.gpuEntries,0);assert.equal(p.orbitBuffer,oldGpu);assert.equal(p.pendingReferenceDemand,null);
});

test('renderer resumes the longer active prefix after an extension outgrows cache',async()=>{
 const small=await prep(input),largerInput={...input,maxIterations:1800},active=await prep(largerInput,small);
 const c=new ReferenceOrbitCache(4,small.samples.byteLength);c.remember(input,small);c.remember(largerInput,active);
 assert.equal(c.get(input),small);const {p,request,workers}=probe(c,active),wanted={...input,maxIterations:1900};
 p.referenceDemand=()=>({...request,input:wanted,referenceX:0,referenceY:0});
 const ordinary=context.prepareReference;let selected;
 context.prepareReference=async(...args)=>{selected=args[3];return ordinary(...args);};
 try{await assert.rejects(p.generateOrbit(request,8),e=>e===stopBeforeGpu);}finally{context.prepareReference=ordinary;}
 assert.equal(selected.samples,active.samples);assert.equal(workers(),2);assert.equal(c.get(input),small);assert.equal(hash(active),hash(await prep(largerInput)));
});

test('cached CPU completion cannot install GPU data after abort during decoder preparation',async()=>{
 const a=await prep(input),c=new ReferenceOrbitCache(4,128*1024*1024);c.remember(input,a);const {p,request,workers}=probe(c);
 let resume;const gate=new Promise(resolve=>resume=resolve);p.ensureComputePipeline=()=>gate;
 context.gpuEntries=0;const oldGpu=p.orbitBuffer,job=p.generateOrbit(request,8);p.abort();resume();
 await assert.rejects(job,e=>e.name==='AbortError');assert.equal(context.gpuEntries,0);assert.equal(workers(),0);
 assert.equal(p.orbitBuffer,oldGpu);assert.equal(c.get(input),a);
});

test('renderer disposal clears completed CPU cache while retaining shared GPU device ownership',async()=>{
 const a=await prep(input),c=new ReferenceOrbitCache(4,128*1024*1024);c.remember(input,a);const {p}=probe(c);
 let gpuDestroyed=0;p.ctx.device.destroy=()=>gpuDestroyed++;
 await p.dispose();assert.equal(c.get(input),undefined);assert.equal(p.refSamples,null);assert.equal(gpuDestroyed,0);
 assert.equal(await p.dispose(),undefined);
});
