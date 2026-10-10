const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const ts=require('typescript'),Decimal=require('decimal.js');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(root+'/'+p,'utf8');
const compile=code=>ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(code,deps={}) {const exports={};new Function('exports','require',compile(code))(exports,n=>deps[n]??require(n));return exports;}
const {ExactGeometryCache}=load(read('src/render/exact-geometry-cache.ts'));
const rotation=load(read('src/rotation.ts'));
let computations=0;
class CountedCache extends ExactGeometryCache {
  get(operands,scalars,compute){return super.get(operands,scalars,()=>{computations++;return compute();});}
}
const deps={'../rotation':rotation,'./exact-geometry-cache':{ExactGeometryCache:CountedCache}};
const projection=load(read('src/render/reprojection.ts'),deps);
// Use the production uncached arithmetic as the oracle, without a second
// implementation of the geometry. Display division remains a separate path.
const uncached=load(read('src/render/reprojection.ts'),{'../rotation':rotation,'./exact-geometry-cache':{ExactGeometryCache:class {get(_o,_s,compute){return compute();}}}});
const sf=ts.createSourceFile('renderer.ts',read('src/render/webgpu-renderer.ts'),ts.ScriptTarget.Latest,true);
const radiusSource=sf.statements.filter(n=>ts.isFunctionDeclaration(n)&&['renderDomain','referenceViewportRadius'].includes(n.name?.text)||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf)==='viewportRadii')).map(n=>n.getText(sf)).join('\n');
function radiusApi(Cache){const exports={};new Function('exports','Decimal','rotationBasis','ExactGeometryCache',compile(radiusSource))(exports,Decimal,rotation.rotationBasis,Cache);return exports.referenceViewportRadius;}
const radius=radiusApi(CountedCache),uncachedRadius=radiusApi(class {get(_o,_s,compute){return compute();}});
const original={precision:Decimal.precision,rounding:Decimal.rounding,minE:Decimal.minE,maxE:Decimal.maxE};
test.after(()=>Decimal.set(original));
function frame(depth=1000,Ctor=Decimal){return {centerX:new Ctor('-.73'),centerY:new Ctor('.22'),unitsPerPixel:new Ctor(`1.23456789123456789e-${depth}`),width:1760,height:990,angle:0};}
function check(a,b,coarse=false,held=false){const expected=uncached.reprojectionFor(a,b,coarse,held);assert.deepEqual(projection.reprojectionFor(a,b,coarse,held),expected);assert.deepEqual(projection.reprojectionFor({...a},{...b},coarse,held),expected);}

test('bounded LRU caches null; changed operands and scalar snapshots miss',()=>{
  const cache=new ExactGeometryCache(2),x=new Decimal(1),y=new Decimal(2);let calls=0;
  const get=(o,s)=>cache.get(o,s,()=>{calls++;return null;});
  get([x],[1]);get([x],[1]);assert.equal(calls,1);
  get([y],[1]);get([x],[1]);get([x],[2]);get([y],[1]);assert.equal(calls,4,'recent entry is retained; oldest is evicted');
  get([new Decimal(2)],[1]);assert.equal(calls,5,'equal values with different identities recompute');
  get([y],[-0]);get([y],[0]);assert.equal(calls,7,'scalar snapshots preserve signed zero');
});

test('global and independently cloned constructor configuration changes invalidate',()=>{
  const Clone=Decimal.clone({precision:70}),x=new Clone(1),cache=new ExactGeometryCache(1);let calls=0;
  const get=()=>cache.get([x],[],()=>++calls);
  assert.equal(get(),1);assert.equal(get(),1);
  for(const Ctor of [Decimal,Clone])for(const [name,value] of [['precision',Ctor.precision+1],['rounding',1],['minE',-900],['maxE',900]]){
    const before=Ctor[name];Ctor.set({[name]:value});get();assert.equal(calls,2);get();assert.equal(calls,2);
    Ctor.set({[name]:before});get();assert.equal(calls,3);calls=1;
  }
});

