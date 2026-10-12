const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
function loader(overrides={}) {
  const cache=new Map(Object.entries(overrides).map(([file,value])=>[path.resolve(root,file),value]));
  function load(file) {
    file=path.resolve(root,file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);
    const exports={};cache.set(file,exports);
    const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('exports','require',code)(exports,name=>name.endsWith('?raw')?{default:fs.readFileSync(path.resolve(path.dirname(file),name.slice(0,-4)),'utf8')}:name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(path.join(root,'node_modules',name)));
    return exports;
  }
  return load;
}
const load=loader(),{sceneChunk,readPngScene,MAX_SCENE_BYTES}=load('src/export/png-scene.ts'),{chunk}=load('src/export/png-chunks.ts'),{createStreamingPng}=load('src/export/png.ts');
const {HOME,validateView}=load('src/state.ts'),{DEFAULT_COLORS}=load('src/logic/colorSettings.ts');
const signature=Uint8Array.from([137,80,78,71,13,10,26,10]);
const deep=JSON.parse(fs.readFileSync(path.join(root,'src/default-locations.json'),'utf8')).locations.find(x=>x.name==='Eon 10^1000').view;
const scene=validateView({...deep,family:'julia',angle:37.2,rotationSeconds:17,rotatePalette:true,rotateLight:true,reverseRotation:true,appearance:{...deep.appearance,oversampling:true,locks:deep.appearance.stops.map((_,i)=>i===1)}});
function chunks(bytes){const result=[];for(let offset=8;offset<bytes.length;){const length=new DataView(bytes.buffer,bytes.byteOffset+offset,4).getUint32(0);result.push({offset,type:String.fromCharCode(...bytes.subarray(offset+4,offset+8)),data:bytes.subarray(offset+8,offset+8+length),bytes:bytes.subarray(offset,offset+12+length)});offset+=length+12;}return result;}
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return (value^0xffffffff)>>>0;}
async function image(value=scene){const writer=createStreamingPng(3,2,{maxEncodedBytes:100000,scene:value});await writer.appendRows(Uint8Array.from({length:24},(_,i)=>(i*37)%256));return writer.finish();}
function rebuild(parts){return new Blob([signature,...parts]);}
function recordChunk(record){return chunk('iTXt',new TextEncoder().encode('DeepGPU-Zoomer Scene\0\0\0\0\0'+JSON.stringify(record)));}

test('deep Julia scene, appearance and motion settings round-trip exactly; PNG pixels and CRCs stay unchanged',async()=>{
  const withScene=await image(),actual=await readPngScene(withScene);
  assert.deepEqual(actual,scene);assert.equal(actual.span,deep.span);assert.equal(actual.x,deep.x);
  const a=chunks(new Uint8Array(await withScene.arrayBuffer()));
  const plainWriter=createStreamingPng(3,2,{maxEncodedBytes:100000});await plainWriter.appendRows(Uint8Array.from({length:24},(_,i)=>(i*37)%256));const b=chunks(new Uint8Array(await (await plainWriter.finish()).arrayBuffer()));
  assert.deepEqual(a.filter(x=>x.type!=='iTXt').map(x=>x.bytes),b.map(x=>x.bytes));
  for(const c of a)assert.equal(new DataView(c.bytes.buffer,c.bytes.byteOffset+c.bytes.length-4,4).getUint32(0),crc(c.bytes.subarray(4,c.bytes.length-4)));
  const filtered=zlib.inflateSync(Buffer.concat(a.filter(x=>x.type==='IDAT').map(x=>Buffer.from(x.data))));
  assert.equal(filtered[0],0);assert.equal(filtered[13],0);
  assert.deepEqual([...filtered.subarray(1,13),...filtered.subarray(14)],Array.from({length:24},(_,i)=>(i*37)%256));
});

test('scene is copied at encoder creation and metadata counts toward the output budget',async()=>{
  const mutable=JSON.parse(JSON.stringify(scene));const writer=createStreamingPng(1,1,{maxEncodedBytes:100000,scene:mutable});
  mutable.x='0';mutable.appearance.stops[0]='#123456';await writer.appendRows(new Uint8Array(4));
  assert.deepEqual(await readPngScene(await writer.finish()),scene);
  assert.throws(()=>createStreamingPng(1,1,{maxEncodedBytes:sceneChunk(scene).length+44,scene}),/memory budget/);
});

