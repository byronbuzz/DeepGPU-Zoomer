const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
function loader(){
  const cache=new Map();
  function load(file){file=path.resolve(root,file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);
    const exports={};cache.set(file,exports);
    const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('exports','require',js)(exports,name=>name.endsWith('?raw')?{default:fs.readFileSync(path.resolve(path.dirname(file),name.slice(0,-4)),'utf8')}:name==='./colour-picker'?{}:name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(path.join(root,'node_modules',name)));return exports;
  }return load;
}
const load=loader(),settings=load('src/logic/colorSettings.ts'),{randomizePalette}=load('src/palette-editor.ts');
const {DEFAULT_COLORS,validateColors,hexToRgb,isBlackStop}=settings;
test('remaining presets contain a near-black stop and fit the renderer; removed presets are absent',()=>{
  const {PRESETS,MAX_STOPS}=settings;
  for(const name of ['Plasma','Copper','Cividis','Forest Brass','Glacial Jade'])assert.equal(PRESETS.some(p=>p.name===name),false,name);
  for(const preset of PRESETS){assert.ok(preset.stops.some(isBlackStop),preset.name);assert.ok(preset.stops.length<=MAX_STOPS,preset.name);assert.doesNotThrow(()=>validateColors({...DEFAULT_COLORS,stops:preset.stops,positions:undefined,locks:undefined}),preset.name);}
  const viridis=PRESETS.find(p=>p.name==='Viridis'),copper=PRESETS.find(p=>p.name==='Copper Current');
  assert.deepEqual(viridis.stops,['#440154','#3b528b','#21918c','#5ec962','#fde725','#000000']);
  assert.equal(copper.stops.length,9);assert.equal(copper.stops.filter(isBlackStop).length,1);
  assert.deepEqual(copper.stops.filter(c=>!isBlackStop(c)),['#6ce5ee','#167da4','#4b2637','#c8694b','#ffe5b7','#ba5649','#244a70','#6de5ef']);
});
function withRandom(random,run){const previous=Math.random;Math.random=random;try{return run();}finally{Math.random=previous;}}
function seeded(seed){return ()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);}
function distance(a,b){const x=hexToRgb(a),y=hexToRgb(b);return Math.hypot(...x.map((v,i)=>v-y[i]))/Math.sqrt(3);}
function check(c){assert.ok(c.stops.length>=6&&c.stops.length<=10);for(let i=0;i<c.stops.length;i++){
  const j=(i+1)%c.stops.length,gap=c.positions[j]+(j===0?1:0)-c.positions[i];
  assert.ok(gap>=.05-1e-12,`gap ${gap}`);assert.ok(distance(c.stops[i],c.stops[j])>=.1-1e-12,`${c.stops[i]} / ${c.stops[j]}`);
  assert.ok(c.stops[i]!=='#000000'||c.stops[j]!=='#000000');
}}
test('black classification requires all channels strictly below 17 and valid RGB hex',()=>{
  for(const hex of ['#000000','#101010','#00100f','#0A0F10'])assert.equal(isBlackStop(hex),true,hex);
  for(const hex of ['#111111','#101011','#110000','#0010ff','#ff0000','#FFFF00','#000','000000','#gg0000',''])assert.equal(isBlackStop(hex),false,hex);
});
test('locked near-black counts toward requested black stops and protects both circular neighbours',()=>{
  const initial=validateColors({...DEFAULT_COLORS,stops:['#0A1010','#ff0000','#00ff00','#0000ff','#ffffff','#ffff00'],positions:[0,1/6,2/6,3/6,4/6,5/6],locks:[true,false,false,false,false,false]});
  for(const [chance,expected] of [[0,1],[.6,2],[.9,1]]){
    let first=true;const rng=seeded(4791);
    const next=withRandom(()=>first?(first=false,chance):rng(),()=>randomizePalette(initial,false,false));
    assert.equal(next.stops[0],initial.stops[0]);assert.equal(next.positions[0],0);assert.equal(next.locks[0],true);
    assert.equal(next.stops.filter(isBlackStop).length,expected);
    assert.equal(isBlackStop(next.stops[1]),false);assert.equal(isBlackStop(next.stops.at(-1)),false);
    for(let i=0;i<next.stops.length;i++)assert.ok(!isBlackStop(next.stops[i])||!isBlackStop(next.stops[(i+1)%next.stops.length]));
  }
});
test('near-black RNG output cannot add unintended black stops, including at the seam',()=>{
  for(const [chance,wanted] of [[0,1],[.6,2],[.9,0]]){
    let calls=0;
    const next=withRandom(()=>++calls===1?chance:0x101010/0x1000000,()=>randomizePalette(DEFAULT_COLORS,true,false));
    assert.ok(calls<400);assert.equal(next.stops.filter(isBlackStop).length,wanted);check(next);
    for(let i=0;i<next.stops.length;i++)assert.ok(!isBlackStop(next.stops[i])||!isBlackStop(next.stops[(i+1)%next.stops.length]));
  }
});
test('exclusive black probabilities have exact boundaries, including a cyclic seam',()=>{
  for(const [chance,expected] of [[0,1],[.499999,1],[.5,2],[.749999,2],[.75,0],[.999999,0]]){
    let first=true;const rng=seeded(82);
    const c=withRandom(()=>first?(first=false,chance):rng(),()=>randomizePalette(DEFAULT_COLORS,true,false));
    assert.equal(c.stops.filter(s=>s==='#000000').length,expected);check(c);
  }
});
test('random palettes obey spacing, neighbouring RGB distance and stop bounds across 1000 deterministic scenes',()=>{
  const counts=new Set();withRandom(seeded(987),()=>{for(let i=0;i<1000;i++){const c=randomizePalette(DEFAULT_COLORS,true,i%2===0);check(c);counts.add(c.stops.length);}});
  assert.deepEqual([...counts].sort((a,b)=>a-b),[6,7,8,9,10]);
});
test('constant RNG terminates with meaningful distinct colours and the chosen black count',()=>{
  for(const value of [0,.6,.999999]){const c=withRandom(()=>value,()=>randomizePalette(DEFAULT_COLORS,true,false));check(c);
    assert.equal(c.stops.filter(s=>s==='#000000').length,value<.5?1:value<.75?2:0);}
});
test('locked colours and exact positions survive while free stops respect them',()=>{
  const c=validateColors({...DEFAULT_COLORS,stops:['#112233','#000000','#ffaaee'],positions:[.13,.46,1],locks:[true,true,true]});
  withRandom(seeded(654),()=>{for(let n=0;n<100;n++){const next=randomizePalette(c,true,false);check(next);
    for(let i=0;i<c.stops.length;i++){const at=next.positions.indexOf(c.positions[i]);assert.ok(at>=0);assert.equal(next.stops[at],c.stops[i]);assert.equal(next.locks[at],true);}
  }});
});
test('impossible adjacent black and crowded locks remain unchanged without retries',()=>{
  const c=validateColors({...DEFAULT_COLORS,stops:Array(10).fill('#000000'),positions:[0,.01,.02,.03,.04,.05,.06,.07,.08,1],locks:Array(10).fill(true)});
  let calls=0;const next=withRandom(()=>{assert.ok(++calls<100);return 0;},()=>randomizePalette(c,true,false));
  assert.deepEqual(next.stops,c.stops);assert.deepEqual(next.positions,c.positions);assert.deepEqual(next.locks,c.locks);
});
test('ten-stop scenes validate and PNG metadata retains every colour, position and lock',async()=>{
  const {HOME,validateView}=load('src/state.ts'),{createStreamingPng}=load('src/export/png.ts'),{readPngScene}=load('src/export/png-scene.ts');
  const colors=withRandom(()=>.999999,()=>randomizePalette(DEFAULT_COLORS,true,false));assert.equal(colors.stops.length,10);
  const scene=validateView({...HOME,appearance:colors}),writer=createStreamingPng(1,1,{scene,maxEncodedBytes:100000});await writer.appendRows(new Uint8Array([1,2,3,255]));
  assert.deepEqual(await readPngScene(await writer.finish()),scene);
  assert.throws(()=>validateColors({...colors,stops:[...colors.stops,'#ffffff']}),/2–10/);
});
test('actual renderer appearance packing includes the ninth and tenth stops and matches shader count',()=>{
  const file=path.join(root,'src/render/webgpu-renderer.ts'),source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const renderer=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='WebGpuRenderer'),member=renderer.members.find(n=>n.name?.getText(ast)==='fillAppearance');
  const code=ts.transpileModule(`class Packing {${member.getText(ast)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const Packing=new Function('MAX_STOPS','hexToRgb','stopPositions',`${code};return Packing;`)(settings.MAX_STOPS,hexToRgb,settings.stopPositions);
  const c=validateColors({...DEFAULT_COLORS,stops:Array.from({length:10},(_,i)=>'#'+(i*1539271).toString(16).padStart(6,'0')),positions:Array.from({length:10},(_,i)=>i/10)});
  const uniforms=new ArrayBuffer(448),stops=new Packing().fillAppearance(uniforms,c,false);
  assert.equal(stops.length,40);assert.equal(new Uint32Array(uniforms)[19],10);
  for(let i=0;i<10;i++){const rgb=hexToRgb(c.stops[i]);for(let j=0;j<3;j++)assert.ok(Math.abs(stops[i*4+j]-rgb[j])<1e-7);assert.ok(Math.abs(stops[i*4+3]-c.positions[i])<1e-7);}
});