test('numerical reprojection hits preserve fresh result isolation and flag/mutation invalidation',()=>{
  Decimal.set({precision:1224});const a=frame(),b={...a,unitsPerPixel:a.unitsPerPixel.times('.75')};
  computations=0;const first=projection.reprojectionFor(a,b),expected={...first};
  first.offsetX=900;assert.deepEqual(projection.reprojectionFor({...a},{...b}),expected);assert.equal(computations,1);
  for(const patch of [{width:1700},{height:900},{angle:10},{centerX:a.centerX.plus(a.unitsPerPixel)},{centerY:a.centerY.minus(a.unitsPerPixel)},{unitsPerPixel:a.unitsPerPixel.times('.5')}]){
    Object.assign(b,patch);check(a,b);
  }
  check(a,b,true);check(a,b,true,true);
});

test('full precision mappings agree through deep cancellation, clone precision and reuse boundaries',()=>{
  for(const depth of [0,14,140,865,1000,1200]){
    Decimal.set({precision:depth+160});const Clone=Decimal.clone({precision:depth+90}),a=frame(depth,Clone);
    for(const [oldAngle,newAngle] of [[0,0],[30,30],[30,65],[359,1]])for(const scale of ['.015624999999999999','.015625','1','8','8.000000000000001']){
      const b={...a,angle:newAngle,unitsPerPixel:a.unitsPerPixel.times(scale),centerX:a.centerX.plus(a.unitsPerPixel.times(123)),centerY:a.centerY.minus(a.unitsPerPixel.times(77))};
      for(const [coarse,held] of [[false,false],[true,false],[true,true]])check({...a,angle:oldAngle},b,coarse,held);
    }
    for(const dx of ['3.999999999999999','4','4.000000000000001'])check(a,{...a,centerX:a.centerX.plus(a.unitsPerPixel.times(a.width).times(dx))});
    for(const patch of [{width:0},{height:-1},{unitsPerPixel:new Clone(0)},{unitsPerPixel:new Clone(NaN)},{unitsPerPixel:new Clone(Infinity)}])check(a,{...a,...patch});
  }
});

test('radius exactly matches uncached geometry across rotation, export and mutated view fields',()=>{
  for(const depth of [14,140,865,1000,1200]){
    Decimal.set({precision:depth+160});const a=frame(depth),rx=a.centerX.plus(a.unitsPerPixel.times(11)),ry=a.centerY.minus(a.unitsPerPixel.times(17));
    for(const angle of [0,30,90,359])for(const exportDomain of [undefined,{width:4000,height:2000,x:123,y:77}]){
      Object.assign(a,{angle,exportDomain});computations=0;const expected=uncachedRadius(a,rx,ry).toString();
      const first=radius(a,rx,ry),second=radius({...a},rx,ry);
      assert.equal(first.toString(),expected);assert.equal(second.toString(),expected);assert.notEqual(first,second);assert.equal(computations,1);
      // The caller can replace a returned Decimal's public fields without
      // corrupting the privately retained result (fields are library read-only).
      first.d=[0];assert.equal(radius(a,rx,ry).toString(),expected);
      a.width++;if(a.exportDomain)a.exportDomain.width++;
      assert.equal(radius(a,rx,ry).toString(),uncachedRadius(a,rx,ry).toString());
    }
  }
});

test('actual geometry follows new precision/rounding on identical operands',()=>{
  const Clone=Decimal.clone({precision:1100}),a=frame(1000,Clone),b={...a,unitsPerPixel:a.unitsPerPixel.times('.876543210987654321')};
  for(const precision of [1050,1224,1300])for(const rounding of [Decimal.ROUND_DOWN,Decimal.ROUND_UP,Decimal.ROUND_HALF_EVEN]){
    Decimal.set({precision,rounding});Clone.set({precision:precision-10,rounding});check(a,b);
    assert.equal(radius(a,b.centerX,b.centerY).toString(),uncachedRadius(a,b.centerX,b.centerY).toString());
  }
});
