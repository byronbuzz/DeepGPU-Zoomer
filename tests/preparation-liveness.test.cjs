// Run the production preparation decisions and numerical-grid planner in Node.
// GPU submission is intentionally absent: these regressions establish reference
// admission and retry liveness, not GPU timing or display publication.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const Decimal = require(path.join(root, 'node_modules/decimal.js'));
Decimal.set({ precision: 100 });

// Load actual pure TypeScript dependencies, preserving their relative imports.
const modules = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (!path.extname(file)) file += '.ts';
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, {
    exports: module.exports, module, Decimal, console,
    require: name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(path.join(root, 'node_modules', name)),
  }, { filename: file });
  return module.exports;
}
const file = path.join(root, 'src/render/webgpu-renderer.ts');
const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const renderer = sf.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'WebGpuRenderer');
const methodNames = [
  'referenceBudget', 'referenceDemand', 'referenceDemandCompatible',
  'referenceNeedsPreparation', 'approximationPreparation', 'inwardPreparationContinues',
  'workRequest', 'requirePreparedInwardView', 'sameView', 'sameBlaPolicy', 'renderRequest',
];
const methods = methodNames.map(name => {
  const node = renderer.members.find(n => ts.isMethodDeclaration(n) && n.name?.text === name);
  assert.ok(node, `Production method ${name} must exist`);
  return node.getText(sf);
}).join('\n');
const declarations = new Map(sf.statements.filter(n => n.name && !ts.isClassDeclaration(n)).map(n => [n.name.text, n]));
const picked = new Map();
function select(node) {
  function walk(n) {
    if (ts.isIdentifier(n)) {
      const decl = declarations.get(n.text);
      if (decl && !picked.has(n.text) && !ts.isInterfaceDeclaration(decl) && !ts.isTypeAliasDeclaration(decl)) {
        picked.set(n.text, decl); walk(decl);
      }
    }
    ts.forEachChild(n, walk);
  }
  walk(node);
}
for (const name of methodNames) select(renderer.members.find(n => ts.isMethodDeclaration(n) && n.name?.text === name));
const source = [...picked.values()].map(n => n.getText(sf)).join('\n') +
  '\nconst LIMB_PROFILES=[8,16,32,64,128,256]; class LiveDemandChanged extends Error {}\n' +
  `class Probe { ${methods} } exports.Probe=Probe; exports.limbsForScale=limbsForScale; exports.blaTableEpsilon=blaTableEpsilon;`;
const exportsObject = {};
const context = {
  exports: exportsObject, Decimal, console, DOMException,
  ...load('src/tuning.ts'), ...load('src/rotation.ts'), ...load('src/coordinate.ts'),
  ...load('src/logic/colorSettings.ts'), ...load('src/render/sample-grid.ts'),
  ...load('src/render/numerical-grid.ts'), ...load('src/render/quality.ts'),
  ...load('src/render/reference-orbit.ts'),
};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context, { filename: 'actual-renderer-preparation-methods.js' });
const { Probe, limbsForScale, blaTableEpsilon } = exportsObject;
const D = value => new Decimal(value);
function request(changes = {}) {
  return {
    centerX: D('-.75'), centerY: D('.1'), unitsPerPixel: D('1e-15'),
    width: 1600, height: 900, maxIterations: 1000,
    family: 'mandelbrot', useApprox: true, colors: { mode: 0, supersample: 1 },
    tuning: { ...context.DEFAULT_TUNING }, followView: true,
    interacting: true, heldInwardZoom: true, zoom: 1, workView: true, ...changes,
  };
}
function probe() {
  const p = new Probe();
  Object.assign(p, {
    refX: D('-.75'), refY: D('.1'), refValid: false,
    ctx: { device: { limits: { maxStorageBufferBindingSize: 2 ** 28,
      maxBufferSize: 2 ** 28, maxTextureDimension2D: 8192 } } },
  });
  return p;
}
function contracted(initial, factor = 8) {
  return { ...initial, unitsPerPixel: initial.unitsPerPixel.div(factor),
    centerX: initial.centerX.plus(initial.unitsPerPixel.times(600)) };
}
function commitReference(p, demand) {
  Object.assign(p, { refValid: true, refFamily: demand.input.family,
    refConstant: '', refLimbs: demand.input.limbs, refIterations: demand.input.maxIterations,
    refEscaped: false, refX: demand.referenceX, refY: demand.referenceY,
    refSamples: new Float32Array(10),
    refTerminal: { identity: context.referenceIdentity(demand.input) } });
}

