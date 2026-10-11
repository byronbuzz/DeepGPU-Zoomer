const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const ts=require('typescript'),Decimal=require('decimal.js'),root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const compile=code=>ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(code,deps={}){const exports={};new Function('exports','require',compile(code))(exports,name=>deps[name]??require(name));return exports;}
const {ExactGeometryCache}=load(read('src/render/exact-geometry-cache.ts'));
let computations=0;
class CountedCache extends ExactGeometryCache {get(operands,scalars,compute){return super.get(operands,scalars,()=>{computations++;return compute();});}}
const {coordinatePower}=load(read('src/render/coordinate-power.ts'),{'./exact-geometry-cache':{ExactGeometryCache:CountedCache}});
const freshPower=(base,exponent)=>new Decimal(base).pow(exponent);
const original={precision:Decimal.precision,rounding:Decimal.rounding,minE:Decimal.minE,maxE:Decimal.maxE};
test.after(()=>Decimal.set(original));
const source=read('src/render/webgpu-renderer.ts'),tree=ts.createSourceFile('renderer.ts',source,ts.ScriptTarget.Latest,true);
const helperSource=tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&['binaryExponent','splitExponent','splitComplex'].includes(n.name?.text)).map(n=>n.getText(tree)).join('\n');
const {splitQuad}=load(read('src/arithmetic/quad.ts'));
const {rotationBasis}=load(read('src/rotation.ts'));
const numericStart=source.indexOf('    const power = coordinatePower(2, scale.exponent);');
const numericEnd=source.indexOf('    const stopData=this.fillAppearance',numericStart);
assert.ok(numericStart>=0&&numericEnd>numericStart);
const packing=source.slice(numericStart,numericEnd);
function api(power){return new Function('Decimal','coordinatePower','splitQuad','rotationBasis','const exports={};'+compile(helperSource)+`
  return {binaryExponent,pack(request,refX,refY){
    const scale=splitExponent(request.unitsPerPixel),offset=splitComplex(request.centerX.minus(refX),request.centerY.minus(refY));
    const uniforms=new ArrayBuffer(432),f32=new Float32Array(uniforms),u32=new Uint32Array(uniforms),i32=new Int32Array(uniforms);
    f32[2]=scale.mantissa;i32[3]=scale.exponent;f32[4]=offset.x;f32[5]=offset.y;i32[6]=offset.exponent;
    f32[38]=request.centerX.toNumber();f32[39]=request.centerY.toNumber();
    const family=request.family,method=request.direct?0:1,Method={Direct:0};
    (function(){${compile(packing)}}).call({refX,refY});return Buffer.from(uniforms);
  }};`)(Decimal,power,splitQuad,rotationBasis);}
const cached=api(coordinatePower),uncached=api(freshPower);

test('identical powers hit, returned values cannot corrupt cache, and storage stays bounded',()=>{
  Decimal.set({precision:1234});computations=0;
  const expected=freshPower(2,-3329),a=coordinatePower(2,-3329);assert.equal(a.toString(),expected.toString());
  a.d=[0];assert.equal(coordinatePower(2,-3329).toString(),expected.toString());assert.equal(computations,1);
  for(let i=0;i<8;i++)coordinatePower(2,10+i);
  coordinatePower(2,-3329);assert.equal(computations,10,'old entry was evicted after eight distinct replacements');
});

test('precision, rounding and exponent ranges change power identity',()=>{
  Decimal.set(original);
  for(const precision of [17,50,200])for(const rounding of [0,1,4,6,8]){
    Decimal.set({precision,rounding});
    for(const exponent of [-3329,-47,0,47])for(const base of [2,10])assert.equal(coordinatePower(base,exponent).toString(),freshPower(base,exponent).toString());
  }
  Decimal.set({minE:-50,maxE:50});
  for(const exponent of [-200,200])assert.equal(coordinatePower(2,exponent).toString(),freshPower(2,exponent).toString());
  Decimal.set({minE:original.minE,maxE:original.maxE});
  for(const exponent of [-200,200])assert.equal(coordinatePower(2,exponent).toString(),freshPower(2,exponent).toString());
  for(const exponent of [Infinity,-Infinity,NaN,.5])assert.equal(coordinatePower(2,exponent).toString(),freshPower(2,exponent).toString());
});

test('every relevant configuration change misses even when the rounded value is unchanged',()=>{
  Decimal.set({precision:321,rounding:4,minE:-900,maxE:900});
  coordinatePower(2,-191);const start=computations;
  coordinatePower(2,-191);assert.equal(computations,start);
  let misses=0;
  for(const patch of [{precision:322},{rounding:1},{minE:-800},{maxE:800}]){
    Decimal.set(patch);coordinatePower(2,-191);assert.equal(computations,start+(++misses));
    coordinatePower(2,-191);assert.equal(computations,start+misses);
  }
  Decimal.set(original);
});

test('binary exponent keeps exact power-of-two boundary decisions and constructor semantics',()=>{
  for(const precision of [20,200,1250]){
    Decimal.set({precision,rounding:4});const Clone=Decimal.clone({precision:precision+20,rounding:1});
    for(const exponent of [-4000,-3330,-500,-50,0,50]){
      const p=new Clone(2).pow(exponent);
      for(const factor of ['.99999999999999999999','1','1.00000000000000000001']){
        const value=p.times(factor);assert.equal(cached.binaryExponent(value),uncached.binaryExponent(value));
      }
    }
  }
});

test('actual renderer numeric uniforms stay byte-identical across depth, offsets, rotation and Julia',()=>{
  for(const depth of [0,14,140,865,1000,1200]){
    Decimal.set({precision:depth+160,rounding:4});
    const refX=new Decimal('-.7305692969782272338235667933301209793'),refY=new Decimal('.22452405775946937979369207537618');
    for(const factor of ['1','.9876543210123456789','.5'])for(const [dx,dy] of [[0,0],[128,-64],[-512,311]])for(const family of ['mandelbrot','julia']){
      const upp=new Decimal(`1.234567890123456789e-${depth}`).times(factor);
      const request={centerX:refX.plus(upp.times(dx)),centerY:refY.plus(upp.times(dy)),unitsPerPixel:upp,family,direct:depth<=14,juliaX:new Decimal('-.8'),juliaY:new Decimal('.156'),angle:dy?37.2:0};
      assert.deepEqual(cached.pack(request,refX,refY),uncached.pack(request,refX,refY));
    }
  }
});
