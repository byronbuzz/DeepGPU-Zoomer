const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
const source=ts.createSourceFile('renderer.ts',fs.readFileSync(root+'/src/render/webgpu-renderer.ts','utf8'),ts.ScriptTarget.Latest,true),declarations=new Map(),calls=[];
(function visit(n){
 if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name))declarations.set(n.name.text,n);
 if(ts.isCallExpression(n)&&n.expression.getText(source)==='continuationOperations')calls.push(n);
 ts.forEachChild(n,visit);
})(source);
const ctx={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(root+'/src/render/continuation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,ctx);
function predicates(request,ordinary=true,family='mandelbrot',pipelineKind='approx'){
 const admission=declarations.get('measuredBlaEligible');
 assert.ok(admission,'measured admission must have its own eligibility');
 const cohort=declarations.get('cohortEligible');
 return new Function('request','ordinary','family','pipelineKind',
  `const measuredBlaEligible=${admission.initializer.getText(source)};return {admission:measuredBlaEligible,cohort:${cohort.initializer.getText(source)}};`)(request,ordinary,family,pipelineKind);
}
test('rotation changes measured admission without widening cold-cohort eligibility',()=>{
 for(const angle of [Math.PI/6,-Math.PI/4,Math.PI,Math.PI*2]){
  const p=predicates({followView:true,angle});
  assert.equal(p.admission,true);assert.equal(p.cohort,false);
  assert.equal(ctx.exports.continuationOperations(1963041,0,8,p.admission),4096,'cold work remains bounded');
  assert.equal(ctx.exports.continuationOperations(1963041,.000001,8,p.admission),0,'measured rotated work may use ordinary');
  assert.equal(ctx.exports.continuationOperations(1963041,9,8,p.admission),4096,'expensive feedback retains continuation');
 }
 assert.deepEqual(predicates({followView:true,angle:0}),{admission:true,cohort:true});
});
test('rotated Julia, exports, oversampling, endpoints and non-BLA paths retain the high-cap mandate',()=>{
 const request={followView:true,angle:Math.PI/6};
 for(const [r,o,f,k]of [[{...request,followView:false},true,'mandelbrot','approx'],[request,false,'mandelbrot','approx'],[request,true,'julia','approx'],[request,true,'mandelbrot','plain'],[{...request,exportDomain:{}},true,'mandelbrot','approx'],[{...request,stationaryOversampling:true},true,'mandelbrot','approx']]){
  const p=predicates(r,o,f,k);assert.equal(p.admission,false);assert.equal(p.cohort,false);
  assert.equal(ctx.exports.continuationOperations(1963041,.000001,8,p.admission),4096);
 }
});
test('actual renderer dispatch admission uses the separate eligibility',()=>{
 assert.equal(calls.length,1);assert.equal(calls[0].arguments[3].getText(source),'measuredBlaEligible');
});
test('actual ordinary appearance gate excludes endpoint and special shading work',()=>{
 const colorSource=ts.createSourceFile('colors.ts',fs.readFileSync(root+'/src/logic/colorSettings.ts','utf8'),ts.ScriptTarget.Latest,true);
 const selected=colorSource.statements.filter(s=>(ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(colorSource)==='ENDPOINT_FORMULAS'))||(ts.isFunctionDeclaration(s)&&s.name?.text==='needsEndpoints')).map(s=>s.getText(colorSource)).join('\n');
 const colorsContext={exports:{}};vm.runInNewContext(ts.transpileModule(selected,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,colorsContext);
 const ordinary=new Function('colors','grid','needsEndpoints',`return function(){return ${declarations.get('ordinary').initializer.getText(source)}}`);
 const baseline={mode:0,supersample:1,capped:0,formula:1,effect:0};
 assert.equal(ordinary(baseline,1,colorsContext.exports.needsEndpoints).call({retainEndpoints:false}),true);
 for(const [colors,grid,retain] of [[{...baseline,mode:1},1,false],[{...baseline,supersample:2},1,false],[{...baseline,capped:1},1,false],[{...baseline,formula:2},1,false],[{...baseline,effect:5},1,false],[baseline,2,false],[baseline,1,true]]){
  assert.equal(ordinary(colors,grid,colorsContext.exports.needsEndpoints).call({retainEndpoints:retain}),false);
 }
});
test('rotated continuation state remains excluded from carrying and survivor pooling',()=>{
 for(const name of ['carryEligible','poolEligible'])assert.match(declarations.get(name).initializer.getText(source),/!request\.angle/);
});
