// Exercise the owning production change handler and actual Julia return function.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const mainFile = path.join(root, 'src/main.ts');
const sf = ts.createSourceFile(mainFile, fs.readFileSync(mainFile, 'utf8'), ts.ScriptTarget.Latest, true);
let familyChange, juliaSwitch;
function find(node) {
  if (ts.isBinaryExpression(node) && node.left.getText(sf) === "el<HTMLSelectElement>('family').onchange") familyChange = node.right;
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'switchJuliaView') juliaSwitch = node;
  ts.forEachChild(node, find);
}
find(sf);
assert.ok(familyChange && juliaSwitch, 'Production family and Julia handlers must exist');
const callbacks = ts.transpileModule(`${juliaSwitch.getText(sf)}
globalThis.familyChange=${familyChange.getText(sf)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const selects = ts.transpileModule(fs.readFileSync(path.join(root, 'src/select-controls.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(family = 'julia') {
  const events = [], options = ['mandelbrot', 'julia'].map(value => ({ value, matches: () => false, hidden: false }));
  const document = { activeElement: null, querySelectorAll: () => [select] };
  let keydown;
  const select = {
    options, selectedIndex: family === 'julia' ? 1 : 0, multiple: false, size: 0,
    get value() { return options[this.selectedIndex]?.value ?? ''; },
    set value(value) { this.selectedIndex = options.findIndex(option => option.value === value); },
    contains: target => options.includes(target), matches: () => false,
    focus(settings) { events.push({ focus: 'select', settings }); document.activeElement = select; },
    addEventListener(type, listener) { assert.equal(type, 'keydown'); keydown = listener; },
    dispatchEvent(event) {
      events.push({ event: event.type });
      if (event.type === 'change') context.familyChange({ target: select, currentTarget: select });
    },
  };
  const canvas = { focus() { events.push({ focus: 'canvas' }); document.activeElement = canvas; } };
  const previous = { family: 'mandelbrot', x: '-0.749', y: '.01', span: '1e-15', iterations: 16000, angle: 0 };
  const context = {
    document, canvas, Event, exports: {},
    CSS: { supports: () => true },
    HOME: { family: 'mandelbrot', x: '-.5', y: '0', span: '3.2' },
    view: family === 'julia' ? { ...previous, family: 'julia', x: '0', jx: '-.7', jy: '.1' } : { ...previous },
    camera: { angle: 0 }, colors: {}, selectedJulia: { x: '-.7', y: '.1' },
    juliaReturn: family === 'julia' ? { ...previous } : null,
    snapshot: () => ({ ...context.view }), validateView: value => value, validateColors: value => value,
    load(next) { events.push({ load: next.family }); context.view = { ...next }; select.value = next.family; },
    message: text => events.push({ message: text }),
  };
  vm.createContext(context); vm.runInContext(callbacks, context, { filename: mainFile });
  vm.runInContext(selects, context); context.exports.setupSelectControls();
  document.activeElement = select;
  return { context, select, canvas, document, events, previous,
    change(value) { select.value = value; context.familyChange({ target: select, currentTarget: select }); },
    arrow(key) {
      assert.equal(document.activeElement, select, 'Consecutive arrows must remain targeted at the select');
      const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      keydown(event); return event;
    },
  };
}

test('mouse selection returning from Julia restores the select focus after the actual canvas-focus path', () => {
  const ui = fixture();
  ui.change('mandelbrot');
  assert.equal(ui.context.view.x, ui.previous.x);
  assert.equal(ui.context.juliaReturn, null);
  assert.equal(ui.document.activeElement, ui.select);
  assert.deepEqual(ui.events.filter(event => event.focus).map(event => event.focus), ['canvas', 'select']);
  assert.equal(ui.events.at(-1).settings.preventScroll, true);
});

test('consecutive closed family arrows keep focus through Julia entry and return', () => {
  const ui = fixture();
  assert.equal(ui.arrow('ArrowUp').defaultPrevented, true);
  assert.equal(ui.context.view.family, 'mandelbrot');
  assert.equal(ui.arrow('ArrowDown').defaultPrevented, true);
  assert.equal(ui.context.view.family, 'julia');
  assert.equal(ui.arrow('ArrowUp').defaultPrevented, true);
  assert.equal(ui.context.view.family, 'mandelbrot');
  assert.equal(ui.context.view.x, ui.previous.x);
  assert.equal(ui.document.activeElement, ui.select);
});

test('a mouse commit while a native picker option owns focus restores focus to its select', () => {
  const ui = fixture();
  ui.document.activeElement = ui.select.options[0];
  ui.change('mandelbrot');
  assert.equal(ui.document.activeElement, ui.select);
});

test('programmatic family changes and the direct Julia shortcut keep existing canvas focus', () => {
  const ui = fixture(); ui.document.activeElement = ui.canvas;
  ui.change('mandelbrot');
  assert.equal(ui.document.activeElement, ui.canvas);
  assert.equal(ui.events.filter(event => event.focus === 'select').length, 0);
  const shortcut = fixture(); shortcut.document.activeElement = shortcut.canvas;
  vm.runInContext('switchJuliaView()', shortcut.context);
  assert.equal(shortcut.context.view.family, 'mandelbrot');
  assert.equal(shortcut.document.activeElement, shortcut.canvas);
  assert.equal(shortcut.events.filter(event => event.focus === 'select').length, 0);
});