test('plain PNGs and non-PNG inputs do not produce a scene',async()=>{
  const writer=createStreamingPng(1,1,{maxEncodedBytes:100000});await writer.appendRows(new Uint8Array(4));
  await assert.rejects(readPngScene(await writer.finish()),/no saved DeepGPU location/);
  await assert.rejects(readPngScene(new Blob([new Uint8Array(100)])),/not a PNG/);
});

test('malformed, duplicate, unsupported and oversized metadata is rejected',async()=>{
  const all=chunks(new Uint8Array(await (await image()).arrayBuffer())),header=all.find(x=>x.type==='IHDR').bytes,idat=all.find(x=>x.type==='IDAT').bytes,end=all.find(x=>x.type==='IEND').bytes;
  const metadata=sceneChunk(scene),damaged=metadata.slice();damaged[damaged.length-1]^=1;
  await assert.rejects(readPngScene(rebuild([header,damaged,idat,end])),/damaged/);
  await assert.rejects(readPngScene(rebuild([header,metadata,idat,metadata,end])),/multiple saved/);
  await assert.rejects(readPngScene(rebuild([header,recordChunk({format:'DeepGPU-Zoomer',version:2,view:scene}),idat,end])),/not supported/);
  await assert.rejects(readPngScene(rebuild([header,recordChunk({format:'DeepGPU-Zoomer',version:1,view:{...scene,iterations:0}}),idat,end])),/Iteration limit/);
  await assert.rejects(readPngScene(rebuild([header,chunk('iTXt',new TextEncoder().encode('DeepGPU-Zoomer Scene\0\0\0missing-separators')),idat,end])),/metadata is invalid/);
  const payload=new Uint8Array(MAX_SCENE_BYTES+1);payload.set(new TextEncoder().encode('DeepGPU-Zoomer Scene'));
  await assert.rejects(readPngScene(rebuild([header,chunk('iTXt',payload),idat,end])),/metadata is invalid/);
  const compressed=all.find(x=>x.type==='iTXt').data.slice();compressed[compressed.indexOf(0)+1]=1;
  await assert.rejects(readPngScene(rebuild([header,chunk('iTXt',compressed),idat,end])),/Compressed/);
  await assert.rejects(readPngScene(rebuild([header,chunk('iTXt',new TextEncoder().encode('DeepGPU-Zoomer Scene\0\0\0\0\0{bad-json')),idat,end])),/metadata is invalid/);
});

test('structure is checked through IEND, even after finding a valid scene',async()=>{
  const bytes=new Uint8Array(await (await image()).arrayBuffer()),all=chunks(bytes),metadata=sceneChunk(scene);
  await assert.rejects(readPngScene(new Blob([bytes.subarray(0,bytes.length-1)])),/truncated|invalid/);
  await assert.rejects(readPngScene(new Blob([bytes,new Uint8Array(1)])),/invalid/);
  await assert.rejects(readPngScene(rebuild([all[0].bytes,metadata,all.at(-1).bytes])),/incomplete/);
  await assert.rejects(readPngScene(rebuild([all[0].bytes,metadata,all[0].bytes,all[2].bytes,all.at(-1).bytes])),/multiple image headers/);
  const badLength=bytes.slice();new DataView(badLength.buffer).setUint32(8,0x7fffffff);
  await assert.rejects(readPngScene(new Blob([badLength])),/structure/);
  assert.deepEqual(await readPngScene(rebuild([all[0].bytes,chunk('tEXt',new TextEncoder().encode('Other\0value')),metadata,...all.filter(x=>x.type==='IDAT').map(x=>x.bytes),all.at(-1).bytes])),scene);
});

test('uncompressed iTXt ignores the compression method as required by PNG',async()=>{
  const all=chunks(new Uint8Array(await (await image()).arrayBuffer()));
  const metadata=all.find(x=>x.type==='iTXt').data.slice();metadata[metadata.indexOf(0)+2]=1;
  assert.deepEqual(await readPngScene(rebuild(all.map(x=>x.type==='iTXt'?chunk('iTXt',metadata):x.bytes))),scene);
});

