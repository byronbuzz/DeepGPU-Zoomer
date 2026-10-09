const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),ctx={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(root+'/src/render/continuation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,ctx);
const policy=ctx.exports;
test('only the measured BLA opt-in bypasses the nominal high-cap mandate',()=>{
 for(const cap of [1000000,1963041,10000000]){
  assert.equal(policy.continuationOperations(cap,.000001,8),4096);
  assert.equal(policy.continuationOperations(cap,.000001,8,false),4096);
  assert.equal(policy.continuationOperations(cap,.000001,8,true),0);
 }
 for(const cap of [10000,300000,600000,999999])assert.equal(policy.continuationOperations(cap,.000001,8,true),policy.continuationOperations(cap,.000001,8,false));
});
test('missing, invalid or expensive feedback remains bounded after BLA opt-in',()=>{
 for(const cap of [10000,1000000,10000000])for(const cost of [NaN,Infinity,-1,0,8.001,100])assert.equal(policy.continuationOperations(cap,cost,8,true),4096);
 assert.equal(policy.continuationOperations(4096,0,8,true),0);
 assert.equal(policy.CONTINUATION_MAX_LANES,32768);
 assert.equal(policy.coldCohortOperations(32768,true),128);
 assert.equal(policy.coldCohortOperations(32768,false),64);
 assert.equal(policy.resumedContinuationOperations(4096,1,false),4096);
});
test('renderer opt-in uses measured BLA admission separately from cohort eligibility',()=>{
 const source=ts.createSourceFile('renderer.ts',fs.readFileSync(root+'/src/render/webgpu-renderer.ts','utf8'),ts.ScriptTarget.Latest,true),calls=[];
 (function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='continuationOperations')calls.push(n);ts.forEachChild(n,visit);})(source);
 assert.equal(calls.length,1);assert.equal(calls[0].arguments.length,4);assert.equal(calls[0].arguments[3].getText(source),'measuredBlaEligible');
 // Existing cohort-policy tests exercise the actual predicate for Julia,
 // exports, endpoints/nonordinary channels, oversampling, rotation and plain paths.
 // Rotated admission has its own execution-policy tests.
 const shader=fs.readFileSync(root+'/src/render/continuation.wgsl','utf8');assert.match(shader,/pendingBits: array<atomic<u32>, 1024>/);
});
