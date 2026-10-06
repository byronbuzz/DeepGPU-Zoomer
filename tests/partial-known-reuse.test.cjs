const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/render/sample-grid.ts'), 'utf8');
const exportsObject = {};
new Function('exports', 'require', ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText)(exportsObject, require);
const {knownRemappedRegion: known} = exportsObject;
const mapping = {offsetX: 0, offsetY: 0, step: 1, denominator: 1};
const sourceView = {width: 13, height: 11};
const completed = {x: 3, y: 2, width: 7, height: 5, spacing: 1};
const region = {x: 4, y: 3, width: 5, height: 3};

test('a completed dense part of an unfinished field certifies contained samples', () => {
  assert.equal(known(region, mapping, sourceView, [completed]), true);
  assert.equal(known(completed, mapping, sourceView, [completed]), true);
  assert.equal(known({x: 3, y: 2, width: 8, height: 5}, mapping, sourceView, [completed]), false);
  assert.equal(known(region, mapping, sourceView, []), false);
});

test('integer translations include the last source sample and reject the next one', () => {
  const translate = {...mapping, offsetX: -2, offsetY: 1};
  const edge = {x: 2, y: 0, width: 13, height: 10};
  const all = {x: 0, y: 0, ...sourceView};
  assert.equal(known(edge, translate, sourceView, [all]), true);
  assert.equal(known({...edge, width: 14}, translate, sourceView, [all]), false);
  assert.equal(known({...edge, x: 1}, translate, sourceView, [all]), false);
  assert.equal(known({...edge, height: 11}, translate, sourceView, [all]), false);
});

test('positive integer decimation checks every remapped endpoint', () => {
  const decimate = {...mapping, offsetX: 3, offsetY: 2, step: 2};
  assert.equal(known({x: 0, y: 0, width: 4, height: 3}, decimate, sourceView, [completed]), true);
  assert.equal(known({x: 0, y: 0, width: 5, height: 3}, decimate, sourceView, [completed]), false);
  assert.equal(known({x: 0, y: 0, width: 3, height: 2}, {...decimate, step: 3}, sourceView, [completed]), true);
});

test('fractional maps remain inadmissible even for one coincident sample', () => {
  assert.equal(known({x: 6, y: 4, width: 1, height: 1},
    {...mapping, denominator: 2}, sourceView, [completed]), false);
  for (const step of [0, -1, .5, Infinity, NaN]) {
    assert.equal(known(region, {...mapping, step}, sourceView, [completed]), false);
  }
});

test('adjacent pieces, L shapes and gaps never substitute for one certificate', () => {
  const r = {x: 0, y: 0, width: 4, height: 4};
  for (const parts of [
    [{x: 0, y: 0, width: 2, height: 4}, {x: 2, y: 0, width: 2, height: 4}],
    [{x: 0, y: 0, width: 4, height: 2}, {x: 0, y: 2, width: 2, height: 2}],
    [{x: 0, y: 0, width: 1, height: 4}, {x: 2, y: 0, width: 2, height: 4}],
  ]) assert.equal(known(r, mapping, sourceView, parts), false);
});

test('only exact stride-1 rectangles certify numerical samples', () => {
  const implicit = {...completed}; delete implicit.spacing;
  assert.equal(known(region, mapping, sourceView, [implicit]), true,
    'CoverageRegions treats omitted spacing as one');
  for (const spacing of [0, .5, 2, 16, NaN, Infinity]) {
    assert.equal(known(region, mapping, sourceView, [{...completed, spacing}]), false);
  }
});

test('nonfinite or fractional geometry cannot certify reuse', () => {
  for (const value of [NaN, Infinity, -Infinity, .5]) {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.equal(known({...region, [key]: value}, mapping, sourceView, [completed]), false);
      assert.equal(known(region, mapping, sourceView, [{...completed, [key]: value}]), false);
    }
    for (const key of ['offsetX', 'offsetY']) {
      assert.equal(known(region, {...mapping, [key]: value}, sourceView, [completed]), false);
    }
    for (const key of ['width', 'height']) {
      assert.equal(known(region, mapping, {...sourceView, [key]: value}, [completed]), false);
    }
  }
});