test('unfinished inward reference survives contained drift without widening committed-reference reuse', () => {
  const p = probe(), initial = request(), limbs = limbsForScale(initial.unitsPerPixel, 96);
  const demand = p.referenceDemand(initial, limbs);
  for (const factor of [2, 4, 8, 16, 64, 256]) {
    const latest = contracted(initial, factor);
    // Known rectangle: use factors >=4 so its furthest X is at most
    // 800 initial pixels and furthest Y is at most 450 initial pixels.
    if (factor === 2) continue;
    const farX = D(600).plus(D(800).div(factor));
    const farY = D(450).div(factor);
    assert.ok(farX.lte(800) && farY.lte(450));
    assert.equal(p.referenceDemandCompatible(demand, latest), true, `pending at factor ${factor}`);
    commitReference(p, demand);
    assert.equal(p.referenceNeedsPreparation(latest, limbs), true, `latest field must refresh at factor ${factor}`);
    assert.equal(p.referenceNeedsPreparation(initial, limbs), false, 'the original admitted field keeps its original reference');
  }
});

test('preparation rejects viewport escape even inside the original circumcircle', () => {
  const p = probe(), initial = request(), demand = p.referenceDemand(initial, 8);
  const outside = contracted(initial);
  outside.centerX = initial.centerX.plus(initial.unitsPerPixel.times(750));
  // Furthest corner lies inside the old radius, but crosses its right edge.
  assert.ok(D(850).pow(2).plus(D(56.25).pow(2)).lt(D(800).pow(2).plus(D(450).pow(2))));
  assert.equal(p.inwardPreparationContinues(initial, outside), false);
  assert.equal(p.referenceDemandCompatible(demand, outside), false);
});

test('pending reference containment uses live visible bounds before numerical-grid expansion', () => {
  const p = probe(), initial = request(), demand = p.referenceDemand(initial, 8);
  const latest = { ...contracted(initial, 4), workView: undefined };
  // Right visible edge is exactly the original right edge: 600 + 800/4.
  assert.equal(p.inwardPreparationContinues(initial, latest), true);
  const expanded = p.workRequest(latest);
  assert.ok(expanded.width > latest.width);
  assert.equal(p.inwardPreparationContinues(initial, expanded), false,
    'block-rounded numerical padding extends beyond the admitted original field');
  assert.equal(p.referenceDemandCompatible(demand, latest), true,
    'padding for the next field must not cancel the still-valid current field');
});

for (const [label, changes] of [
  ['stationary', { zoom: 0 }], ['outward', { zoom: -1 }],
  ['wheel-only zoom', { heldInwardZoom: false }],
  ['unspecified held input', { heldInwardZoom: undefined }],
  ['released interaction', { interacting: false }],
  ['one-shot', { followView: false }], ['rotation', { angle: .2 }],
  ['no partial publication', { publishPartial: false }],
  ['export', { exportDomain: { width: 1600, height: 900, x: 0, y: 0 } }],
  ['oversampling', { stationaryOversampling: true }],
  ['non-ordinary colour mode', { colors: { mode: 1, supersample: 1 } }],
  ['supersampling', { colors: { mode: 0, supersample: 2 } }],
  ['capped display', { colors: { mode: 0, supersample: 1, capped: 1 } }],
  ['endpoint display', { colors: { mode: 0, supersample: 1, effect: 5 } }],
  ['Direct', { unitsPerPixel: D('1e-12') }],
  ['family', { family: 'julia', juliaX: D(0), juliaY: D(0) }],
  ['precision', { unitsPerPixel: D('1e-40') }],
  ['budget', { maxIterations: 1001 }],
]) test(`${label} cannot acquire the contained preparation admission`, () => {
  const p = probe(), initial = request(), demand = p.referenceDemand(initial, 8);
  const latest = { ...contracted(initial), ...changes };
  assert.equal(p.referenceDemandCompatible(demand, latest), false);
});