test('large pixel payloads are skipped with bounded reads; oversize files are rejected before any read',async()=>{
  const all=chunks(new Uint8Array(await (await image()).arrayBuffer())),start=new Blob([signature,all[0].bytes,sceneChunk(scene)]),idatOffset=start.size;
  const length=16*1024*1024,header=new Uint8Array(8);new DataView(header.buffer).setUint32(0,length);header.set(new TextEncoder().encode('IDAT'),4);
  const endOffset=idatOffset+length+12,end=chunk('IEND',new Uint8Array(0)),segments=[[0,new Uint8Array(await start.arrayBuffer())],[idatOffset,header],[endOffset,end]],reads=[];
  const file={size:endOffset+end.length,slice(begin,finish){reads.push([begin,finish]);const bytes=new Uint8Array(finish-begin);for(const [offset,value] of segments){const from=Math.max(offset,begin),to=Math.min(offset+value.length,finish);if(to>from)bytes.set(value.subarray(from-offset,to-offset),from-begin);}return new Blob([bytes]);}};
  assert.deepEqual(await readPngScene(file),scene);
  assert.ok(reads.reduce((sum,[a,b])=>sum+b-a,0)<MAX_SCENE_BYTES);
  assert.ok(reads.every(([a,b])=>!(a<endOffset&&b>idatOffset+8)));
  await assert.rejects(readPngScene({size:512*1024*1024+1,slice(){throw Error('must not read');}}),/512 MB/);
});

function importHarness(){
  const events={},input={value:'',files:[],clicks:0,click(){this.clicks++;}},button={},messages=[],opened=[];let revision='0:0';
  const previousDocument=global.document,previousWindow=global.window;
  global.document={getElementById:id=>id==='open-png'?button:input};global.window={addEventListener:(name,fn)=>events[name]=fn};
  const imageApi=load('src/export/png-image.ts');
  try{loader({'src/export/png-image.ts':{...imageApi,decodePngImage:async()=>({image:{},release(){}})}})('src/export/import.ts').setupPngSceneImport({open:view=>opened.push(view),revision:()=>revision,message:text=>messages.push(text)});}finally{global.document=previousDocument;global.window=previousWindow;}
  const drop=files=>{let prevented=false;events.drop({dataTransfer:{types:['Files'],files},preventDefault(){prevented=true;}});return prevented;};
  return {input,button,events,messages,opened,drop,navigate:()=>revision='0:1'};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
function delayed(blob){let release;const gate=new Promise(resolve=>release=resolve);let first=true;return {release,file:{size:blob.size,slice(a,b){const part=blob.slice(a,b);if(!first)return part;first=false;return {arrayBuffer:async()=>{await gate;return part.arrayBuffer();}};}}};}

test('drop and keyboard-accessible picker share validated opening; invalid/multiple files leave the view untouched',async()=>{
  const h=importHarness(),blob=await image();assert.equal(h.drop([blob]),true);await settle();assert.deepEqual(h.opened,[scene]);
  h.button.onclick();assert.equal(h.input.clicks,1);h.input.files=[blob];h.input.value='file.png';h.input.onchange();assert.equal(h.input.value,'');await settle();assert.equal(h.opened.length,2);
  h.drop([blob,blob]);await settle();assert.equal(h.opened.length,2);assert.match(h.messages.at(-1),/one DeepGPU PNG/);
  h.drop([new Blob([new Uint8Array(100)])]);await settle();assert.equal(h.opened.length,2);assert.match(h.messages.at(-1),/not a PNG/);
  let prevented=false;h.events.drop({dataTransfer:{types:['text/plain'],files:[]},preventDefault(){prevented=true;}});assert.equal(prevented,false);
});

test('older imports cannot overwrite subsequent navigation or a newer import, including stale failures',async()=>{
  const blob=await image(),h=importHarness(),a=delayed(blob);h.drop([a.file]);h.navigate();a.release();await settle();assert.equal(h.opened.length,0);assert.match(h.messages.at(-1),/view changed/);
  const b=delayed(blob);h.drop([b.file]);h.drop([blob]);await settle();b.release();await settle();assert.equal(h.opened.length,1);
  const invalid=delayed(new Blob([new Uint8Array(100)]));h.drop([invalid.file]);h.drop([blob]);await settle();const count=h.messages.length;invalid.release();await settle();assert.equal(h.opened.length,2);assert.equal(h.messages.length,count);
});

test('captured quality export stores the synchronous scene before asynchronous readback',async()=>{
  const Decimal=require(path.join(root,'node_modules/decimal.js')),initial=JSON.parse(JSON.stringify(scene)),request={centerX:new Decimal(initial.x),centerY:new Decimal(initial.y),unitsPerPixel:new Decimal(initial.span).div(2),width:3,height:2,family:initial.family,maxIterations:initial.iterations,juliaX:new Decimal(initial.jx),juliaY:new Decimal(initial.jy),colors:initial.appearance};
  let resolveCapture,exportedScene,frozenRequest;const capture=new Promise(resolve=>resolveCapture=resolve),elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{hidden:true,value:'',disabled:false,textContent:'',style:{},setAttribute(){},addEventListener(){},dispatchEvent(){},focus(){},append(){},click(){},remove(){}});return elements.get(id);};
  const previous={document:global.document,window:global.window,setTimeout:global.setTimeout};
  global.document={getElementById:el,createElement:()=>el('anchor'),body:el('body')};global.window={addEventListener(){}};global.setTimeout=()=>0;
  try{
    const panel=loader({'src/export/render.ts':{snapshotExportRequest:r=>({...r,colors:{...r.colors,supersample:1}}),canReuseExportPixels:()=>true,encodeCapturedExport:async(frame,signal,value)=>{exportedScene=value;return image(value);},renderPng:()=>{throw Error('wrong export route');}}})('src/export/panel.ts');
    panel.setupPngExportPanel({context:()=>({}),request:()=>request,scene:()=>initial,viewport:()=>({width:3,height:2}),captureQuality:r=>{frozenRequest=r;return capture;}});
    el('screenshot').onclick();const pending=el('png-save').onclick();initial.x='0';initial.appearance.stops[0]='#123456';resolveCapture({width:6,height:4,pixels:new Uint8Array(96)});await pending;
    assert.equal(frozenRequest.colors.supersample,1);assert.deepEqual(exportedScene,scene);
  }finally{global.document=previous.document;global.window=previous.window;global.setTimeout=previous.setTimeout;}
});

