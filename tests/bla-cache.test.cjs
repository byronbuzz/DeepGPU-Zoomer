const fs = require('node:fs'), path = require('node:path');
const test = require('node:test'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), ts = require(root + '/node_modules/typescript');
const modules = new Map();
function load(file) {
  file = path.resolve(root, file); if (!path.extname(file)) file += '.ts';
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022},
  }).outputText;
  new Function('exports', 'require', code)(exports, name => name.startsWith('.')
    ? load(path.resolve(path.dirname(file), name)) : require(root + '/node_modules/' + name));
  return exports;
}
const Decimal = require(root + '/node_modules/decimal.js');
const {BlaTableCache} = load('src/render/bla-cache.ts');
const {buildBlaAsync, ENTRY_FLOATS} = load('src/render/bla.ts');
const {generatePackedReference} = load('src/render/reference-orbit.ts');
function fixture(centerX = '.25', cap = 64, family = 'mandelbrot') {
  const orbit = generatePackedReference({family, centerX, centerY:'0', juliaX:'-.1', juliaY:'.2', limbs:8, maxIterations:cap});
  return {samples:new Float32Array(orbit.buffer), length:orbit.length, words:orbit.sampleWords};
}
const delta = new Decimal('1e-12'), epsilon = -24;
const build = (f, d = delta, e = epsilon, checkpoint = async () => {}) =>
  buildBlaAsync(f.samples, f.length, d, checkpoint, {sampleWords:f.words, epsilonLog2:e});
const get = (cache, f, d = delta, e = epsilon) => cache.get(f.samples, f.length, f.words, e, d);
const remember = (cache, f, table, d = delta, e = epsilon) => cache.remember(f.samples, f.length, f.words, e, d, table);
const bytes = table => Buffer.from(table.data.buffer, table.data.byteOffset, table.data.byteLength);
const charge = (f, table) => f.samples.byteLength + table.data.byteLength + 4 * (table.levelOffsets.length + table.levelCounts.length);

test('actual completed table hits preserve packed bytes and detach mutable metadata', async () => {
  const f = fixture(), table = await build(f), cache = new BlaTableCache();
  const before = Buffer.from(bytes(table)); remember(cache, f, table);
  const hit = get(cache, f);
  assert.ok(hit); assert.notEqual(hit.table, table); assert.equal(hit.table.data, table.data);
  assert.deepEqual(bytes(hit.table), before);
  assert.deepEqual(hit.table.levelOffsets, table.levelOffsets);
  assert.deepEqual(hit.table.levelCounts, table.levelCounts);
  assert.equal(hit.maxDelta.eq(delta), true);
  table.levelOffsets[0] = 123; table.levelCounts[0] = 123; table.hasUsableMultiStep = false;
  assert.equal(get(cache, f).table.levelOffsets[0], 0);
  assert.equal(get(cache, f).table.levelCounts[0], 0);
  assert.equal(get(cache, f).table.hasUsableMultiStep, true);
  assert.ok(Object.isFrozen(hit.table)); assert.ok(Object.isFrozen(hit.table.levelOffsets));
  hit.maxDelta.d[0] = 9;
  assert.equal(get(cache, f).maxDelta.eq(delta), true, 'returned radius cannot mutate admission');
});

test('contained radius is conservative; wider, epsilon and orbit identity changes miss', async () => {
  const f = fixture(), cache = new BlaTableCache(), table = await build(f); remember(cache, f, table);
  assert.equal(get(cache, f, delta.div(2)).table.data, table.data);
  assert.equal(get(cache, f, delta.times(2)), undefined);
  assert.equal(get(cache, f, delta, -14), undefined);
  assert.equal(get(cache, {...f, samples:new Float32Array(f.samples)}), undefined);
  assert.equal(cache.get(f.samples, f.length - 1, f.words, epsilon, delta), undefined);
  assert.equal(cache.get(f.samples, f.length, 20, epsilon, delta), undefined);
  assert.equal(get(cache, {...f, samples:new Float32Array(f.samples.buffer)}), undefined,
    'same backing bytes are insufficient without exact array identity');
});

test('nonempty unusable tables retry narrowed domains, while structural empty tables hit', async () => {
  const f = fixture(), wide = new Decimal(1), table = await build(f, wide), cache = new BlaTableCache();
  assert.ok(table.entryCount > 0); assert.equal(table.hasUsableMultiStep, false);
  remember(cache, f, table, wide);
  assert.ok(get(cache, f, wide)); assert.equal(get(cache, f, delta), undefined);
  const narrowed = await build(f); assert.equal(narrowed.hasUsableMultiStep, true);
  remember(cache, f, narrowed);
  assert.equal(get(cache, f).table.data, narrowed.data);
  const empty = fixture('.25', 1), emptyTable = await build(empty, wide);
  assert.equal(emptyTable.entryCount, 0); remember(cache, empty, emptyTable, wide);
  assert.ok(get(cache, empty, delta));
});

