const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript');
const Decimal=require('decimal.js');
const transpile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(file,deps={}) {
  const result={};new Function('exports','require',transpile(fs.readFileSync(path.join(__dirname,'..',file),'utf8')))
    (result,name=>deps[name]||require(name));return result;
}
const rotation=load('src/rotation.ts');
const geometry=load('src/render/exact-geometry-cache.ts');
const {displayRatio,displayReprojectionFor:display,reprojectionFor:strict,mapUv}=load('src/render/reprojection.ts',{'../rotation':rotation,'./exact-geometry-cache':geometry});
Decimal.set({precision:1224});
const frame=(patch={})=>({centerX:new Decimal('-0.73'),centerY:new Decimal('0.22'),unitsPerPixel:new Decimal('6.3945444226946017480748652290689295782854792611856107253406561911e-868'),width:1760,height:990,angle:0,...patch});
function compare(last,next,coarse=false,held=false) {
  const expected=strict(last,next,coarse,held),actual=display(last,next,coarse,held);
  assert.equal(actual===null,expected===null);
  if(expected) {
    for(const key of Object.keys(expected))assert.equal(Math.fround(actual[key]),Math.fround(expected[key]),key);
    for(const [x,y] of [[0,0],[1,1],[.5,.5],[.123,.987]]) {
      const a=mapUv(actual,x,y),e=mapUv(expected,x,y);
      assert.ok(Math.abs(a.x-e.x)<=Math.max(1,Math.abs(e.x))*2e-15);
      assert.ok(Math.abs(a.y-e.y)<=Math.max(1,Math.abs(e.y))*2e-15);
    }
  }
}

test('display quotients retain deep exponents and do not change global precision or inputs',()=>{
  const a=new Decimal('1.0290462849421257354226231292663745666951581916761327961068489407e-865');
  const b=new Decimal('2.5060668403467085317092094620505798369542546664284848131810781e-865');
  const before=[a.toString(),b.toString(),Decimal.precision];
  assert.equal(a.toNumber(),0);assert.equal(b.toNumber(),0);
  assert.equal(displayRatio(a,b),a.div(b).toNumber());
  assert.deepEqual([a.toString(),b.toString(),Decimal.precision],before);
  Decimal.set({precision:2500});
  assert.equal(displayRatio(a,b),a.div(b).toNumber());
  assert.equal(Decimal.precision,2500);Decimal.set({precision:1224});
});

test('deep centre cancellation, resolution changes and rotation retain display mappings',()=>{
  for(const exponent of [0,-14,-140,-865,-1200]) {
    Decimal.set({precision:Math.max(1224,-exponent+160)});
    const last=frame({unitsPerPixel:new Decimal('1.23456789012345678901234567890123456789').times(new Decimal(10).pow(exponent))});
    for(const [oldAngle,newAngle] of [[0,0],[30,30],[30,65],[90,0],[359,1]]) {
      const next={...last,width:1280,height:720,angle:newAngle,
        centerX:last.centerX.plus(last.unitsPerPixel.times('11.123456789012345678901')),
        centerY:last.centerY.minus(last.unitsPerPixel.times('17.09876543210987654321')),
        unitsPerPixel:last.unitsPerPixel.times('.410622777897396430834547898')};
      compare({...last,angle:oldAngle},next);
    }
  }
  Decimal.set({precision:1224});
});

