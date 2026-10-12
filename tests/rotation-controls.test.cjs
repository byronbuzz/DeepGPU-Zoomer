const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript')),cache=new Map();
function load(file){file=path.resolve(root,file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(path.join(root,'node_modules',name)));return exports;}
const rotation=load('src/colour-rotation.ts'),state=load('src/state.ts'),{DEFAULT_COLORS}=load('src/logic/colorSettings.ts');

test('rotation controls map slow-left 30 seconds to fast-right .1 seconds and roundtrip the default and intermediate periods',()=>{
 assert.equal(rotation.rotationSecondsFromSlider(0),30);assert.equal(rotation.rotationSecondsFromSlider(1),.1);
 assert.equal(rotation.rotationSecondsFromSlider(-1),30);assert.equal(rotation.rotationSecondsFromSlider(2),.1);
 for(const seconds of [.1,.15,.5,1,3,10,17,30])assert.ok(Math.abs(rotation.rotationSecondsFromSlider(rotation.rotationSecondsToSlider(seconds))-seconds)<1e-12);
 assert.equal(rotation.normalizeRotationSeconds(Infinity),10);assert.equal(rotation.normalizeRotationSeconds(0),.1);assert.equal(rotation.normalizeRotationSeconds(60),30);
 const defaults=load('src/range-controls.ts').RANGE_DEFAULTS;
 assert.equal(defaults['rotation-speed'],rotation.rotationSecondsToSlider(10));assert.equal(defaults['panel-opacity'],.7);
});

test('fast and slow periods animate in either direction and survive exact saved-view link roundtrips',()=>{
 const initial={...DEFAULT_COLORS,offset:.2,lightAngle:45};
 for(const period of [.1,30]){
  const view=state.validateView({...state.HOME,rotationSeconds:period,rotatePalette:true,rotateLight:true,reverseRotation:true});
  assert.deepEqual(state.decodeView(state.encodeView(view)),view);
  const forward=rotation.advanceColourRotation(initial,period/4,period,true,true),reverse=rotation.advanceColourRotation(initial,period/4,period,true,true,true);
  assert.ok(Math.abs(forward.offset-.2625)<1e-12);assert.equal(forward.lightAngle,135);
  assert.ok(Math.abs(reverse.offset-.1375)<1e-12);assert.equal(reverse.lightAngle,315);
 }
});
test('PNG metadata preserves every combination of palette/light rotation flags and the fastest/slowest speed',async()=>{
 const {createStreamingPng}=load('src/export/png.ts'),{readPngScene}=load('src/export/png-scene.ts');
 for(const rotatePalette of [false,true])for(const rotateLight of [false,true])for(const rotationSeconds of [.1,30]){
  const scene=state.validateView({...state.HOME,appearance:DEFAULT_COLORS,rotatePalette,rotateLight,rotationSeconds,reverseRotation:true});
  const writer=createStreamingPng(1,1,{scene,maxEncodedBytes:20000});await writer.appendRows(new Uint8Array([12,34,56,255]));
  assert.deepEqual(await readPngScene(await writer.finish()),scene);
 }
});
