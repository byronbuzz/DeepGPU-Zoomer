const fs = require('node:fs'), path = require('node:path');
const test = require('node:test'), assert = require('node:assert/strict');
const ts = require('typescript'), Decimal = require('decimal.js');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const compile = source => ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
function load(file, dependencies = {}) {
  const result = {};
  new Function('exports', 'require', compile(read(file)))(result,
    name => dependencies[name] || require(name));
  return result;
}
const grid = load('src/render/sample-grid.ts');
const cap = load('src/render/cap-reuse.ts', {'./sample-grid': grid});
const certificate = load('src/render/cap-certificate.ts');
const tuning = load('src/tuning.ts');
const rotation = load('src/rotation.ts');
const reprojection = load('src/render/reprojection.ts', {'../rotation': rotation});
const colors = load('src/logic/colorSettings.ts', {'./importedPalettes': {FRACTALS_PALETTES: []}});
const source = ts.createSourceFile('renderer.ts', read('src/render/webgpu-renderer.ts'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'WebGpuRenderer');
const names = ['sameView', 'sameBlaPolicy', 'isComplete', 'samePresentation', 'presentationCompatible',
  'capUpgradeBase', 'isInteracting', 'commitHistory', 'validateCapField'];
const methods = names.map(name => owner.members.find(n => ts.isMethodDeclaration(n) && n.name?.text === name).getText(source));
const tops = ['Method', 'methodForScale', 'exportIdentity', 'approximationEligible', 'effectiveBlaEpsilon', 'linearBlaPolicy']
  .map(name => source.statements.find(n => n.name?.text === name).getText(source));
const render = owner.members.find(n => ts.isMethodDeclaration(n) && n.name?.text === 'renderTarget');
// Execute the actual admission call site, not a copy of its eligibility rules.
const admission = ['capMapping', 'lowerCap', 'inPlaceCapUpgrade'].map(name => render.body.statements.find(n =>
  ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(source) === name)).getText(source));
const helpers = {...cap, ...certificate, ...reprojection, DEFAULT_TUNING: tuning.DEFAULT_TUNING,
  mandelbrotBlaEpsilon: tuning.mandelbrotBlaEpsilon, needsEndpoints: colors.needsEndpoints,
  GPUBufferUsage: {UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8},
  checkedGpu: async (_device, operation) => operation(),
  readBuffer: (device, _buffer, bytes) => device.validationGate?.promise ?? Promise.resolve(new Uint32Array(bytes/4).fill(device.flag ?? 0).buffer)};
const api = {};
new Function('exports', 'Decimal', ...Object.keys(helpers), compile(`
${tops.join('\n')}
class Probe {
  ${methods.join('\n')}
  admit(request, admitted, fieldStale = true) {
    ${admission.join('\n')}
    return {capMapping, lowerCap, inPlaceCapUpgrade};
  }
}
exports.Probe = Probe;
`))(api, Decimal, ...Object.values(helpers));
const D = Decimal.clone({precision: 400});
function request(maxIterations = 600000, patch = {}) {
  return {centerX: new D('-.7379'), centerY: new D('.1754'), unitsPerPixel: new D('1e-300'),
    width: 1760, height: 990, angle: 0, family: 'mandelbrot', maxIterations,
    useApprox: true, colors: {mode: 0, supersample: 1, offset: 0},
    tuning: {...tuning.DEFAULT_TUNING}, followView: true, interacting: false, dynamicIterations: false,
    isCurrent: () => true,
    ...patch};
}
const reference = {}, approximation = {};
function samples(view, patch = {}) {
  return {view, maxIterations: view.maxIterations, ordinary: true,
    policy: 'same-numerical-policy', reference, approximation, ...patch};
}
function probe(old) {
  const p = new api.Probe();
  Object.assign(p, {completedFrame: {...old, method: 2, grid: 1},
    fieldDescriptor: {maxIterations: old.maxIterations, family: old.family, constant: '',
      method: 2, mode: 0, grid: 1, retainEndpoints: false, useApprox: true},
    fieldView: old, fieldComplete: true, currentImageValid: true, fieldBuffer: {},
    fieldKey: 'old', admittedSamples: samples(old), aborted: false, finalizing: false,
    referencePreparing: false, disposed: false, deviceLost: false, retainEndpoints: false,
    currentView: old, capPresentationTarget: null});
  p.workRequest = r => r;
  p.hasFinerRetainedCoverage = () => false;
  return p;
}

