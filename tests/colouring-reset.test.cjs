// Exercise the production editor's reset/undo handlers. Mock browser widgets,
// retain the actual colour validation and editor history.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const plain = value => JSON.parse(JSON.stringify(value));

function editor(initial, callback) {
  const elements = new Map();
  const element = () => ({
    children: [], style: {}, attributes: {}, hidden: true, value: '',
    classList: { contains: () => false },
    add(option) { this.children.push(option); },
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {}, focus() {}, contains: () => false,
    querySelector: () => ({ addEventListener() {} }),
  });
  const el = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const document = { getElementById: el, createElement: element, activeElement: null, addEventListener() {} };
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
      exports: module.exports, module, document,
      window: { addEventListener() {} },
      Option: function(text, value) { this.text = text; this.value = value; },
      require: name => name === './colour-picker'
        ? { setupColourPicker: () => ({ sync() {} }) }
        : load(path.resolve(path.dirname(file), name)),
    }, { filename: file });
    return module.exports;
  }
  const settings = load('src/logic/colorSettings.ts');
  let current = settings.validateColors(initial(settings.DEFAULT_COLORS));
  const original = plain(current), events = [];
  load('src/palette-editor.ts').setupPaletteEditor(() => current, next => {
    events.push('change'); current = next;
  }, callback ? () => { events.push('reset'); callback(); } : undefined);
  return { el, original, events, settings, current: () => plain(current) };
}

test('reset restores the complete colouring, closes popovers, and is undoable', () => {
  let callbacks = 0;
  const ui = editor(defaults => ({ ...defaults, mode: 1, formula: 2, effect: 6,
    capped: 9, highlightColour: '#fce3ff', oversampling: true, supersample: 3,
    stops: ['#123456', '#abcdef'], positions: [.2, .8], locks: [true, true],
    hueRotation: 120, cycle: 557, offset: .387,
  }), () => callbacks++);
  ui.el('stop-colour-popover').hidden = false;
  ui.el('highlight-colour-popover').hidden = false;
  ui.el('reset-colouring').onclick();
  assert.deepEqual(ui.events, ['reset', 'change']);
  assert.equal(callbacks, 1);
  assert.deepEqual(ui.current(), plain(ui.settings.validateColors(ui.settings.DEFAULT_COLORS)));
  assert.equal(ui.el('selected-stop-label').textContent, 'Stop 1');
  assert.equal(ui.el('stop-colour-popover').hidden, true);
  assert.equal(ui.el('highlight-colour-popover').hidden, true);
  assert.equal(ui.el('highlight-colour-toggle').attributes['aria-expanded'], 'false');
  assert.equal(ui.el('palette-undo').disabled, false);
  ui.el('palette-undo').onclick();
  assert.deepEqual(ui.current(), ui.original);
  assert.equal(callbacks, 1);
  assert.equal(ui.el('palette-redo').disabled, false);
  ui.el('palette-redo').onclick();
  assert.deepEqual(ui.current(), plain(ui.settings.validateColors(ui.settings.DEFAULT_COLORS)));
  assert.equal(callbacks, 1);
});

test('reset remains usable without a rotation callback and preserves factory colours', () => {
  const ui = editor(defaults => ({ ...defaults, effect: 6 }));
  const factory = plain(ui.settings.DEFAULT_COLORS);
  ui.el('reset-colouring').onclick();
  ui.el('palette-reverse').onclick();
  assert.deepEqual(plain(ui.settings.DEFAULT_COLORS), factory);
  ui.el('palette-undo').onclick();
  assert.deepEqual(ui.current(), plain(ui.settings.validateColors(ui.settings.DEFAULT_COLORS)));
});

test('main reset callback stops colour motion while retaining camera and iteration settings', () => {
  const file = path.join(root, 'src/main.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let callback;
  function find(node) {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'setupPaletteEditor') callback = node.arguments[2];
    ts.forEachChild(node, find);
  }
  find(sf); assert.ok(callback, 'Main must supply the rotation reset callback');
  const camera = { x: '-.75', y: '.1', span: '1e-14', angle: 30 };
  const view = { family: 'mandelbrot', iterations: 12561 };
  const settings = { camera, view, baseIterations: 9000, dynamicEnabled: true,
    rotatePalette: true, rotateLight: true, paletteRotationElapsed: 200,
    lightRotationElapsed: 300, colourRotationEditing: new Set(['color-offset', 'light-angle']),
    syncColourMotion: () => { settings.syncs++; }, syncs: 0 };
  vm.createContext(settings);
  vm.runInContext(ts.transpileModule(`globalThis.resetMotion=${callback.getText(sf)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, settings, { filename: file });
  const ui = editor(defaults => ({ ...defaults, effect: 6 }), () => settings.resetMotion());
  ui.el('reset-colouring').onclick();
  assert.equal(settings.rotatePalette, false); assert.equal(settings.rotateLight, false);
  assert.equal(settings.paletteRotationElapsed, 0); assert.equal(settings.lightRotationElapsed, 0);
  assert.equal(settings.colourRotationEditing.size, 0); assert.equal(settings.syncs, 1);
  assert.equal(settings.camera, camera); assert.equal(settings.view, view);
  assert.deepEqual(camera, { x: '-.75', y: '.1', span: '1e-14', angle: 30 });
  assert.deepEqual(view, { family: 'mandelbrot', iterations: 12561 });
  assert.equal(settings.baseIterations, 9000); assert.equal(settings.dynamicEnabled, true);
});