test('actual tiled and captured encoders carry the same scene and preserve assembled pixels',async()=>{
  const Decimal=require(path.join(root,'node_modules/decimal.js')),requests=[];
  class Renderer {
    async init(){} abort(){} async dispose(){this.disposed=true;}
    async render(request){requests.push(request);return {completed:true};}
    async capturePixels(request){const pixels=new Uint8Array(request.width*request.height*4);for(let y=0;y<request.height;y++)for(let x=0;x<request.width;x++){const i=(y*request.width+x)*4;pixels[i]=(x+request.exportDomain.x)&255;pixels[i+1]=(y+request.exportDomain.y)&255;pixels[i+3]=255;}return {pixels};}
  }
  const api=loader({'src/render/webgpu-renderer.ts':{WebGpuRenderer:Renderer}})('src/export/render.ts');
  const request={centerX:new Decimal(scene.x),centerY:new Decimal(scene.y),unitsPerPixel:new Decimal(scene.span).div(2),width:3,height:2,family:scene.family,maxIterations:scene.iterations,juliaX:new Decimal(scene.jx),juliaY:new Decimal(scene.jy),colors:scene.appearance};
  const previousDocument=global.document;global.document={createElement:()=>({width:1,height:1})};
  try{
    const output=await api.renderPng({device:{limits:{maxTextureDimension2D:4096,maxStorageBufferBindingSize:64*1024*1024,maxBufferSize:128*1024*1024}}},request,{width:1025,height:2},new AbortController().signal,()=>{},scene);
    assert.ok(requests.length>1);assert.deepEqual(await readPngScene(output),scene);
    const parts=chunks(new Uint8Array(await output.arrayBuffer())),filtered=zlib.inflateSync(Buffer.concat(parts.filter(x=>x.type==='IDAT').map(x=>Buffer.from(x.data))));
    const pixels=new Uint8Array(1025*2*4);
    for(let y=0;y<2;y++){assert.equal(filtered[y*(1025*4+1)],0);pixels.set(filtered.subarray(y*(1025*4+1)+1,(y+1)*(1025*4+1)),y*1025*4);for(let x=0;x<1025;x++)assert.deepEqual([...pixels.subarray((y*1025+x)*4,(y*1025+x)*4+4)],[x&255,y,0,255]);}
    const captured=await api.encodeCapturedExport({width:1025,height:2,pixels},undefined,scene);
    assert.deepEqual(await readPngScene(captured),scene);
    assert.deepEqual(chunks(new Uint8Array(await captured.arrayBuffer())).filter(x=>x.type==='IDAT').map(x=>x.data),parts.filter(x=>x.type==='IDAT').map(x=>x.data));
  }finally{global.document=previousDocument;}
});
