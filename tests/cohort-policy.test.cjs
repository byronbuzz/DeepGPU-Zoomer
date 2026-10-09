const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.join(__dirname,'..'),ctx={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(root+'/src/render/continuation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,ctx);
const p=ctx.exports;
test('expanded capacity preserves every incumbent aggregate bound for cold and resumed work',()=>{
 assert.ok([32768,65536].includes(p.CONTINUATION_MAX_LANES));assert.equal(p.CONTINUATION_DISPATCH_OPERATIONS,1048576);
 for(let lanes=1;lanes<=p.CONTINUATION_MAX_LANES;lanes++)for(const still of [false,true]){
  const cold=p.coldCohortOperations(lanes,still),resume=p.resumedContinuationOperations(4096,lanes,still);
  assert.ok(cold*lanes<=1048576*(still?4:2));assert.ok(resume*lanes<=1048576*(still?4:2));assert.ok(resume>=cold);
 }
 assert.equal(p.coldCohortOperations(p.CONTINUATION_MAX_LANES,true),4194304/p.CONTINUATION_MAX_LANES);
 assert.equal(p.coldCohortOperations(p.CONTINUATION_MAX_LANES,false),2097152/p.CONTINUATION_MAX_LANES);
 assert.equal(p.resumedContinuationOperations(4096,1,false),4096,'cold quantum never traps saved survivors at the small allowance');
});
test('host bitmap, GPU bitmap and maximum state layout agree; oversampling retains prior capacity',()=>{
 const shader=fs.readFileSync(root+'/src/render/continuation.wgsl','utf8'),words=Number(shader.match(/pendingBits: array<atomic<u32>, (\d+)>/)[1]);
 assert.equal(words*32,p.CONTINUATION_MAX_LANES);assert.equal(p.CONTINUATION_HEADER_BYTES,16+words*4);assert.equal(p.CONTINUATION_HEADER_BYTES%16,0);
 const region=p.continuationRegion(128,p.CONTINUATION_MAX_LANES/128,1,32_000_000);
 assert.equal(region.bytes,p.CONTINUATION_HEADER_BYTES+p.CONTINUATION_MAX_LANES*352);
 assert.equal(p.continuationLaneLimit(region.bytes),p.CONTINUATION_MAX_LANES);
 assert.throws(()=>p.continuationRegion(32,16,1,32_000_000,3),/capacity/);
});
const renderer=ts.createSourceFile('renderer.ts',fs.readFileSync(root+'/src/render/webgpu-renderer.ts','utf8'),ts.ScriptTarget.Latest,true),declarations=new Map();
(function walk(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name))declarations.set(n.name.text,n);ts.forEachChild(n,walk);})(renderer);
const eligibleExpression=declarations.get('cohortEligible').initializer.getText(renderer);
const measuredExpression=declarations.get('measuredBlaEligible').initializer.getText(renderer);
const eligible=new Function('request','ordinary','family','pipelineKind',`const measuredBlaEligible=${measuredExpression};return ${eligibleExpression};`);
test('new cohort policy excludes Julia, export, slope, oversampling and non-BLA arithmetic',()=>{
 const request={followView:true},ordinary=true,family='mandelbrot',kind='approx';assert.equal(eligible(request,ordinary,family,kind),true);
 for(const [r,o,f,k]of [[{...request,followView:false},true,family,kind],[request,false,family,kind],[request,true,'julia',kind],[request,true,family,'plain'],[{...request,angle:1},true,family,kind],[{...request,exportDomain:{}},true,family,kind],[{...request,stationaryOversampling:true},true,family,kind]])assert.equal(eligible(r,o,f,k),false);
});