test('manual stationary cap changes admit exact samples with Dynamic on or off', () => {
  for (const dynamicIterations of [false, true]) for (const [before, after] of
    [[600000, 10000000], [10000000, 600000], [600000, 599999]]) {
    const old = request(before), next = request(after, {dynamicIterations}), p = probe(old);
    p.currentView = next;
    const result = p.admit(next, samples(next));
    assert.deepEqual(result.capMapping, {offsetX: 0, offsetY: 0, step: 1, denominator: 1});
    assert.equal(result.lowerCap, after < before ? after : 0);
    assert.equal(result.inPlaceCapUpgrade, after > before);
    assert.equal(p.presentationCompatible(p.completedFrame, next), true);
    assert.equal(p.isComplete(next), false, 'old complete pixels do not complete the new request');
    assert.equal(p.completedFrame.maxIterations, before, 'display metadata is never relabelled');
  }
});

function validationProbe() {
  const p = probe(request()), buffers = [], submissions = [], dispatches = [];
  const pass = {setPipeline() {}, setBindGroup() {}, end() {}, dispatchWorkgroups(...args) {dispatches.push(args);}};
  const device = {createBuffer(descriptor) {const b = {descriptor, destroyed: false, destroy() {this.destroyed = true;}};buffers.push(b);return b;},
    createCommandEncoder() {return {beginComputePass() {return pass;}, finish() {return {};}};},
    createBindGroup() {return {};}, queue: {writeBuffer() {}, submit(commands) {submissions.push(commands);}}};
  Object.assign(p, {ctx: {device}, publicationEpoch: 0, capValidationPipeline: {getBindGroupLayout() {return {};}}});
  p.oncePipeline = async (_key, ready) => assert.equal(ready(), true);
  return {p, device, buffers, dispatches, submissions};
}

test('whole-field scan preserves per-tile flags and releases its buffers', async () => {
  for (const flag of [0, 1, 2, 0xffffffff]) {
    const {p, device, buffers, dispatches, submissions} = validationProbe(); device.flag = flag;
    const result=await p.validateCapField(request(10000000));
    assert.equal(certificate.capRegionResolved(result,{x:0,y:0,width:1760,height:990}),flag===0);
    assert.equal(submissions.length, 1);
    assert.deepEqual(dispatches, [[220, 124]], 'two-dimensional scan stays within per-dimension limits');
    assert.deepEqual(buffers.map(b => b.descriptor.size), [16, 220*124*4]);
    assert(buffers.every(b => b.destroyed));
  }
});

test('whole-field completion cannot survive cancellation, epoch or buffer replacement during map', async () => {
  for (const change of [p => p.abortRequested = true, p => p.publicationEpoch++,
    p => p.fieldBuffer = {}, p => p.deviceLost = true]) {
    const {p, device, buffers} = validationProbe(); let release;
    device.validationGate = {promise: new Promise(resolve => release = resolve)};
    const operation = p.validateCapField(request(10000000));
    await Promise.resolve(); await Promise.resolve();
    change(p); release(new Uint32Array(1).buffer);
    await assert.rejects(operation, error => error.name === 'AbortError');
    assert(buffers.every(b => b.destroyed));
  }
});

test('a failed validation readback cannot certify the field or leak scratch buffers', async () => {
  const {p, device, buffers} = validationProbe();
  device.validationGate = {promise: Promise.reject(new Error('readback failed'))};
  await assert.rejects(p.validateCapField(request(10000000)), /readback failed/);
  assert(buffers.every(b => b.destroyed));
});

