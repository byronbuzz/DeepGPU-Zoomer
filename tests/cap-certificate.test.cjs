const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
const api={};new Function('exports',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/render/cap-certificate.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(api);
const {capRegionResolved:known}=api;
test('one unresolved tile cannot invalidate separately certified pixels or certify itself',()=>{
  const c={width:17,height:9,unresolved:new Uint32Array([0,1,0,0,0,0])};
  assert.equal(known(c,{x:0,y:0,width:8,height:8}),true);
  assert.equal(known(c,{x:16,y:0,width:1,height:9}),true);
  assert.equal(known(c,{x:0,y:8,width:17,height:1}),true);
  assert.equal(known(c,{x:8,y:0,width:1,height:1}),false);
  assert.equal(known(c,{x:7,y:0,width:2,height:1}),false);
  assert.equal(known(c,{x:0,y:0,width:17,height:9}),false);
});
test('all tile intersections agree with an independent pixel oracle',()=>{
  const c={width:25,height:17,unresolved:new Uint32Array(12)};
  c.unresolved[5]=1;c.unresolved[11]=1;
  for(let y=0;y<17;y++)for(let x=0;x<25;x++)for(const width of [1,7,8,9])for(const height of [1,7,8,9]){
    let expected=x+width<=25&&y+height<=17;
    for(let dy=0;expected&&dy<height;dy++)for(let dx=0;expected&&dx<width;dx++)
      expected=c.unresolved[Math.floor((y+dy)/8)*4+Math.floor((x+dx)/8)]===0;
    assert.equal(known(c,{x,y,width,height}),expected,JSON.stringify({x,y,width,height}));
  }
});
test('invalid rectangles and incomplete or malformed certificates fail closed',()=>{
  const c={width:8,height:8,unresolved:new Uint32Array(1)};
  for(const r of [{x:-1,y:0,width:1,height:1},{x:0,y:0,width:0,height:1},{x:0,y:0,width:9,height:1},
    {x:0,y:0,width:1,height:9},{x:.5,y:0,width:1,height:1},{x:0,y:NaN,width:1,height:1}])assert.equal(known(c,r),false);
  assert.equal(known({...c,unresolved:new Uint32Array(0)},{x:0,y:0,width:1,height:1}),false);
  assert.equal(known({...c,unresolved:new Uint32Array([2])},{x:0,y:0,width:1,height:1}),false);
});
