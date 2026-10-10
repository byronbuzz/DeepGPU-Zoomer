const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const Decimal = require('decimal.js');

// A source override permits reproducing the failure on the preserved accepted
// source. The probe executes the owner/planners; only GPU work is inert.
const root = process.env.DEEPGPU_RETAINED_DETAIL_SOURCE_ROOT || path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
function load(file, dependencies = {}) {
  const result = {};
  new Function('exports', 'require', transpile(read(file)))(result,
    name => dependencies[name] || require(name));
  return result;
}
const rotation = load('src/rotation.ts');
const geometry = fs.existsSync(path.join(root, 'src/render/exact-geometry-cache.ts')) ? load('src/render/exact-geometry-cache.ts') : {};
const reprojection = load('src/render/reprojection.ts', {'../rotation': rotation, './exact-geometry-cache': geometry});
const grid = load('src/render/sample-grid.ts');
const numerical = load('src/render/numerical-grid.ts', {'./sample-grid': grid});
const {CoverageRegions} = load('src/render/regions.ts');
const tuning = load('src/tuning.ts');
const rendererFile = path.join(root, 'src/render/webgpu-renderer.ts');
const source = ts.createSourceFile(rendererFile, read('src/render/webgpu-renderer.ts'),
  ts.ScriptTarget.Latest, true);
const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'WebGpuRenderer');
const methodNames = ['retainPartial', 'coverageIn', 'hasFinerRetainedCoverage',
  'samePresentation', 'presentationCompatible', 'stalePresentationCompatible'];
const methods = methodNames.map(name => {
  const node = owner.members.find(member => ts.isMethodDeclaration(member) && member.name?.text === name);
  assert.ok(node, `production method ${name} must exist`);
  return node.getText(source);
});
const topNames = ['Method', 'exportIdentity', 'approximationEligible', 'effectiveBlaEpsilon', 'linearBlaPolicy'];
const tops = topNames.map(name => {
  const node = source.statements.find(statement => statement.name?.text === name);
  assert.ok(node, `production dependency ${name} must exist`);
  return node.getText(source);
});
const api = {};
const helpers = {...grid, ...reprojection, ...numerical, CoverageRegions,
  mandelbrotBlaEpsilon: tuning.mandelbrotBlaEpsilon,
  GPUTextureUsage: {TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2},
  checkedGpu: (device, callback) => {
    callback();
    return device.validationGate?.promise || Promise.resolve();
  }};
new Function('exports', 'Decimal', ...Object.keys(helpers), transpile(`
${tops.join('\n')}
class RetainedProbe { ${methods.join('\n')} }
exports.RetainedProbe = RetainedProbe;
`))(api, Decimal, ...Object.values(helpers));