test('empty, negative and invalid source certificates fail closed', () => {
  for (const patch of [{width: 0}, {height: 0}, {x: -1}, {y: -1}, {width: -1}, {height: -1}]) {
    assert.equal(known({...region, ...patch}, mapping, sourceView, [completed]), false);
    assert.equal(known(region, mapping, sourceView, [{...completed, ...patch}]), false);
  }
  assert.equal(known(region, mapping, {width: 0, height: 11}, [completed]), false);
  assert.equal(known(region, mapping, sourceView, [{x: 0, y: 0, width: 14, height: 11}]), false);
});

test('unsafe sums, products and offsets never create rounded certificates', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(known({...region, x: max, width: 2}, mapping, sourceView, [completed]), false);
  assert.equal(known(region, {...mapping, step: max}, sourceView, [completed]), false);
  assert.equal(known(region, {...mapping, offsetX: max + 1}, sourceView, [completed]), false);
  assert.equal(known(region, mapping, sourceView, [{...completed, width: max}]), false);
});

test('bounded independent per-sample oracle agrees for partial fields and odd shapes', () => {
  const size = {width: 9, height: 7};
  const certificates = [{x: 1, y: 2, width: 5, height: 3, spacing: 1},
    {x: 0, y: 0, width: 9, height: 7, spacing: 1}];
  let cases = 0;
  for (const rect of certificates) {
    const observed = new Set();
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) observed.add(`${x},${y}`);
    }
    for (const offsetX of [-2, 0, 2]) for (const offsetY of [-2, 0, 2]) {
      for (const step of [1, 2, 3]) for (const x of [0, 1, 3]) for (const y of [0, 1]) {
        for (const width of [1, 2, 3]) for (const height of [1, 2]) {
          const r = {x, y, width, height}, m = {offsetX, offsetY, step, denominator: 1};
          let expected = true;
          for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
            const oldX = offsetX + (x + dx) * step, oldY = offsetY + (y + dy) * step;
            expected &&= observed.has(`${oldX},${oldY}`);
          }
          assert.equal(known(r, m, size, [rect]), expected,
            JSON.stringify({r, m, rect}));
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 1944);
});

// Exercise the actual owner and its awaited adoption boundary with inert GPU
// objects. Geometry and coverage logic still come from the production modules.
const rendererFile = path.join(__dirname, '../src/render/webgpu-renderer.ts');
const rendererSource = ts.createSourceFile(rendererFile,
  fs.readFileSync(rendererFile, 'utf8'), ts.ScriptTarget.Latest, true);
const rendererClass = rendererSource.statements.find(node =>
  ts.isClassDeclaration(node) && node.name?.text === 'WebGpuRenderer');
const moveFieldMethod = rendererClass.members.find(node =>
  ts.isMethodDeclaration(node) && node.name?.text === 'moveField');
const renderTargetMethod = rendererClass.members.find(node =>
  ts.isMethodDeclaration(node) && node.name?.text === 'renderTarget');
const adoption = renderTargetMethod.body.statements.find(node =>
  ts.isIfStatement(node) && node.expression.getText(rendererSource) === 'fieldStale && !inPlaceCapUpgrade');
assert.ok(adoption, 'test must execute the production field adoption and cap upgrade branches');
const regionExports = {};
new Function('exports', ts.transpileModule(fs.readFileSync(
  path.join(__dirname, '../src/render/regions.ts'), 'utf8'), {
  compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022},
}).outputText)(regionExports);
const probeExports = {};
new Function('exports', 'sampleGridRemap', 'CoverageRegions', 'storageBuffer',
  'GPUBufferUsage', 'checkedGpu', 'DOMException', ts.transpileModule(`
class FieldProbe {
  ${moveFieldMethod.getText(rendererSource)}
  async adopt(request, sampleKey, inPlaceCapUpgrade=false) {
    const device=this.ctx.device, fieldStale=true, grid=1, colors={mode:0}, ordinary=true;
    const capMapping=inPlaceCapUpgrade?{offsetX:0,offsetY:0,step:1,denominator:1}:null;
    const lowerCap=0, admitted={view:request,maxIterations:request.maxIterations};
    const u32=new Uint32Array(56), uniforms=u32.buffer;
    ${adoption.getText(rendererSource)}
  }
}
exports.FieldProbe=FieldProbe;`, {
  compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022},
}).outputText)(probeExports, exportsObject.sampleGridRemap, regionExports.CoverageRegions,
  () => ({destroy() {}}), {COPY_SRC:1}, async (device, callback) => {
    callback();
    await Promise.resolve();
    device.afterSubmission?.();
  }, DOMException);