for (const [label, changes] of [
  ['stationary preparation', { zoom: 0 }], ['outward preparation', { zoom: -1 }],
  ['wheel-only preparation', { heldInwardZoom: false }],
  ['unspecified held preparation', { heldInwardZoom: undefined }],
  ['non-interacting preparation', { interacting: false }],
  ['one-shot preparation', { followView: false }], ['rotated preparation', { angle: .2 }],
  ['complete-only preparation', { publishPartial: false }],
  ['export preparation', { exportDomain: { width: 1600, height: 900, x: 0, y: 0 } }],
  ['oversampled preparation', { stationaryOversampling: true }],
  ['endpoint preparation', { colors: { mode: 0, supersample: 1, effect: 5 } }],
  ['non-ordinary preparation', { colors: { mode: 1, supersample: 1 } }],
  ['supersampled preparation', { colors: { mode: 0, supersample: 2 } }],
  ['capped preparation', { colors: { mode: 0, supersample: 1, capped: 1 } }],
  ['Julia preparation', { family: 'julia' }],
]) test(`${label} cannot finish through the inward snapshot exception`, () => {
  const p = probe(), initial = request(), latest = contracted(initial);
  assert.equal(p.inwardPreparationContinues({ ...initial, ...changes }, latest), false);
});

test('completed reference still checks validity, family, precision and cap', () => {
  const initial = request(), latest = contracted(initial);
  for (const change of [
    p => { p.refValid = false; }, p => { p.refFamily = 'julia'; },
    p => { p.refLimbs = 16; }, p => { p.refIterations = 999; },
  ]) {
    const p = probe(), demand = p.referenceDemand(initial, 8);
    commitReference(p, demand); change(p);
    assert.equal(p.referenceNeedsPreparation(latest, 8), true);
  }
});

test('real chunked preparation completes across successive off-centre inward grids', async () => {
  const { prepareReference } = load('src/render/reference-preparation.ts');
  const p = probe(), initial = request({ centerX: D(0), centerY: D(0), workView: undefined });
  let latest = initial;
  const work = p.workRequest(initial), demand = p.referenceDemand(work, 8);
  let chunks = 0, checks = 0;
  const prepared = await prepareReference(demand.input, async (input, resume) => {
    chunks++;
    latest = contracted(initial, 2 ** (chunks + 2));
    const packed = context.generatePackedReference(input, resume, 125);
    await Promise.resolve();
    return packed;
  }, () => {
    checks++;
    assert.equal(p.referenceDemandCompatible(demand, latest), true,
      'the same admitted reference must survive each async chunk boundary');
  });
  assert.equal(chunks, 8);
  assert.ok(checks > chunks * 2);
  assert.equal(prepared.terminal.iteration, demand.input.maxIterations);
  assert.equal(prepared.escaped, false);
  commitReference(p, demand);
  p.refSamples = prepared.samples; p.refTerminal = prepared.terminal;
  const finalWork = p.workRequest(latest);
  const quarterSpan = finalWork.unitsPerPixel.times(Math.min(finalWork.width, finalWork.height) / 4);
  assert.ok(finalWork.centerX.minus(p.refX).abs().plus(finalWork.centerY.minus(p.refY).abs()).gt(quarterSpan),
    'fixture must actually exercise the widened admission rather than the old centre allowance');
  assert.equal(p.referenceNeedsPreparation(finalWork, 8), true,
    'continuing preparation must not admit the old reference into the new finer field');
  p.currentView = latest;
  assert.doesNotThrow(() => p.requirePreparedInwardView(work),
    'the valid original numerical snapshot is allowed to publish first');
  assert.equal(p.currentView?.zoom ?? latest.zoom, 1);
});

test('exact-prefix budget extension retains the original strict centre allowance', () => {
  const p = probe(), initial = request(), demand = p.referenceDemand(initial, 8);
  commitReference(p, demand);
  const latest = { ...contracted(initial), centerX: initial.centerX.plus(initial.unitsPerPixel.times(10)), maxIterations: 2000 };
  const extension = p.referenceDemand(latest, 8);
  assert.ok(extension.referenceX.eq(demand.referenceX));
  assert.ok(extension.referenceY.eq(demand.referenceY));
  assert.equal(context.referenceIdentity(extension.input), context.referenceIdentity(demand.input));
  const far = { ...contracted(initial), maxIterations: 2000 };
  assert.ok(context.referenceIdentity(p.referenceDemand(far, 8).input) !== context.referenceIdentity(demand.input));
});

test('unusable BLA narrowing policy remains active for each newly admitted field', () => {
  const p = probe(), initial = request(), demand = p.referenceDemand(initial, 8);
  commitReference(p, demand);
  p.tableMaxDelta = D('1e-12'); p.tableEpsilonLog2 = blaTableEpsilon(initial);
  p.laHasUsableMultiStep = false;
  p.laLevels=2;
  const latest = contracted(initial);
  assert.equal(p.approximationPreparation(latest).needed, true);
  assert.equal(p.approximationPreparation({ ...latest, zoom: 0 }).needed, true);
  assert.equal(p.approximationPreparation({ ...latest, zoom: -1 }).needed, true);
  const changedEpsilon = { ...latest, tuning: { ...latest.tuning, blaPrecisionLog2: -24 } };
  assert.equal(p.approximationPreparation(changedEpsilon).needed, true);
  const bigger = { ...latest, unitsPerPixel: initial.unitsPerPixel.times(2) };
  assert.equal(p.approximationPreparation(bigger).needed, true);
});

