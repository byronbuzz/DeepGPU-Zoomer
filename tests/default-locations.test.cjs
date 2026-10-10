const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const plain = value => JSON.parse(JSON.stringify(value));
const collectionKey = 'gpu-zoomer-locations';
const originalSeed = 'gpu-zoomer-default-locations-2026-10-03-v1';
const deepSeed = 'gpu-zoomer-default-locations-2026-10-10-v1';
const deepNames = ['Inferno 10^800', 'Inferno 10^900', 'Eon 10^1000'];

// Run the actual startup and picker with inert browser elements; no GPU needed.
function harness(initial = [], seeded = false) {
  const storage = new Map([[collectionKey, typeof initial === 'string' ? initial : JSON.stringify(initial)]]);
  if (seeded) storage.set(originalSeed, '1');
  let failKey;
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) { if (key === failKey) throw Error('Storage unavailable'); storage.set(key, value); },
  };
  const elements = new Map();
  const element = () => ({ children: [], style: {}, hidden: true, value: '',
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {},
    replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
    querySelectorAll() { return this.children; }, scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 100, bottom: 130, width: 250, height: 30, left: 10 }),
    dataset: {},
  });
  const el = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const document = { getElementById: el, createElement: element, body: element(), addEventListener() {} };
  const modules = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (!path.extname(file)) file += '.ts';
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, { exports: module.exports, module, document, localStorage,
      window: { addEventListener() {} }, innerHeight: 800,
      require: name => name.endsWith('?raw')
        ? { default: fs.readFileSync(path.resolve(path.dirname(file), name.slice(0, -4)), 'utf8') }
        : name.startsWith('.') ? load(path.resolve(path.dirname(file), name))
        : require(path.join(root, 'node_modules', name)),
    }, { filename: file });
    return module.exports;
  }
  const api = load('src/locations.ts');
  const defaults = plain(api.parseLocationBackup(JSON.parse(fs.readFileSync(path.join(root, 'src/default-locations.json'), 'utf8'))));
  const navigations = [];
  return { storage, defaults, el, navigations,
    fail(key) { failKey = key; },
    start: () => api.setupLocations(() => defaults[0].view, view => navigations.push(plain(view)), () => {}),
    saved: () => JSON.parse(storage.get(collectionKey)),
  };
}

test('all 15 presets validate, including distinct Inferno and Eon deep views', () => {
  const h = harness();
  assert.equal(h.defaults.length, 15);
  assert.equal(new Set(h.defaults.map(item => item.name)).size, 15);
  const deep = deepNames.map(name => h.defaults.find(item => item.name === name));
  assert.deepEqual(deep.map(item => Number(item.view.span.split('e-')[1])), [800, 900, 1000]);
  assert.deepEqual(deep.map(item => item.view.iterations), [183210, 687676, 1185709]);
  assert.ok(deep.every(item => item.view.x.length > 800 && item.view.appearance.stops.length >= 2));
});

test('fresh startup seeds every preset and the picker opens the exact selected view', () => {
  const h = harness(); h.start();
  assert.deepEqual(h.saved(), h.defaults);
  assert.equal(h.storage.get(originalSeed), '1');
  assert.equal(h.storage.get(deepSeed), '1');
  h.el('location-entry').onfocus();
  h.el('location-entry').onkeydown({ key: 'ArrowDown', preventDefault() {} });
  h.el('location-entry').onkeydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(h.navigations, [h.defaults.at(-1).view]);
});

test('existing users receive only the three additions and retain edited name conflicts', () => {
  const defaults = harness().defaults;
  const edited = { name: deepNames[0], view: defaults[0].view };
  const custom = { name: 'My own location', view: defaults[1].view };
  const h = harness([edited, custom], true); h.start();
  assert.deepEqual(h.saved().slice(0, 2), [edited, custom]);
  assert.equal(h.saved().length, 5);
  assert.deepEqual(h.saved().slice(2).map(item => item.name), ['Inferno 10^800 (2)', deepNames[1], deepNames[2]]);
  assert.deepEqual(h.saved()[2].view, defaults.find(item => item.name === deepNames[0]).view);
  // Previously deleted older presets stay deleted.
  assert.ok(!h.saved().some(item => item.name === defaults[0].name));
});

test('completed migration is idempotent and respects later deletion of a new preset', () => {
  const h = harness([], true); h.start();
  h.storage.set(collectionKey, JSON.stringify(h.saved().filter(item => item.name !== deepNames[0])));
  const before = h.storage.get(collectionKey); h.start();
  assert.equal(h.storage.get(collectionKey), before);
});

test('invalid existing storage is preserved without attempting preset migration', () => {
  const h = harness('{broken', true);
  assert.equal(h.start().storageError, true);
  assert.equal(h.storage.get(collectionKey), '{broken');
  assert.equal(h.storage.has(deepSeed), false);
});

test('interrupted migration retries without duplicating already merged presets', () => {
  const h = harness([], true); h.fail(deepSeed);
  assert.equal(h.start().recoveryError, true);
  assert.equal(h.saved().length, 3);
  h.fail(undefined); assert.equal(h.start().recoveryError, false);
  assert.equal(h.saved().length, 3);
  assert.equal(h.storage.get(deepSeed), '1');
});