function frame(patch = {}) {
  return {centerX: new Decimal(0), centerY: new Decimal(0), unitsPerPixel: new Decimal(1),
    width: 2560, height: 1440, angle: 0, family: 'mandelbrot', maxIterations: 1306982,
    useApprox: true, colors: {mode: 0, supersample: 1, offset: 0},
    tuning: {...tuning.DEFAULT_TUNING}, followView: true, interacting: false, zoom: 0,
    ...patch};
}
function texture(name) {
  return {name, destroyed: false, destroy() { this.destroyed = true; }};
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
function probe(incoming, live = incoming) {
  const p = new api.RetainedProbe(), created = [], blits = [];
  const device = {limits: {maxTextureDimension2D: 8192},
    createTexture(descriptor) {
      const t = {...texture(descriptor.label), descriptor};
      created.push(t); return t;
    },
    createCommandEncoder() { return {finish() { return {}; }}; },
    queue: {submit() {}},
  };
  Object.assign(p, {disposed: false, deviceLost: false, ctx: {device}, target: texture('incoming'),
    incomingFrame: incoming, currentView: live, partialRegions: 1, pendingRetain: null,
    history: null, historyValid: false, lastFrame: null, coverageHistory: null,
    coverageFrame: null, spareHistory: null, retainedAnchor: null,
    publicationEpoch: 0, determined: new CoverageRegions(), created, blits});
  p.determined.add({x: Math.floor(incoming.width / 4), y: Math.floor(incoming.height / 4),
    width: 120, height: 80, spacing: 1});
  p.capUpgradeBase = () => null;
  p.encodeBlit = (_encoder, selected, mapping, destination) => {
    blits.push({view: p.currentView, selected, mapping, destination});
  };
  return p;
}
async function retain(p, keepIncoming = false) {
  assert.equal(p.retainPartial(false, keepIncoming), true);
  const operation = p.pendingRetain;
  assert.ok(operation, 'actual GPU-validation operation must be tracked');
  assert.equal(await operation, true);
  assert.equal(p.pendingRetain, null);
  return p.lastFrame;
}
function sameGeometry(actual, expected) {
  for (const key of ['width', 'height']) assert.equal(actual[key], expected[key], key);
  for (const key of ['centerX', 'centerY', 'unitsPerPixel']) {
    assert(actual[key].eq(expected[key]), `${key}: ${actual[key]} versus ${expected[key]}`);
  }
  assert.equal(actual.angle ?? 0, expected.angle ?? 0);
}
function assertPartialMetadata(p, incoming, retained) {
  assert.equal(retained.proxy, true);
  assert.equal(retained.stationaryOversampling, false);
  assert.equal(retained.snapshotComplete, undefined, 'partial colour snapshot is not completed numerics');
  assert.equal(retained.maxIterations, incoming.maxIterations);
  assert.deepEqual(retained.colors, incoming.colors);
  assert(retained.coveredRegions.length > 0);
  assert(retained.coveredRegions.some(r => r.spacing.div(incoming.unitsPerPixel)
    .minus(1).abs().lte(4 * Number.EPSILON)),
    'native world spacing survives the scheduling hint ratio round-trip');
  assert.equal(p.history, p.created[0]);
  sameGeometry(p.blits[0].view, retained);
}

test('fixed 2560x1440 partial snapshot does not halve visible native detail', async () => {
  const incoming = frame(), p = probe(incoming);
  const retained = await retain(p);
  sameGeometry(retained, incoming);
  assertPartialMetadata(p, incoming, retained);
});

test('stationary release crops an oversized inward field on its native source edges', async () => {
  const incoming = frame({width: 2624, height: 1472, interacting: true, zoom: 1});
  const live = frame(), expected = grid.sourceAlignedRetainedView(incoming, live, 8192);
  assert.ok(expected);
  const p = probe(incoming, live), retained = await retain(p);
  sameGeometry(retained, expected);
  assert(retained.unitsPerPixel.eq(incoming.unitsPerPixel));
  assert(numerical.containsNumericalView(retained, live));
  assertPartialMetadata(p, incoming, retained);
});

test('held zoom retains exact live pixel centres when source and live dimensions are equal', async () => {
  const incoming = frame({interacting: true, zoom: 1});
  const live = frame({unitsPerPixel: new Decimal('.9'), interacting: true, zoom: 1});
  const p = probe(incoming, live), retained = await retain(p);
  sameGeometry(retained, live);
  assert.equal(retained.width, 2560);
  assert.equal(retained.height, 1440);
  assert(retained.unitsPerPixel.eq('.9'));
  assert(numerical.containsNumericalView(retained, live));
  assertPartialMetadata(p, incoming, retained);
  const coverage = p.coverageIn(retained, live);
  assert(coverage.every(r => r.spacing.gte(incoming.unitsPerPixel.times(1 - 4 * Number.EPSILON))),
    'display-grid retention must not relabel native source samples as finer live samples');
  assert(coverage.every(r => r.spacing.gte(retained.unitsPerPixel)));
});

test('held fractional moving grid retains the exact live centre and spacing at deep scale', async () => {
  const h = new Decimal('1e-262');
  const incoming = frame({width: 5120, height: 2880, unitsPerPixel: h.times('.5'),
    interacting: true, zoom: 1});
  const live = frame({centerX: h.times('.1375'), centerY: h.times('-.3125'),
    unitsPerPixel: h.times('.73'), interacting: true, zoom: 1});
  const p = probe(incoming, live), retained = await retain(p);
  sameGeometry(retained, live);
  assert.equal(p.currentView, live, 'snapshot encoding restores live request ownership');
  sameGeometry(p.blits[0].view, live);
  const coverage = p.coverageIn(retained, live), minimum = Decimal.max(
    incoming.unitsPerPixel, retained.unitsPerPixel);
  assert(coverage.length > 0);
  assert(coverage.every(r => r.spacing.gte(minimum)),
    'covered rectangles respect both native source spacing and retained texel spacing');
  assert(coverage.some(r => r.spacing.eq(retained.unitsPerPixel)));
  assert.equal(retained.colors, incoming.colors);
  assert.equal(retained.maxIterations, incoming.maxIterations);
  assert(retained.coveredRegions.every(r => r.spacing.gte(
    incoming.unitsPerPixel.times(1 - 4 * Number.EPSILON))));
});

test('a fitting finer native crop cannot override held display geometry, but remains available on release', async () => {
  const incoming = frame({unitsPerPixel: new Decimal('.5'), interacting: true, zoom: 1});
  const held = frame({width: 1280, height: 720, interacting: true, zoom: 1});
  const native = grid.sourceAlignedRetainedView(incoming, held, 8192);
  assert.ok(native);
  assert.equal(native.width, 2560);
  assert(native.unitsPerPixel.eq('.5'));
  const active = probe(incoming, held), activeRetained = await retain(active);
  sameGeometry(activeRetained, held);
  assert(active.coverageIn(activeRetained, held).every(r => r.spacing.gte(held.unitsPerPixel)));
  const released = {...held, interacting: false, zoom: 0};
  const settled = probe(incoming, released), settledRetained = await retain(settled);
  sameGeometry(settledRetained, native);
  assertPartialMetadata(settled, incoming, settledRetained);
});

test('held oversized fine grid retains the full display grid when native source cropping exceeds the cap', async () => {
  const incoming = frame({width: 5120, height: 2880, unitsPerPixel: new Decimal('.5'),
    interacting: true, zoom: 1});
  const live = frame({interacting: true, zoom: 1});
  assert.equal(grid.sourceAlignedRetainedView(incoming, live, 8192), null);
  const p = probe(incoming, live), retained = await retain(p);
  sameGeometry(retained, live);
  assert(numerical.containsNumericalView(retained, live));
  assert(retained.coveredRegions.length > 0);
  const coverage = p.coverageIn(retained, live);
  assert(coverage.length > 0);
  assert(coverage.every(r => r.spacing.gte(retained.unitsPerPixel)),
    'coverage hints cannot certify the superseded half-pixel source density');
  assert(coverage.some(r => r.spacing.eq(retained.unitsPerPixel)));
  assert.equal(p.created[0].descriptor.size[0], 2560);
  assert.equal(p.created[0].descriptor.size[1], 1440);
});

test('display-grid fallback copies geometry without adopting the live cap or appearance object', async () => {
  const capturedColors = {mode: 0, supersample: 1, offset: 0};
  const incoming = frame({width: 5120, height: 2880, unitsPerPixel: new Decimal('.5'),
    interacting: true, zoom: 1, maxIterations: 1000000, colors: capturedColors});
  const liveColors = {...capturedColors};
  const live = frame({interacting: true, zoom: 1, maxIterations: 1306982,
    colors: liveColors, dynamicIterations: true, provisionalNavigationCap: true});
  const p = probe(incoming, live);
  assert.equal(p.presentationCompatible(incoming, live), true,
    'a captured prior cap remains a legitimate provisional display source');
  assert.equal(p.samePresentation(incoming, live), false);
  const retained = await retain(p);
  sameGeometry(retained, live);
  assert.equal(retained.maxIterations, incoming.maxIterations);
  assert.equal(retained.colors, capturedColors);
  assert.notEqual(retained.colors, liveColors);
  assert.equal(p.blits[0].view.maxIterations, incoming.maxIterations);
  assert.equal(p.blits[0].view.colors, capturedColors);
  assert.equal(retained.dynamicIterations, incoming.dynamicIterations);
  assert.equal(retained.provisionalNavigationCap, incoming.provisionalNavigationCap);
  assert(p.coverageIn(retained, live).every(r => r.spacing.gte(retained.unitsPerPixel)));
  liveColors.offset = 1;
  assert.equal(retained.colors.offset, 0, 'a later live appearance change cannot relabel retained pixels');
  assert.equal(p.presentationCompatible(retained, live), false);
});

test('released crop remains exact at a deep Decimal scale and off-centre source alignment', async () => {
  const h = new Decimal('1e-262'), incoming = frame({width: 2688, height: 1536,
    unitsPerPixel: h, centerX: h.times(3), centerY: h.times(-5), interacting: true, zoom: 1});
  const live = frame({unitsPerPixel: h}), expected = grid.sourceAlignedRetainedView(incoming, live, 8192);
  assert.ok(expected);
  const p = probe(incoming, live), retained = await retain(p);
  sameGeometry(retained, expected);
  assertPartialMetadata(p, incoming, retained);
});

test('outward retention preserves the broad source footprint instead of cropping it to the live view', async () => {
  const incoming = frame({width: 3840, height: 2160, interacting: true, zoom: -1});
  const live = frame({width: 1280, height: 720, unitsPerPixel: new Decimal(2), interacting: true, zoom: -1});
  const expected = grid.planRetainedView(incoming, grid.createSampleGridAnchor(incoming),
    {overscan: 1, deviceLimit: 8192});
  const p = probe(incoming, live), retained = await retain(p);
  sameGeometry(retained, expected);
  assert(numerical.containsNumericalView(retained, incoming));
  assert(retained.width <= grid.RETAINED_WIDTH && retained.height <= grid.RETAINED_HEIGHT);
});

test('rotated retention continues to use bounded source geometry', async () => {
  const incoming = frame({width: 3200, height: 1800, angle: 30});
  const live = frame({width: 1920, height: 1080, angle: 30});
  const p = probe(incoming, live), retained = await retain(p);
  sameGeometry(retained, grid.boundedRetainedView(incoming, 8192));
});

test('a visible native crop exceeding the history cap is rejected and remains bounded', async () => {
  const incoming = frame({width: 4096, height: 2304});
  const live = frame({width: 1920, height: 1080, unitsPerPixel: new Decimal(2)});
  assert.equal(grid.sourceAlignedRetainedView(incoming, live, 8192), null);
  const p = probe(incoming, live), retained = await retain(p);
  assert(retained.width <= grid.RETAINED_WIDTH && retained.height <= grid.RETAINED_HEIGHT);
  assert(retained.unitsPerPixel.gte(incoming.unitsPerPixel));
  assert(numerical.containsNumericalView(retained, live));
});

test('coarse retention keeps a finer back texture instead of replacing it with a completed coarse front', async () => {
  const incoming = frame({width: 3840, height: 2160, unitsPerPixel: new Decimal(2)});
  const live = frame({unitsPerPixel: new Decimal(3)}), p = probe(incoming, live);
  assert.equal(grid.sourceAlignedRetainedView(incoming, live, 8192), null);
  const front = frame({unitsPerPixel: new Decimal(4), proxy: true, snapshotComplete: true,
    coveredRegions: [{x: 0, y: 0, width: 2560, height: 1440, spacing: new Decimal(4)}]});
  const back = frame({unitsPerPixel: new Decimal(1), proxy: true,
    coveredRegions: [{x: 900, y: 500, width: 120, height: 80, spacing: new Decimal(1)}]});
  const frontTexture = texture('completed-coarse-front'), backTexture = texture('partial-fine-back');
  Object.assign(p, {historyValid: true, history: frontTexture, lastFrame: front,
    coverageHistory: backTexture, coverageFrame: back});
  const retained = await retain(p);
  assert(retained.unitsPerPixel.gt(back.unitsPerPixel), 'fixture forces lossy bounded retention');
  assert.equal(p.coverageHistory, backTexture);
  assert.equal(p.coverageFrame, back);
  assert.equal(backTexture.destroyed, false);
  assert.equal(frontTexture.destroyed, true);
});

test('a proven finer front replaces the coarser back when a bounded snapshot cannot preserve it', async () => {
  const incoming = frame({width: 3840, height: 2160, unitsPerPixel: new Decimal(2)});
  const live = frame({unitsPerPixel: new Decimal(3)}), p = probe(incoming, live);
  assert.equal(grid.sourceAlignedRetainedView(incoming, live, 8192), null);
  const front = frame({unitsPerPixel: new Decimal('.5'), proxy: true, snapshotComplete: true,
    coveredRegions: [{x: 900, y: 500, width: 120, height: 80, spacing: new Decimal('.5')}]});
  const back = frame({unitsPerPixel: new Decimal(1), proxy: true,
    coveredRegions: [{x: 900, y: 500, width: 120, height: 80, spacing: new Decimal(1)}]});
  const frontTexture = texture('fine-front'), backTexture = texture('coarser-back');
  Object.assign(p, {historyValid: true, history: frontTexture, lastFrame: front,
    coverageHistory: backTexture, coverageFrame: back});
  await retain(p);
  assert.equal(p.coverageHistory, frontTexture);
  assert.equal(p.coverageFrame, front);
  assert.equal(frontTexture.destroyed, false);
  assert.equal(backTexture.destroyed, true);
});

test('a finer front from an old appearance cannot displace the current-identity fine back', async () => {
  const incoming = frame({width: 3840, height: 2160, unitsPerPixel: new Decimal(2)});
  const live = frame({unitsPerPixel: new Decimal(3)}), p = probe(incoming, live);
  const front = frame({unitsPerPixel: new Decimal('.5'), proxy: true, snapshotComplete: true,
    colors: {...incoming.colors, offset: 1},
    coveredRegions: [{x: 900, y: 500, width: 120, height: 80, spacing: new Decimal('.5')}]});
  const back = frame({unitsPerPixel: new Decimal(1), proxy: true,
    coveredRegions: [{x: 900, y: 500, width: 120, height: 80, spacing: new Decimal(1)}]});
  const frontTexture = texture('old-appearance-finer-front'), backTexture = texture('current-fine-back');
  Object.assign(p, {historyValid: true, history: frontTexture, lastFrame: front,
    coverageHistory: backTexture, coverageFrame: back});
  assert.equal(p.samePresentation(front, incoming), false);
  assert.equal(p.hasFinerRetainedCoverage(front, back, live), true,
    'geometry alone would incorrectly prefer this incompatible front');
  const retained = await retain(p);
  assert.equal(p.coverageHistory, backTexture);
  assert.equal(p.coverageFrame, back);
  assert.equal(backTexture.destroyed, false);
  assert.equal(frontTexture.destroyed, true);
  assert.deepEqual(retained.colors, incoming.colors);
});

test('a provisional old higher-cap front preserves the incoming-cap fine back without relabelling either', async () => {
  const incoming = frame({width: 3840, height: 2160, unitsPerPixel: new Decimal(2),
    dynamicIterations: true, provisionalNavigationCap: true});
  const live = frame({unitsPerPixel: new Decimal(3), dynamicIterations: true, provisionalNavigationCap: true});
  const p = probe(incoming, live), priorCap = 2000000;
  const front = frame({unitsPerPixel: new Decimal('.5'), proxy: true, snapshotComplete: true,
    maxIterations: priorCap,
    coveredRegions: [{x: 900, y: 500, width: 120, height: 80, spacing: new Decimal('.5')}]});
  const back = frame({unitsPerPixel: new Decimal(1), proxy: true,
    coveredRegions: [{x: 900, y: 500, width: 120, height: 80, spacing: new Decimal(1)}]});
  const frontTexture = texture('old-higher-cap-front'), backTexture = texture('incoming-cap-fine-back');
  Object.assign(p, {historyValid: true, history: frontTexture, lastFrame: front,
    coverageHistory: backTexture, coverageFrame: back});
  assert.equal(p.presentationCompatible(front, live), true,
    'the old cap is a legitimate display-only provisional source');
  assert.equal(p.samePresentation(front, incoming), false);
  assert.equal(p.hasFinerRetainedCoverage(front, back, live), true);
  const retained = await retain(p);
  assert.equal(p.coverageHistory, backTexture);
  assert.equal(p.coverageFrame, back);
  assert.equal(backTexture.destroyed, false);
  assert.equal(frontTexture.destroyed, true);
  assert.equal(front.maxIterations, priorCap);
  assert.equal(back.maxIterations, incoming.maxIterations);
  assert.equal(retained.maxIterations, incoming.maxIterations);
});

test('publication cancellation during validation discards the new snapshot without changing history ownership', async () => {
  const incoming = frame(), p = probe(incoming), gate = deferred();
  const oldFrame = frame({proxy: true}), oldTexture = texture('old-history');
  Object.assign(p, {historyValid: true, history: oldTexture, lastFrame: oldFrame});
  p.ctx.device.validationGate = gate;
  assert.equal(p.retainPartial(false, true), true);
  const operation = p.pendingRetain;
  p.publicationEpoch++;
  gate.resolve();
  assert.equal(await operation, false);
  assert.equal(p.history, oldTexture);
  assert.equal(p.lastFrame, oldFrame);
  assert.equal(oldTexture.destroyed, false);
  assert.equal(p.created[0].destroyed, true);
  assert.equal(p.incomingFrame, incoming);
  assert.equal(p.pendingRetain, null);
});

test('appearance change during validation cannot commit a snapshot with the old identity', async () => {
  const incoming = frame(), p = probe(incoming), gate = deferred();
  p.ctx.device.validationGate = gate;
  assert.equal(p.retainPartial(false, true), true);
  const operation = p.pendingRetain;
  p.currentView = {...incoming, colors: {...incoming.colors, offset: 1}};
  gate.resolve();
  assert.equal(await operation, false);
  assert.equal(p.history, null);
  assert.equal(p.lastFrame, null);
  assert.equal(p.created[0].destroyed, true);
});

test('an initially incompatible appearance creates no snapshot and cannot retain stale coverage', () => {
  const incoming = frame(), live = {...incoming, colors: {...incoming.colors, offset: 1}};
  const p = probe(incoming, live);
  assert.equal(p.retainPartial(false), false);
  assert.equal(p.created.length, 0);
  assert.equal(p.incomingFrame, null);
  assert.equal(p.determined.rectangles.length, 0);
});