test('a structurally empty BLA table cannot gain skips by narrowing its unchanged orbit',()=>{
  const p=probe(),initial=request();commitReference(p,p.referenceDemand(initial,8));
  p.laLevels=0;p.laHasUsableMultiStep=false;p.tableMaxDelta=D('1e-12');p.tableEpsilonLog2=blaTableEpsilon(initial);
  const smaller=contracted(initial);
  assert.equal(p.approximationPreparation(smaller).needed,false);
  assert.equal(p.approximationPreparation({...smaller,tuning:{...smaller.tuning,blaPrecisionLog2:-24}}).needed,true);
  assert.equal(p.approximationPreparation({...initial,unitsPerPixel:initial.unitsPerPixel.times(2)}).needed,true);
});

test('repeated costly preparation boundaries admit the captured field before held-zoom retarget', async () => {
  const p = probe();
  let latest = request({ workView: undefined });
  p.currentView = latest;
  const initialWork = p.workRequest(latest);
  const demand = p.referenceDemand(initialWork, limbsForScale(initialWork.unitsPerPixel, 96));
  let retries = 0, publications = 0;
  p.clearContinuationWork = () => { retries++; };
  p.retainPartial = () => false; p.pendingRetain = Promise.resolve();
  p.isComplete = () => true;
  p.renderTarget = async r => {
    for (const factor of [4, 8, 16, 32, 64]) {
      latest = { ...latest, unitsPerPixel: initialWork.unitsPerPixel.div(factor) };
      p.currentView = latest;
      assert.equal(p.referenceDemandCompatible(demand, latest), true);
      await Promise.resolve();
      p.requirePreparedInwardView(r);
    }
    commitReference(p, demand);
    assert.equal(p.referenceNeedsPreparation(r, limbsForScale(r.unitsPerPixel, 96)), false);
    publications++;
    return { completed: true };
  };
  const result = await p.renderRequest(latest);
  assert.equal(result.completed, true);
  assert.equal(retries, 0, 'contained inward camera changes must not discard the admitted snapshot');
  assert.equal(publications, 1, 'the captured numerical field can publish while input is still held');
  assert.equal(p.currentView.zoom, 1);
});

test('continuation geometry retarget waits for first publication only while its admitted snapshot contains live demand', () => {
  const target = renderer.members.find(n => ts.isMethodDeclaration(n) && n.name?.text === 'renderTarget');
  const conditions = [];
  function visit(n) {
    if (ts.isIfStatement(n) && n.expression.getText(sf).includes('targetStartingSerial')) conditions.push(n.expression);
    ts.forEachChild(n, visit);
  }
  visit(target);
  assert.equal(conditions.length, 1, 'test must exercise the production first-publication continuation guard');
  const conditionContext = { ...context, exports: {}, performance: { now: () => 10000 } };
  vm.runInNewContext(ts.transpileModule(
    `exports.check=function(request,live,targetStartingSerial,targetStarted,tuning){return ${conditions[0].getText(sf)}};`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText, conditionContext);
  const check = conditionContext.exports.check;
  const p = probe(), initial = request({ workView: undefined });
  const prepared = p.workRequest(initial), latest = contracted(initial);
  p.partialSerial = 7;
  assert.equal(check.call(p, prepared, latest, 7, 0, prepared.tuning), false,
    'camera drift before first real publication must not discard the original unfinished slice');
  p.partialSerial++;
  assert.equal(check.call(p, prepared, latest, 7, 0, prepared.tuning), true,
    'one real publication restores the existing geometry-retarget decision');
  p.partialSerial = 7;
  for (const changes of [{ zoom: 0 }, { zoom: -1 }, { interacting: false },
    { heldInwardZoom: false }, { heldInwardZoom: undefined },
    { centerX: initial.centerX.plus(initial.unitsPerPixel.times(2000)) }]) {
    assert.equal(check.call(p, prepared, { ...latest, ...changes }, 7, 0, prepared.tuning), true,
      'release, outward motion or escaped bounds must retain immediate retarget');
  }
});