const Decimal = require('decimal.js');
function fieldProbe() {
  const p = new probeExports.FieldProbe();
  const pass = {setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {}};
  const device = {queue:{writeBuffer() {}, submit() {}}, createBindGroup() { return {}; },
    createCommandEncoder() { return {beginComputePass() { return pass; }, finish() { return {}; }}; }};
  const view = {centerX:new Decimal(0), centerY:new Decimal(0), unitsPerPixel:new Decimal(1),
    width:8, height:8, maxIterations:1000, isCurrent:() => true};
  Object.assign(p, {ctx:{device}, fieldBuffer:{destroy() {}}, fieldCapacity:64,
    spareField:null, spareCapacity:0, fieldView:view, sampleKey:'old-cap', fieldComplete:false,
    reuseUniform:{}, reusePipeline:{getBindGroupLayout() { return {}; }}, orbitBuffer:{},
    retainEndpoints:false, abortRequested:false, determined:new regionExports.CoverageRegions(),
    determinedRegion:null, reusableKnownRectangles:[]});
  return p;
}

test('cancellation after actual field adoption cannot relabel old-coordinate certificates', async () => {
  const p = fieldProbe(), oldCertificate = {x:4, y:0, width:4, height:4, spacing:1};
  p.determined.add(oldCertificate); p.determinedRegion = {...oldCertificate};
  const next = {...p.fieldView, centerX:new Decimal(4)};
  p.ctx.device.afterSubmission = () => { p.abortRequested = true; };
  await assert.rejects(p.adopt(next, 'old-cap'), error => error.name === 'AbortError');
  assert.equal(p.reuseMapping.offsetX, 4);
  assert.deepEqual(p.reusableKnownRectangles, [oldCertificate], 'prior copy retains its correct source certificate');
  assert.equal(p.determined.rectangles.length, 0);
  assert.equal(p.determinedRegion, null);
  assert.equal(p.fieldView.centerX.eq(4), true, 'buffer geometry moved before cancellation');
  const unknown = {x:4, y:0, width:4, height:4};
  assert.equal(known(unknown, mapping, next, [oldCertificate]), true,
    'stale coordinates would incorrectly certify positions copied from outside the old field');
  p.abortRequested = false; p.ctx.device.afterSubmission = null;
  await p.adopt(next, 'old-cap');
  assert.equal(p.reusableKnownRectangles.length, 0);
  assert.equal(known(unknown, p.reuseMapping, p.reusableView, p.reusableKnownRectangles), false);
});

test('actual in-place cap upgrade drops old-cap certificates before a same-cap remap', async () => {
  const p = fieldProbe(), oldCertificate = {x:0, y:0, width:8, height:8, spacing:1};
  p.determined.add(oldCertificate); p.determinedRegion = {...oldCertificate};
  p.reusableKnownRectangles = [oldCertificate];
  const field = p.fieldBuffer, upgrade = {...p.fieldView, maxIterations:2000};
  await p.adopt(upgrade, 'new-cap', true);
  assert.equal(p.fieldBuffer, field, 'cap upgrade retains the existing scalar buffer');
  assert.equal(p.sampleKey, 'new-cap');
  assert.equal(p.reuseMapping, null);
  assert.equal(p.reusableKnownRectangles.length, 0);
  assert.equal(p.determined.rectangles.length, 0);
  assert.equal(p.determinedRegion, null);
  await p.adopt(upgrade, 'new-cap');
  assert.equal(p.reusableKnownRectangles.length, 0);
  assert.equal(known({x:0, y:0, width:8, height:8}, p.reuseMapping,
    p.reusableView, p.reusableKnownRectangles), false,
  'older cap stamps require shader decisions until the upgraded field actually finishes work');
});
