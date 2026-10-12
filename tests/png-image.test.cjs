const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
function loader(overrides={}) {
  const cache=new Map(Object.entries(overrides).map(([file,value])=>[path.resolve(root,file),value]));
  function load(file) {
    file=path.resolve(root,file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);
    const exports={};cache.set(file,exports);
    const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('exports','require',code)(exports,name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(path.join(root,'node_modules',name)));
    return exports;
  }
  return load;
}
const api=loader()('src/export/png-image.ts');
async function globals(values,run) {
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(global,key)]));
  for(const [key,value] of Object.entries(values))Object.defineProperty(global,key,{value,writable:true,configurable:true});
  try{return await run();}finally{for(const key of Object.keys(values)){if(previous[key])Object.defineProperty(global,key,previous[key]);else delete global[key];}}
}
function file(width,height) {const bytes=new Uint8Array(24),header=new DataView(bytes.buffer);header.setUint32(16,width);header.setUint32(20,height);return new Blob([bytes]);}
function decoderFixture(width,height,decode=async()=>{}) {
  const created=[],revoked=[],images=[];
  class Image {constructor(){this.naturalWidth=width;this.naturalHeight=height;this.removed=[];images.push(this);}decode(){return decode();}removeAttribute(name){this.removed.push(name);delete this[name];}}
  return {created,revoked,images,values:{Image,URL:{createObjectURL:blob=>{created.push(blob);return 'blob:png-test';},revokeObjectURL:url=>revoked.push(url)}}};
}
test('PNG display limits reject oversized axes, pixel area and zero sizes before allocating an image URL',async()=>{
  const f=decoderFixture(1,1);
  await globals(f.values,async()=>{for(const [w,h] of [[32769,1],[1,32769],[10000,8001],[0,1],[1,0]])await assert.rejects(api.decodePngImage(file(w,h)),/too large/);});
  assert.equal(f.created.length,0);assert.equal(f.images.length,0);assert.equal(f.revoked.length,0);
});
test('successful decode keeps original dimensions and releases its image and Blob URL exactly once',async()=>{
  const f=decoderFixture(1920,1080),blob=file(1920,1080);
  await globals(f.values,async()=>{const result=await api.decodePngImage(blob);assert.equal(result.image,f.images[0]);assert.equal(result.image.width,1920);assert.equal(result.image.height,1080);assert.equal(result.image.alt,'');assert.deepEqual(f.created,[blob]);assert.equal(f.revoked.length,0);result.release();result.release();assert.deepEqual(f.images[0].removed,['src']);assert.deepEqual(f.revoked,['blob:png-test']);});
});
test('decode rejection and decoded/header dimension mismatches both release allocations',async()=>{
  for(const [w,h,decode] of [[3,2,async()=>{throw Error('corrupt pixels');}],[4,2,async()=>{}]]){
    const f=decoderFixture(w,h,decode);
    await globals(f.values,async()=>{await assert.rejects(api.decodePngImage(file(3,2)),/could not be decoded.*current view was kept/);assert.deepEqual(f.revoked,['blob:png-test']);assert.deepEqual(f.images[0].removed,['src']);});
  }
});
function displayFixture(width,height) {
  const events={},draws=[],fills=[],pixels=new Uint8ClampedArray(33*33*4),index=(16*33+16)*4;pixels.set([17,34,51,255],index);
  const context={fillRect:(...args)=>fills.push(args),drawImage:(...args)=>draws.push(args),getImageData:()=>({data:pixels})};
  const sampler={getContext:(kind,options)=>{assert.equal(kind,'2d');assert.deepEqual(options,{willReadFrequently:true});return context;}};
  const layer={hidden:true,children:[],replaceChildren(...children){this.children=children;}},canvas={width,height};
  const values={window:{addEventListener:(name,fn)=>events[name]=fn},document:{createElement:kind=>{assert.equal(kind,'canvas');return sampler;}}};
  const image=(w,h)=>{let released=0;return {image:{naturalWidth:w,naturalHeight:h},release:()=>released++,get released(){return released;}};};
  return {events,draws,fills,pixels,sampler,layer,canvas,values,image};
}
test('wide PNG cropping and narrow PNG margins use centered viewport-height scaling for colour sampling',async()=>{
  const f=displayFixture(1000,500);
  await globals(f.values,async()=>{
    const display=api.setupPngImageDisplay(f.layer,f.canvas),wide=f.image(2000,500);display.show(wide,['view']);
    assert.equal(await display.sampleColour(500,250),'#112233');assert.deepEqual(f.draws.at(-1),[wide.image,-984,-234,2000,500]);
    const narrow=f.image(500,500);display.show(narrow,['view']);assert.equal(wide.released,1);
    await assert.rejects(display.sampleColour(249,250),/margin has no saved pixels/);await assert.rejects(display.samplePatch(750,250),/margin has no saved pixels/);
    const patch=await display.samplePatch(250,0);assert.equal(patch.width,33);assert.equal(patch.height,33);assert.equal(patch.pixels,f.pixels);assert.deepEqual(f.draws.at(-1),[narrow.image,16,16,500,500]);
    await assert.rejects(display.samplePatch(500,500),/margin has no saved pixels/);assert.equal(f.sampler.width,33);assert.equal(f.sampler.height,33);display.clear();
  });
});
test('viewport resizing keeps the saved image and recomputes sampling geometry from the new dimensions',async()=>{
  const f=displayFixture(1000,500);
  await globals(f.values,async()=>{const display=api.setupPngImageDisplay(f.layer,f.canvas),image=f.image(1000,500);display.show(image,[7,'camera']);
    f.canvas.width=1500;f.canvas.height=1000;assert.equal(display.reconcile([7,'camera']),false);assert.equal(display.active,true);assert.equal(image.released,0);
    await display.samplePatch(750,500);assert.deepEqual(f.draws.at(-1),[image.image,-984,-484,2000,1000]);display.clear();});
});
test('equivalent revision snapshots retain display; changed revisions, clear and pagehide release each owned image once',async()=>{
  const f=displayFixture(100,100);
  await globals(f.values,async()=>{const display=api.setupPngImageDisplay(f.layer,f.canvas),first=f.image(100,100);display.show(first,[3,'camera',true]);
    assert.equal(display.reconcile([3,'camera',true]),false);assert.equal(display.active,true);assert.equal(f.layer.hidden,false);assert.deepEqual(f.layer.children,[first.image]);
    assert.equal(display.reconcile([3,'changed',true]),true);assert.equal(display.active,false);assert.equal(f.layer.hidden,true);assert.deepEqual(f.layer.children,[]);assert.equal(first.released,1);assert.equal(display.clear(),false);
    const second=f.image(100,100);display.show(second,9);f.events.pagehide();f.events.pagehide();assert.equal(second.released,1);assert.equal(display.active,false);});
});
test('stopping animation preparation can retain the saved bitmap at its new generation without reallocating it',async()=>{
  const f=displayFixture(100,100);
  await globals(f.values,async()=>{const display=api.setupPngImageDisplay(f.layer,f.canvas),image=f.image(100,100);display.show(image,[3,'camera']);
    display.retain([4,'camera']);assert.equal(display.reconcile([4,'camera']),false);assert.deepEqual(f.layer.children,[image.image]);assert.equal(image.released,0);
    assert.equal(display.reconcile([4,'new camera']),true);assert.equal(image.released,1);assert.equal(display.active,false);
  });
});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function importFixture(openFailure=false) {
  const events={},input={},button={},pending=[],opened=[],messages=[];let revision=[0,'camera'];
  const readPngScene=async source=>({source}),decodePngImage=source=>{const gate=deferred();let released=0;const image={image:{},release:()=>released++,get released(){return released;}};pending.push({source,gate,image});return gate.promise;};
  const values={document:{getElementById:id=>id==='open-png'?button:input},window:{addEventListener:(name,fn)=>events[name]=fn}};
  const setup=()=>loader({'src/export/png-scene.ts':{readPngScene},'src/export/png-image.ts':{...api,decodePngImage}})('src/export/import.ts').setupPngSceneImport({open:(scene,image)=>{if(openFailure)throw Error('could not install image');opened.push({scene,image});},revision:()=>[...revision],message:text=>messages.push(text)});
  const drop=source=>events.drop({dataTransfer:{types:['Files'],files:[source]},preventDefault(){}});
  return {values,setup,drop,pending,opened,messages,navigate(){revision=[1,'camera'];}};
}
test('navigation and a newer import during decoding cannot install stale images and release them',async()=>{
  const f=importFixture();
  await globals(f.values,async()=>{f.setup();f.drop('old-navigation');await flush();f.navigate();f.pending[0].gate.resolve(f.pending[0].image);await flush();assert.equal(f.opened.length,0);assert.equal(f.pending[0].image.released,1);assert.match(f.messages.at(-1),/view changed/);
    f.drop('old-import');await flush();f.drop('new-import');await flush();f.pending[2].gate.resolve(f.pending[2].image);await flush();f.pending[1].gate.resolve(f.pending[1].image);await flush();
    assert.equal(f.opened.length,1);assert.equal(f.opened[0].scene.source,'new-import');assert.equal(f.pending[1].image.released,1);assert.equal(f.pending[2].image.released,0);f.opened[0].image.release();});
});
test('stale decoding failures stay silent and failed image installation releases ownership',async()=>{
  const f=importFixture();
  await globals(f.values,async()=>{f.setup();f.drop('stale-failure');await flush();f.drop('success');await flush();f.pending[1].gate.resolve(f.pending[1].image);await flush();const count=f.messages.length;f.pending[0].gate.reject(Error('old decoder error'));await flush();assert.equal(f.messages.length,count);assert.equal(f.opened.length,1);f.opened[0].image.release();});
  const g=importFixture(true);
  await globals(g.values,async()=>{g.setup();g.drop('failed-install');await flush();g.pending[0].gate.resolve(g.pending[0].image);await flush();assert.equal(g.opened.length,0);assert.equal(g.pending[0].image.released,1);assert.match(g.messages.at(-1),/could not install image/);});
});
