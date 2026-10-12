const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
function loadModules(){const cache=new Map();function load(file){file=path.resolve(root,file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('exports','require',code)(exports,name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(path.join(root,'node_modules',name)));return exports;}return load;}
const load=loadModules(),api=load('src/clipboard-link.ts'),state=load('src/state.ts');
const scene=state.validateView({...state.HOME,x:'-0.7300000000000000000000000000000000000000000123',y:'0.22',span:'1e-900',iterations:503113,angle:37,rotatePalette:true,rotateLight:false,rotationSeconds:17,reverseRotation:true});
const text='https://example.test/explorer/#'+state.encodeView(scene);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('clipboard accepts exact deep links, hash fragments and versioned scene text without navigating their hosts',()=>{
 for(const value of [text,'#'+state.encodeView(scene),state.encodeView(scene),JSON.stringify(scene),JSON.stringify({format:'DeepGPU-Zoomer',version:1,view:scene})])assert.deepEqual(api.readClipboardScene('  '+value+'\n'),scene);
 for(const value of ['', 'hello', 'https://example.test/no-scene', 'javascript:alert(1)', '#%7Bbroken', JSON.stringify({format:'DeepGPU-Zoomer',version:2,view:scene}), JSON.stringify({...scene,iterations:0}), 'x'.repeat(256*1024+1)])assert.equal(api.readClipboardScene(value),null);
});

async function fixture(run){
 const handlers={},docHandlers={},loaded=[],messages=[],reads=[];let revision='initial',focused=true,permission='prompt',clipboard=text,reader;
 const button={disabled:false,title:'',onclick:null};
 const document={hidden:false,hasFocus:()=>focused,addEventListener:(name,fn)=>docHandlers[name]=fn};
 const navigator={permissions:{query:async()=>({state:permission})},clipboard:{readText:()=>{reads.push(true);return reader?reader():Promise.resolve(clipboard);},addEventListener:(name,fn)=>handlers['clipboard:'+name]=fn}};
 const window={addEventListener:(name,fn)=>handlers[name]=fn};
 const globals={document,navigator,window},previous=Object.fromEntries(Object.keys(globals).map(name=>[name,Object.getOwnPropertyDescriptor(global,name)]));
 for(const [name,value]of Object.entries(globals))Object.defineProperty(global,name,{value,configurable:true,writable:true});
 try{const control=api.setupClipboardLink({button,load:view=>loaded.push(view),revision:()=>revision,message:msg=>messages.push(msg)});await settle();await run({button,handlers,docHandlers,loaded,messages,reads,control,setRevision:value=>revision=value,setPermission:value=>permission=value,setText:value=>clipboard=value,setReader:value=>reader=value,setFocus:value=>focused=value});}
 finally{for(const name of Object.keys(globals)){if(previous[name])Object.defineProperty(global,name,previous[name]);else delete global[name];}}
}

test('unknown clipboard remains clickable without prompting; known invalid clipboard disables until focus refresh',async()=>{
 await fixture(async f=>{
  assert.equal(f.reads.length,0);assert.equal(f.button.disabled,false);
  f.setText('plain text');f.button.onclick();await settle();assert.equal(f.button.disabled,true);assert.equal(f.loaded.length,0);
  f.setPermission('granted');f.setText(text);f.handlers.focus();await settle();assert.equal(f.button.disabled,false);assert.equal(f.loaded.length,0);
  f.button.onclick();await settle();assert.deepEqual(f.loaded,[scene]);
  f.setText('invalid');f.handlers['clipboard:clipboardchange']();await settle();assert.equal(f.button.disabled,true);
  f.control.copied();assert.equal(f.button.disabled,false);
 });
});

test('pending clipboard read cannot replace a newer navigation or win over a newer paste',async()=>{
 await fixture(async f=>{
  let wait=deferred();f.setReader(()=>wait.promise);f.button.onclick();f.setRevision('new camera');wait.resolve(text);await settle();assert.equal(f.loaded.length,0);assert.match(f.messages.at(-1),/view changed/);
  wait=deferred();f.setReader(()=>wait.promise);f.button.onclick();const fresh=state.validateView({...scene,iterations:17});let prevented=false;
  f.handlers.paste({target:{closest:()=>null},clipboardData:{getData:()=>JSON.stringify(fresh)},preventDefault:()=>prevented=true});wait.resolve(text);await settle();assert.equal(prevented,true);assert.deepEqual(f.loaded,[fresh]);
 });
});

test('permission denial preserves the view and Ctrl+V loads valid scenes without intercepting text fields',async()=>{
 await fixture(async f=>{
  f.setReader(()=>Promise.reject(Error('denied')));f.button.onclick();await settle();assert.equal(f.button.disabled,false);assert.equal(f.loaded.length,0);assert.match(f.messages.at(-1),/Ctrl\+V/);
  let prevented=0;const paste=target=>f.handlers.paste({target,clipboardData:{getData:()=>text},preventDefault:()=>prevented++});
  paste({closest:()=>({tagName:'INPUT'})});assert.equal(f.loaded.length,0);assert.equal(prevented,0);
  paste({closest:()=>null});assert.deepEqual(f.loaded,[scene]);assert.equal(prevented,1);
 });
});
