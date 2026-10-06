const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'src/render/continuation.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const guard=context.exports;
test('million-iteration requests remain sliced after a cheap probe',()=>{
  for(const ms of [0,0.000001,0.1,100,NaN,Infinity])assert.equal(guard.continuationOperations(1_000_000,ms,10),4096);
  assert.equal(guard.continuationOperations(10000,0,10),4096);
  assert.equal(guard.continuationOperations(10000,0.000001,10),0);
  assert.equal(guard.continuationOperations(4096,0,10),0);
});
test('slice allowance bounds total recurrence operations as the lane count changes',()=>{
  for(const lanes of [1,9,576,4096]){
    const operations=guard.resumedContinuationOperations(4096,lanes);
    assert.ok(operations>=1&&operations<=4096);
    assert.ok(operations*lanes<=guard.CONTINUATION_DISPATCH_OPERATIONS*2);
  }
});
test('grid samples own separate state and capacity overflow is rejected',()=>{
  const region=guard.continuationRegion(24,16,1,2_000_000,3);
  assert.equal(region.columns,72);assert.equal(region.rows,48);assert.equal(region.lanes,3456);
  assert.equal(region.bytes,guard.CONTINUATION_HEADER_BYTES+3456*352);
  assert.equal(guard.continuationLaneLimit(region.bytes),3456);
  assert.throws(()=>guard.continuationRegion(32,16,1,2_000_000,3),/capacity/);
  assert.throws(()=>guard.continuationRegion(24,16,1,region.bytes-1,3),/capacity/);
});