test('manual admission rejects motion and any changed sample geometry', () => {
  const old = request(), p = probe(old);
  for (const patch of [{interacting: true}, {centerX: old.centerX.plus('1e-300')},
    {centerY: old.centerY.plus('1e-300')}, {width: old.width + 1}, {height: old.height + 1},
    {unitsPerPixel: old.unitsPerPixel.times(2)}, {angle: 1}, {followView: false}]) {
    const next = request(1000000, patch); p.currentView = next;
    assert.equal(p.admit(next, samples(next)).capMapping, null, JSON.stringify(patch));
  }
});

test('ordinary policy, reference and approximation identity remain strict', () => {
  const old = samples(request()), next = samples(request(1000000));
  for (const patch of [{ordinary: false}, {policy: 'new-policy'}, {reference: {}}, {approximation: {}}]) {
    assert.equal(cap.automaticCapRemap(old, {...next, ...patch}, false, true), null);
    assert.equal(cap.automaticCapRemap({...old, ...patch}, next, false, true), null);
  }
  assert.equal(cap.automaticCapRemap(null, next, false, true), null);
  assert.equal(cap.automaticCapRemap(old, old, false, true), null);
  assert.equal(cap.automaticCapRemap(old, next, false, false), null);
});

test('automatic navigation retains its existing exact translated remap', () => {
  const old = request(), next = request(1000000, {centerX: old.centerX.plus(old.unitsPerPixel),
    dynamicIterations: true, provisionalNavigationCap: true, interacting: true});
  const p = probe(old); p.currentView = next;
  assert.deepEqual(p.admit(next, samples(next)).capMapping,
    {offsetX: 1, offsetY: 0, step: 1, denominator: 1});
});

test('cancelled or unfinished upgrades use remap instead of the completed-field shortcut', () => {
  const old = request(), next = request(10000000), p = probe(old); p.currentView = next;
  for (const patch of [{aborted: true}, {fieldComplete: false}, {currentImageValid: false}]) {
    Object.assign(p, {aborted: false, fieldComplete: true, currentImageValid: true}, patch);
    const result = p.admit(next, samples(next));
    assert.ok(result.capMapping, 'observed samples can survive a cancelled partial calculation');
    assert.equal(result.inPlaceCapUpgrade, false);
  }
});

test('previous-cap display accepts bounded textures while appearance/family/policy stay strict', () => {
  const old = request(10000000), next = request(600000), p = probe(old);
  const retained = {...p.completedFrame, width: old.width / 2, height: old.height / 2,
    unitsPerPixel: old.unitsPerPixel.times(2), proxy: true};
  assert.equal(p.presentationCompatible(retained, next), true);
  assert.ok(reprojection.reprojectionFor(retained, next));
  assert.equal(p.samePresentation(retained, next), false);
  for (const patch of [{colors: {...next.colors, offset: 1}}, {family: 'julia'}, {useApprox: false},
    {tuning: {...next.tuning, blaPrecisionLog2: -24}}, {followView: false}, {interacting: true},
    {exportDomain: {width: 1760, height: 990, x: 0, y: 0}}]) {
    assert.equal(p.presentationCompatible(retained, {...next, ...patch}), false, JSON.stringify(patch));
  }
});

test('history handover retains separate prior-cap metadata and releases it on an incompatible change', () => {
  for (const [before, after] of [[600000, 10000000], [10000000, 600000]]) {
    const old = request(before), next = request(after), p = probe(old);
    const prior = {...old, proxy: true, snapshotComplete: true}, priorTexture = {destroy() {}}, incoming = {};
    Object.assign(p, {currentView: next, lastFrame: prior, historyValid: true, history: priorTexture,
      coverageFrame: null, coverageHistory: null, spareHistory: null});
    p.commitHistory(next, incoming);
    assert.equal(p.coverageHistory, priorTexture);
    assert.equal(p.coverageFrame, prior);
    assert.equal(p.coverageFrame.maxIterations, before);
    assert.equal(p.history, incoming);
    p.currentView = {...next, colors: {...next.colors, offset: 1}};
    p.commitHistory(p.currentView, {});
    assert.equal(p.coverageFrame, null);
  }
});