test('two-table LRU promotes actual hits and skips oversize entries without eviction', async () => {
  const fs = [fixture('.25'), fixture('.26'), fixture('.27')], tables = await Promise.all(fs.map(f => build(f)));
  const cache = new BlaTableCache(2, 1_000_000);
  remember(cache, fs[0], tables[0]); remember(cache, fs[1], tables[1]); get(cache, fs[0]);
  remember(cache, fs[2], tables[2]);
  assert.equal(get(cache, fs[1]), undefined); assert.ok(get(cache, fs[0])); assert.ok(get(cache, fs[2]));
  const small = new BlaTableCache(2, charge(fs[0], tables[0]));
  remember(small, fs[0], tables[0]);
  const large = fixture('.25', 128), largeTable = await build(large); remember(small, large, largeTable);
  assert.equal(get(small, large), undefined); assert.ok(get(small, fs[0]));
});

test('byte cap charges orbit storage and both metadata arrays, including shared-orbit variants', async () => {
  const f = fixture(), table = await build(f), amount = charge(f, table);
  const tooSmall = new BlaTableCache(2, amount - 1); remember(tooSmall, f, table);
  assert.equal(get(tooSmall, f), undefined);
  const cache = new BlaTableCache(2, amount); remember(cache, f, table);
  const broad = delta.times(2), second = await build(f, broad); remember(cache, f, second, broad);
  assert.equal(get(cache, f, delta).table.data, second.data,
    'second radius displaces first under conservative per-entry storage charge');
  assert.equal(cache.tables.length, 1); assert.equal(cache.bytes, amount);
  cache.clear(); assert.equal(get(cache, f, broad), undefined); assert.equal(cache.bytes, 0);
});

test('exact key replacement does not leak accounting and clear releases completed tables', async () => {
  const f = fixture(), cache = new BlaTableCache(), a = await build(f), b = await build(f);
  remember(cache, f, a); remember(cache, f, b);
  assert.equal(cache.tables.length, 1); assert.equal(cache.bytes, charge(f, b));
  assert.equal(get(cache, f).table.data, b.data);
  cache.clear(); assert.equal(get(cache, f), undefined); assert.equal(cache.tables.length, 0);
  const disabled = new BlaTableCache(0, 1_000_000); remember(disabled, f, a); assert.equal(get(disabled, f), undefined);
});

test('invalid bounds, reference views and payload ownership fail closed', async () => {
  const f = fixture(), table = await build(f), cache = new BlaTableCache();
  for (const d of [new Decimal(-1), new Decimal(NaN), new Decimal(Infinity)]) {
    assert.equal(get(cache, f, d), undefined); assert.throws(() => remember(cache, f, table, d), /incompatible/);
  }
  for (const e of [NaN, Infinity]) assert.throws(() => remember(cache, f, table, delta, e), /incompatible/);
  const orbitBacking = new Float32Array(f.samples.length + 2);
  const narrowOrbit = {...f, samples:orbitBacking.subarray(1, 1 + f.samples.length)};
  assert.throws(() => remember(cache, narrowOrbit, table), /incompatible/);
  const tableBacking = new Float32Array(table.data.length + 2);
  assert.throws(() => remember(cache, f, {...table, data:tableBacking.subarray(1, table.data.length + 1)}), /incompatible/);
  const shared = new Float32Array(new SharedArrayBuffer(table.data.byteLength));
  assert.throws(() => remember(cache, f, {...table, data:shared}), /incompatible/);
  assert.throws(() => new BlaTableCache(-1, 128), /limits/);
  assert.throws(() => new BlaTableCache(2, Infinity), /limits/);
});

test('malformed or incomplete entry metadata cannot be cached', async () => {
  const f = fixture(), table = await build(f), cache = new BlaTableCache();
  for (const patch of [{levels:table.levels - 1}, {entryCount:table.entryCount - 1},
    {levelOffsets:[1, ...table.levelOffsets.slice(1)]},
    {levelCounts:[1, ...table.levelCounts.slice(1)]}, {data:new Float32Array(ENTRY_FLOATS)},
    {hasUsableMultiStep:false}, {levelCounts:table.levelCounts.slice(1)}]) {
    assert.throws(() => remember(cache, f, {...table, ...patch}), /incompatible|incomplete|inconsistent/);
  }
  const invalid = new Float32Array(table.data); invalid[10] = NaN;
  assert.throws(() => remember(cache, f, {...table, data:invalid}), /invalid BLA radius/);
});

test('cancelled actual construction exposes no completed payload to commit', async () => {
  const f = fixture(), cache = new BlaTableCache(), table = await build(f); remember(cache, f, table);
  const next = fixture('.25', 128), cancelled = new Error('cancelled BLA preparation');
  let committed = false;
  await assert.rejects((async () => {
    const complete = await build(next, delta, epsilon, async () => { throw cancelled; });
    remember(cache, next, complete); committed = true;
  })(), error => error === cancelled);
  assert.equal(committed, false); assert.equal(get(cache, next), undefined);
  assert.equal(get(cache, f).table.data, table.data);
});

test('real Julia layout and structural empty lengths retain exact identities', async () => {
  const julia = fixture('.1', 16, 'julia'), cache = new BlaTableCache();
  const table = await build(julia); assert.equal(julia.words, 20); remember(cache, julia, table);
  assert.deepEqual(bytes(get(cache, julia).table), bytes(table));
  for (const length of [0, 1, 2, 3]) {
    const f = {samples:new Float32Array(length * 10), length, words:10};
    const empty = await build(f, new Decimal(0)); remember(cache, f, empty, new Decimal(0));
    assert.equal(get(cache, f, new Decimal(0)).table.entryCount, 0);
  }
});
