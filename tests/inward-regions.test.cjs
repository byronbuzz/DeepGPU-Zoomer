const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/render/regions.ts'),'utf8');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,
  {exports:exportsObject,Map,Set,Math,Number});
const {PendingRegions}=exportsObject;
const tuning={pointer:0,distributed:0,oldest:1,pointerRadius:64};
const demand={x:56,y:56,zoom:1,heldInwardZoom:true,visible:{x:48,y:48,width:16,height:16},covered:[]};

test('held inward oldest work follows visible children and preserves every exact obligation on release',()=>{
  const queue=new PendingRegions();queue.reset(64,64);
  const visited=new Uint8Array(64*64);
  for(let n=0;n<4;n++){
    const r=queue.take(64,demand,undefined,tuning);
    assert.ok(r.x>=48&&r.y>=48,'oldest splitting must follow the visible corner');
    for(let y=r.y;y<r.y+r.height;y++)for(let x=r.x;x<r.x+r.width;x++)visited[y*64+x]++;
  }
  let r;
  const released={...demand,zoom:0,heldInwardZoom:false};
  while((r=queue.take(64,released,undefined,tuning)))
    for(let y=r.y;y<r.y+r.height;y++)for(let x=r.x;x<r.x+r.width;x++)visited[y*64+x]++;
  assert.ok(visited.every(n=>n===1),'release must complete the disjoint exact partition once');
});

test('wheel, outward, row mode and invalid visible bounds retain incumbent oldest order',()=>{
  for(const [changes,rows] of [[{heldInwardZoom:false},undefined],[{zoom:-1},undefined],
    [{},8],[{visible:{x:48,y:48,width:NaN,height:16}},undefined]]){
    const queue=new PendingRegions();queue.reset(64,64);
    const r=queue.take(64,{...demand,...changes},rows,tuning);
    assert.equal(r.x,0);assert.equal(r.y,0);
  }
});

test('held inward oldest falls back when the visible footprint has no pending intersection',()=>{
  const queue=new PendingRegions();queue.reset(64,64);
  const r=queue.take(64,{...demand,visible:{x:80,y:80,width:16,height:16}},undefined,tuning);
  assert.equal(r.x,0);assert.equal(r.y,0);
});
