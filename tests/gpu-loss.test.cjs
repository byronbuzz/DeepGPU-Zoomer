// Run the actual main device-loss and download callbacks, without a GPU.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const file = path.join(root, 'src/main.ts');
const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
let lossCallback, downloadCallback;
function find(node) {
  if (ts.isCallExpression(node) && node.expression.getText(sf) === 'ctx.lost.then') lossCallback = node.arguments[0];
  if (ts.isBinaryExpression(node) && node.left.getText(sf) === "el('gpu-error-details').onclick") downloadCallback = node.right;
  ts.forEachChild(node, find);
}
find(sf);
assert.ok(lossCallback && downloadCallback, 'Production device-loss and download handlers must exist');
const callbacks = ts.transpileModule(`globalThis.handleLoss=${lossCallback.getText(sf)};
globalThis.downloadDetails=${downloadCallback.getText(sf)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(started = true) {
  const events = [], button = { hidden: true }, links = [], timers = [], messages = [];
  const view = { family: 'mandelbrot', x: '-0.75', y: '.1', span: '1e-14', iterations: 12561 };
  const work = { route: 'continued', method: 'perturbation', family: 'mandelbrot',
    maxIterations: 12561, width: 1920, height: 16, stride: 2, sampleGrid: 1,
    operations: 32768, submittedAt: '2026-10-05T00:00:00.000Z' };
  const capabilities = { adapterInfo: 'test GPU', hasTimestampQuery: false };
  const context = {
    gpuLost: false, gpuErrorDetails: undefined, generation: 7, error: '',
    ctx: { capabilities, lastNumericalWork: started ? work : undefined },
    snapshot: () => { events.push('snapshot'); return JSON.parse(JSON.stringify(view)); },
    engine: started ? { abort() {
      events.push('abort'); view.iterations = 1; work.operations = 0;
    } } : undefined,
    cancelPreviewWork: () => events.push('cancel-preview'),
    stop: () => events.push('stop'), setPreview: enabled => events.push(`preview:${enabled}`),
    message: (text, transient) => messages.push({ text, transient }),
    el: id => { assert.equal(id, 'gpu-error-details'); return button; },
    document: {
      querySelector: selector => {
        assert.equal(selector, 'script[type="module"][src]');
        return { src: 'http://127.0.0.1:5508/assets/index-test.js' };
      },
      createElement: tag => {
        assert.equal(tag, 'a');
        const link = { click() { events.push('download'); } }; links.push(link); return link;
      },
    },
    navigator: { userAgent: 'test browser' }, Date, Blob,
    URL: { createObjectURL(blob) { context.blob = blob; return 'blob:test'; },
      revokeObjectURL(url) { events.push(`revoke:${url}`); } },
    setTimeout: (callback, ms) => timers.push({ callback, ms }),
  };
  vm.createContext(context); vm.runInContext(callbacks, context, { filename: file });
  return { context, events, button, links, timers, messages, capabilities };
}

test('unexpected loss snapshots diagnostics before abort and stops work with a persistent message', () => {
  const f = fixture();
  f.context.handleLoss({ reason: 'unknown', message: 'driver reset' });
  const report = JSON.parse(f.context.gpuErrorDetails);
  assert.deepEqual(f.events, ['snapshot', 'abort', 'cancel-preview', 'stop', 'preview:false']);
  assert.equal(report.reason, 'unknown'); assert.equal(report.message, 'driver reset');
  assert.equal(report.browser, 'test browser');
  assert.equal(report.build, 'http://127.0.0.1:5508/assets/index-test.js');
  assert.deepEqual(report.capabilities, f.capabilities);
  assert.equal(report.view.iterations, 12561); assert.equal(report.view.span, '1e-14');
  assert.equal(report.lastSubmittedNumericalWork.operations, 32768);
  assert.equal(report.lastSubmittedNumericalWork.maxIterations, 12561);
  assert.match(report.note, /not proof of the cause/);
  assert.match(report.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(f.context.gpuLost, true); assert.equal(f.context.generation, 8);
  assert.equal(f.button.hidden, false);
  assert.deepEqual(f.messages, [{ text: f.context.error, transient: false }]);
});

test('loss during startup is recorded without an assigned renderer or numerical submission', () => {
  const f = fixture(false);
  assert.doesNotThrow(() => f.context.handleLoss({ reason: 'unknown', message: 'early failure' }));
  assert.equal(JSON.parse(f.context.gpuErrorDetails).lastSubmittedNumericalWork, null);
  assert.deepEqual(f.events, ['snapshot', 'cancel-preview', 'stop', 'preview:false']);
  assert.equal(f.context.gpuLost, true); assert.equal(f.button.hidden, false);
  assert.equal(f.messages[0].transient, false);
});

test('explicit device destruction does not report an unexpected failure', () => {
  const f = fixture();
  f.context.handleLoss({ reason: 'destroyed', message: '' });
  assert.equal(f.context.gpuLost, false); assert.equal(f.context.gpuErrorDetails, undefined);
  assert.equal(f.context.generation, 7); assert.equal(f.button.hidden, true);
  assert.deepEqual(f.events, []); assert.deepEqual(f.messages, []);
});

test('error-details button downloads the captured report and does nothing before a report exists', async () => {
  const f = fixture();
  f.context.downloadDetails(); assert.equal(f.links.length, 0);
  f.context.handleLoss({ reason: 'unknown', message: 'driver reset' });
  const report = f.context.gpuErrorDetails;
  f.context.downloadDetails();
  assert.equal(f.links.length, 1); assert.equal(f.links[0].href, 'blob:test');
  assert.match(f.links[0].download, /^deepgpu-zoomer-gpu-error-.*\.json$/);
  assert.equal(f.context.blob.type, 'application/json');
  assert.equal(await f.context.blob.text(), report + '\n');
  assert.equal(f.timers.length, 1); f.timers[0].callback();
  assert.equal(f.events.at(-1), 'revoke:blob:test');
});
const messagesource=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='message');
test('later navigation messages cannot hide the reconnect instruction after device loss',()=>{
  const target={textContent:'',classList:{remove(){},add(){}}};
  let scheduled=0;
  const context={gpuLost:true,messageVersion:0,messageDismissTimer:0,messageFadeTimer:0,
    el:()=>target,clearTimeout(){},window:{setTimeout(){scheduled++;return 1;}}};
  vm.runInNewContext(ts.transpileModule(messagesource.getText(sf),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  context.message('Defaults restored.',true);
  assert.match(target.textContent,/GPU connection lost.*reload this page/);
  assert.equal(scheduled,0);
  context.message('');
  assert.match(target.textContent,/Save the error details/);
});
