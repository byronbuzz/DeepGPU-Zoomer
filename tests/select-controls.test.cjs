const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));

function controls({ selectedIndex = 1, supported = true, disabled = false,
  open = false, multiple = false, size = 0, unavailable = [], hidden = [] } = {}) {
  let listener;
  const events = [];
  const select = {
    selectedIndex, multiple, size,
    options: Array.from({ length: 4 }, (_, index) => ({
      matches: selector => { assert.equal(selector, ':disabled'); return unavailable.includes(index); },
      hidden: hidden.includes(index),
    })),
    matches: selector => { assert.equal(selector, ':disabled, :open'); return disabled || open; },
    addEventListener: (type, callback) => { assert.equal(type, 'keydown'); listener = callback; },
    dispatchEvent: event => events.push({ type: event.type, bubbles: event.bubbles, index: select.selectedIndex }),
  };
  const document = {
    activeElement: select,
    querySelectorAll: selector => { assert.equal(selector, 'select'); return [select]; },
  };
  const exports = {};
  const source = fs.readFileSync(path.join(root, 'src/select-controls.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, document, Event,
    CSS: { supports: selector => { assert.equal(selector, 'selector(select:open)'); return supported; } },
  });
  exports.setupSelectControls();
  return {
    select, events, document,
    key(key, properties = {}) {
      const event = { key, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...properties };
      listener?.(event);
      return event;
    },
    attached: () => !!listener,
  };
}

test('closed arrows select the adjacent option and preserve focus and event order', () => {
  const ui = controls();
  assert.equal(ui.key('ArrowDown').defaultPrevented, true);
  assert.equal(ui.select.selectedIndex, 2);
  assert.deepEqual(ui.events, [
    { type: 'input', bubbles: true, index: 2 }, { type: 'change', bubbles: true, index: 2 },
  ]);
  assert.equal(ui.document.activeElement, ui.select);
  assert.equal(ui.key('ArrowUp').defaultPrevented, true);
  assert.equal(ui.select.selectedIndex, 1);
});

test('held arrows repeat changes without wrapping or reopening at boundaries', () => {
  const ui = controls({ selectedIndex: 2 });
  ui.key('ArrowDown', { repeat: true });
  assert.equal(ui.select.selectedIndex, 3);
  assert.equal(ui.key('ArrowDown', { repeat: true }).defaultPrevented, true);
  assert.equal(ui.select.selectedIndex, 3);
  assert.equal(ui.events.length, 2);
  const first = controls({ selectedIndex: 0 });
  assert.equal(first.key('ArrowUp').defaultPrevented, true);
  assert.equal(first.select.selectedIndex, 0);
  assert.equal(first.events.length, 0);
});

test('disabled options or optgroup descendants and hidden options are skipped both ways', () => {
  const ui = controls({ selectedIndex: 0, unavailable: [1], hidden: [2] });
  ui.key('ArrowDown'); assert.equal(ui.select.selectedIndex, 3);
  ui.key('ArrowUp'); assert.equal(ui.select.selectedIndex, 0);
});

test('open picker, disabled select or fieldset, and listboxes retain native navigation', () => {
  for (const state of [{ open: true }, { disabled: true }, { multiple: true }, { size: 3 }]) {
    const ui = controls(state);
    assert.equal(ui.key('ArrowDown').defaultPrevented, false);
    assert.equal(ui.select.selectedIndex, 1);
    assert.equal(ui.events.length, 0);
  }
});

test('opening shortcuts, unrelated keys, composing keys, and consumed events are preserved', () => {
  for (const properties of [{ altKey: true }, { ctrlKey: true }, { metaKey: true },
    { shiftKey: true }, { isComposing: true }]) {
    const ui = controls();
    assert.equal(ui.key('ArrowDown', properties).defaultPrevented, false);
    assert.equal(ui.select.selectedIndex, 1);
    assert.equal(ui.events.length, 0);
  }
  const ui = controls();
  for (const key of ['Enter', ' ', 'Escape', 'Tab', 'Home', 'End', 'a']) ui.key(key);
  ui.key('ArrowDown', { defaultPrevented: true });
  assert.equal(ui.select.selectedIndex, 1);
  assert.equal(ui.events.length, 0);
});

test('unsupported open-state selectors leave native controls untouched', () => {
  const ui = controls({ supported: false });
  assert.equal(ui.attached(), false);
  assert.equal(ui.key('ArrowDown').defaultPrevented, false);
  assert.equal(ui.events.length, 0);
});
