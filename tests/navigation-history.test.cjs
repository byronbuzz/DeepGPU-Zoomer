const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
const source=ts.transpileModule(fs.readFileSync(path.join(root,'src/navigation-history.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exportsObject={};new Function('exports',source)(exportsObject);
const {NavigationHistory,sameNavigationLocation}=exportsObject;

function move(history,from,time){history.changed(history.capture(()=>from),time);}

test('settled A to B to C returns B then A without recording Back itself',()=>{
 const history=new NavigationHistory();move(history,'A',0);history.settle(250,false);
 move(history,'B',400);history.settle(650,false);
 assert.equal(history.count,2);assert.equal(history.back(),'B');assert.equal(history.back(),'A');
 assert.equal(history.back(),undefined);assert.equal(history.count,0);
});

test('Back during movement returns the last stationary departure',()=>{
 const history=new NavigationHistory();move(history,'A',0);history.settle(250,false);
 move(history,'B',300);move(history,'transient C',350);
 assert.equal(history.back(),'B');assert.equal(history.capture(()=>'B'),'B');
 assert.equal(history.back(),'A');
});

test('held navigation cannot settle even after a pause longer than 250 ms',()=>{
 const history=new NavigationHistory();move(history,'A',0);history.settle(1000,true);
 let reads=0;history.changed(history.capture(()=>{reads++;return 'transient';}),1100);
 assert.equal(reads,0);assert.equal(history.count,1);
 history.settle(1350,false);move(history,'B',1400);
 assert.equal(history.back(),'B');assert.equal(history.back(),'A');
});

test('wheel bursts settle only after 250 ms without navigation',()=>{
 const history=new NavigationHistory();move(history,'A',0);history.settle(249,false);
 move(history,'transient',249);history.settle(498,false);
 assert.equal(history.capture(()=>{throw Error('still moving');}),null);
 history.settle(499,false);move(history,'B',500);
 assert.equal(history.back(),'B');assert.equal(history.back(),'A');
});

test('a discrete jump during movement excludes the transient view and immediately establishes a new stationary destination',()=>{
 const history=new NavigationHistory();move(history,'A',0);
 history.jumped(history.capture(()=>{throw Error('transient snapshot');}));
 assert.equal(history.count,1);history.jumped(history.capture(()=>'destination B'));
 assert.equal(history.back(),'destination B');assert.equal(history.back(),'A');
});

test('restoration starts a fresh departure while reset empties both history and gesture state',()=>{
 const history=new NavigationHistory();move(history,'A',0);history.restored();move(history,'restored B',1);
 assert.equal(history.back(),'restored B');history.clear();assert.equal(history.count,0);
 assert.equal(history.back(),undefined);assert.equal(history.capture(()=>'new home'),'new home');
});

test('the 1000-entry bound evicts only the oldest departures',()=>{
 const history=new NavigationHistory();for(let i=0;i<1007;i++)history.jumped(history.capture(()=>i));
 assert.equal(history.count,1000);for(let i=1006;i>=7;i--)assert.equal(history.back(),i);
 assert.equal(history.back(),undefined);
});

test('480 continuous camera changes read the deep-coordinate snapshot only once',()=>{
 const history=new NavigationHistory();let reads=0;
 for(let i=0;i<480;i++)history.changed(history.capture(()=>{reads++;return {view:'deep exact coordinates'};}),i*16);
 assert.equal(reads,1);assert.equal(history.count,1);
});

test('cheap checkpoint capture can differ from the materialized entry stored after an actual change',()=>{
 const history=new NavigationHistory();let materializations=0;
 const coordinate={toString(){materializations++;return '-0.730569296978227233823566793330120979';}};
 const rejected=history.capture(()=>({coordinate,revision:4}));
 assert.equal(rejected.coordinate,coordinate);assert.equal(materializations,0);assert.equal(history.count,0);
 const accepted=history.capture(()=>({coordinate,revision:4}));
 history.changed({x:accepted.coordinate.toString()},16);
 assert.equal(materializations,1);assert.equal(history.capture(()=>{throw Error('already active');}),null);
 assert.deepEqual(history.back(),{x:'-0.730569296978227233823566793330120979'});
});

test('location comparison preserves exact coordinate distinctions and ignores only cap changes',()=>{
 const a={family:'mandelbrot',x:'-0.7305692969782272338235667933301209793776361493586857977342353337849959653231046807250623469574',y:'0.224524',span:'6.330598978467655730594116576778240282502624468573754618e-865',jx:'-0.8',jy:'0.156',iterations:503113};
 assert.equal(sameNavigationLocation(a,{...a,iterations:10000000,angle:0}),true);
 for(const change of [{family:'julia'},{x:a.x+'1'},{y:a.y+'1'},{span:a.span.replace('e-865','e-866')},{jx:'-0.7'},{jy:'0.15'},{angle:1}])assert.equal(sameNavigationLocation(a,{...a,...change}),false);
});