test('display and strict cutoff decisions agree beside scale and pan boundaries',()=>{
  const last=frame(),epsilon=new Decimal('1e-40');
  for(const boundary of [new Decimal(1).div(64),new Decimal(8)])
    for(const offset of [epsilon.neg(),new Decimal(0),epsilon,new Decimal('1e-15').neg(),new Decimal('1e-15')])
      for(const [coarse,held] of [[false,false],[true,false],[true,true]])
        compare(last,{...last,unitsPerPixel:last.unitsPerPixel.times(boundary.plus(offset))},coarse,held);
  // Halfway between 8 and its next binary64 value: 24-digit rounding alone
  // can round to the accepted side. The rare strict fallback preserves it.
  const midpoint=new Decimal(8).plus(new Decimal(2).pow(-50));
  for(const delta of [epsilon.neg(),new Decimal(0),epsilon])
    compare(last,{...last,unitsPerPixel:last.unitsPerPixel.times(midpoint.plus(delta))});
  for(const sign of [-1,1])for(const delta of [epsilon.neg(),new Decimal(0),epsilon,new Decimal('1e-14')])
    compare(last,{...last,centerX:last.centerX.plus(last.unitsPerPixel.times(last.width).times(new Decimal(4).plus(delta).times(sign)))});
});

test('invalid, absent and extreme mappings keep rejection and held-image policy',()=>{
  const last=frame();
  for(const patch of [{width:0},{height:-1},{unitsPerPixel:new Decimal(0)},{unitsPerPixel:new Decimal(-1)},
    {unitsPerPixel:new Decimal(Infinity)},{unitsPerPixel:new Decimal(NaN)},
    {unitsPerPixel:last.unitsPerPixel.times('1e-1000')},{unitsPerPixel:last.unitsPerPixel.times('1e1000')}])
    for(const [coarse,held] of [[false,false],[true,false],[true,true]])compare(last,{...last,...patch},coarse,held);
  compare(last,{...last,unitsPerPixel:last.unitsPerPixel.times(256)},true,true);
  compare(last,{...last,centerX:last.centerX.plus(last.unitsPerPixel.times(last.width).times(100))},true,true);
});

// Execute the production presentation owner with inert GPU submission. This
// checks frame/mapping ownership across publications rather than a text pattern.
const renderer=fs.readFileSync(path.join(__dirname,'../src/render/webgpu-renderer.ts'),'utf8');
const ast=ts.createSourceFile('renderer.ts',renderer,ts.ScriptTarget.Latest,true);
const owner=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='WebGpuRenderer');
const reproject=owner.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.text==='reproject').getText(ast);
const api={};let calls=[];
new Function('exports','displayReprojectionFor',transpile(`class Probe{${reproject}} exports.Probe=Probe;`))
  (api,(...args)=>{calls.push(args);return display(...args);});
function probe(incoming) {
  const p=new api.Probe();Object.assign(p,{incomingFrame:incoming,target:{},blitPipeline:{},
    partialSerial:1,publicationEpoch:0,appearanceSubmissions:0,canvas:{width:1760,height:990},
    ctx:{device:{createCommandEncoder(){return {finish(){return {};}};},queue:{submit(){}}}},
    validateCoordinates(){},capUpgradeBase(){return false;},appearanceHoldActive(){return false;},
    presentationCompatible(f){return !!f;},samePresentation(){return true;},
    encodeBlit(...args){this.blit=args;}});return p;
}
test('one presentation owns the reused incoming mapping; subsequent frames recalculate',()=>{
  const incoming={...frame(),maxIterations:503113,family:'mandelbrot',colors:{mode:0}};
  const p=probe(incoming),request={...incoming,unitsPerPixel:incoming.unitsPerPixel.times('.75'),interacting:true,zoom:1};
  calls=[];assert.equal(p.reproject(request),true);assert.equal(calls.length,1);
  assert.equal(p.blit[2],p.blit[6]);
  const first=p.blit[6];p.partialSerial++;
  assert.equal(p.reproject({...request,unitsPerPixel:incoming.unitsPerPixel.times('.5')}),true);
  assert.notEqual(p.blit[6],first);assert.equal(p.blit[6].scaleX,.5);
});
test('null strict incoming maps still allow finite held presentation',()=>{
  const incoming={...frame(),maxIterations:503113,family:'mandelbrot',colors:{mode:0}};
  const p=probe(incoming),request={...incoming,unitsPerPixel:incoming.unitsPerPixel.times(16)};
  assert.equal(p.reproject(request),true);assert.equal(p.blit[6],null);
  assert.equal(p.blit[2].scaleX,16);
});
