const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
const context={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/render/continuation.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {resumedContinuationOperations:operations,CONTINUATION_DISPATCH_OPERATIONS:cap,COLD_CONTINUATION_OPERATIONS:pixelCap,continuationOperations}=context.exports;
test('stationary slices amortize fences without exceeding either operation bound',()=>{
 for(const lanes of [1,9,128,256,512,768,1024,2048,4096])for(const admitted of [64,256,512,4096]){
  const motion=operations(admitted,lanes),still=operations(admitted,lanes,true);
  assert.ok(motion*lanes<=cap*2);assert.ok(still*lanes<=cap*4);assert.ok(still<=admitted&&still<=pixelCap);assert.ok(still>=motion);
  assert.equal(operations(admitted,lanes,false),motion);
 }
 assert.equal(operations(4096,512),4096);assert.equal(operations(4096,512,true),4096);
 assert.equal(operations(4096,4096),512);assert.equal(operations(4096,4096,true),1024);
 assert.equal(operations(4096,1,true),4096);
});
test('a new interaction immediately restores the motion slice allowance',()=>{
 const samples=[true,true,false,false,true,false].map(still=>operations(4096,1024,still));assert.deepEqual(samples,[4096,4096,2048,2048,4096,2048]);
 assert.equal(continuationOperations(1_000_000,0.000001,8),4096,'mandatory slicing remains active with optional hard-pixel work Off');
});
// Execute the actual renderer selection expression so the guard follows live view.
const source=ts.createSourceFile('renderer.ts',fs.readFileSync(path.join(__dirname,'../src/render/webgpu-renderer.ts'),'utf8'),ts.ScriptTarget.Latest,true);let declaration;
function walk(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='stationarySlice')declaration=node;ts.forEachChild(node,walk);}walk(source);assert.ok(declaration);
const expr=ts.transpileModule(`return ${declaration.initializer.getText(source)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const choose=new Function('request','family','ordinary','method','Method','MANDATORY_CONTINUATION_ITERATIONS',expr),Method={Direct:0};
function select(...args){return choose.call(this,...args,context.exports.MANDATORY_CONTINUATION_ITERATIONS);}
test('larger slices are restricted to live stationary ordinary Mandelbrot navigation',()=>{
 const p={moving:false,isInteracting(){return this.moving;}},request={followView:true,interacting:true,maxIterations:1_000_000};
 assert.equal(select.call(p,request,'mandelbrot',true,1,Method),true,'live stationary view overrides captured motion');
 p.moving=true;assert.equal(select.call(p,request,'mandelbrot',true,1,Method),false);p.moving=false;
 for(const [r,f,o,m] of [[{...request,followView:false},'mandelbrot',true,1],[{...request,maxIterations:999_999},'mandelbrot',true,1],[request,'julia',true,1],[request,'mandelbrot',false,1],[request,'mandelbrot',true,0]])assert.equal(select.call(p,r,f,o,m,Method),false);
});
