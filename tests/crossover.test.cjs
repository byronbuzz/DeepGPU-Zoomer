// Exercise the actual private renderer methods without requiring a GPU in Node.
// Extract their local dependencies; mock only GPU submission and unrelated services.
// Run with: node --test tests/crossover.test.cjs
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(root + '/node_modules/typescript');
const Decimal = require(root + '/node_modules/decimal.js');

const rendererPath = root + '/src/render/webgpu-renderer.ts';
const raw = fs.readFileSync(rendererPath, 'utf8');
const sf = ts.createSourceFile(rendererPath, raw, ts.ScriptTarget.Latest, true);
const renderer = sf.statements.find(
    n => ts.isClassDeclaration(n) && n.name.text === 'WebGpuRenderer',
);
const allMethods = new Map(
    renderer.members
        .filter(n => ts.isMethodDeclaration(n) && n.name)
        .map(n => [n.name.text, n]),
);
const mocked = new Set([
    'validateCoordinates',
    'capUpgradeBase',
    'appearanceHoldActive',
    'workRequest',
    'encodeBlit',
    'cancelPendingReference',
]);
const picked = new Map();

function select(name) {
    if (picked.has(name) || mocked.has(name)) return;
    const n = allMethods.get(name);
    if (!n) return;
    picked.set(name, n);

    function walk(n) {
        if (ts.isPropertyAccessExpression(n) &&
            n.expression.kind === ts.SyntaxKind.ThisKeyword) {
            select(n.name.text);
        }
        ts.forEachChild(n, walk);
    }
    walk(n);
}

[
    'sameBlaPolicy',
    'samePresentation',
    'presentationCompatible',
    'stalePresentationCompatible',
    'sameView',
    'reproject',
    'isComplete',
].forEach(select);
const methods = [...picked.values()].map(n => n.getText(sf)).join('\n');
const top = new Map(sf.statements.filter(n => n.name).map(n => [n.name.text, n]));
const topPicked = new Map();

function pickTop(name) {
    const n = top.get(name);
    if (!n || topPicked.has(name) || ts.isClassDeclaration(n) ||
        ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) {
        return;
    }
    topPicked.set(name, n);

    function walk(n) {
        if (ts.isIdentifier(n)) pickTop(n.text);
        ts.forEachChild(n, walk);
    }
    walk(n);
}

for (const n of picked.values()) {
    function walk(n) {
        if (ts.isIdentifier(n)) pickTop(n.text);
        ts.forEachChild(n, walk);
    }
    walk(n);
}
[
    'Method',
    'methodForScale',
    'exportIdentity',
    'approximationEligible',
    'effectiveBlaEpsilon',
    'linearBlaPolicy',
].forEach(pickTop);

const read = p => fs.readFileSync(root + '/' + p, 'utf8');
const text = read('src/tuning.ts') + '\n' +
    read('src/rotation.ts') + '\n' +
    read('src/render/reprojection.ts').replace(/^import .*$/gm, '') + '\n' +
    [...topPicked.values()].map(n => n.getText(sf)).join('\n') +
    '\nclass Probe {\n' + methods + '\n}\nexports.Probe=Probe;';
const js = ts.transpileModule(text, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
    },
}).outputText;
const context = { exports: {}, Decimal, console };
vm.createContext(context);
vm.runInContext(js, context);
const api = context.exports;

function req(upp = '1.5e-15') {
    return {
        centerX: new Decimal('-0.75'),
        centerY: new Decimal('0.1'),
        unitsPerPixel: new Decimal(upp),
        width: 1280,
        height: 720,
        maxIterations: 1000,
        family: 'mandelbrot',
        useApprox: true,
        colors: { mode: 0, supersample: 1 },
        tuning: { ...api.DEFAULT_TUNING },
        interacting: true,
        zoom: 1,
        followView: true,
    };
}

function directFrame() {
    return { ...req('2e-15'), method: 0 };
}

function hdrFrame() {
    return { ...req(), method: 2 };
}

function probe(frame = directFrame()) {
    const p = new api.Probe();
    Object.assign(p, {
        disposed: false,
        deviceLost: false,
        historyValid: true,
        currentImageValid: false,
        lastFrame: frame,
        history: { kind: 'history' },
        target: { kind: 'target' },
        blitPipeline: {},
        partialSerial: 0,
        publicationEpoch: 0,
        appearanceSubmissions: 0,
        canvas: { width: 1280, height: 720 },
        submissions: 0,
    });
    p.validateCoordinates = () => {};
    p.capUpgradeBase = () => null;
    p.appearanceHoldActive = () => false;
    p.workRequest = r => r;
    p.ctx = {
        device: {
            createCommandEncoder: () => ({ finish: () => ({}) }),
            queue: { submit: () => p.submissions++ },
        },
    };
    p.encodeBlit = () => {};
    return p;
}

test('Direct history reprojects before first Hdr output is available', () => {
    const p = probe();
    assert.equal(p.samePresentation(p.lastFrame, req()), true);
    assert.equal(p.reproject(req()), true);
    assert.equal(p.submissions, 1);
});

test('Hdr work before visible Direct crossover remains presentable', () => {
    const p = probe(hdrFrame()), r = req('2e-15');
    assert.equal(p.samePresentation(p.lastFrame, r), true);
    assert.equal(p.reproject(r), true);
});

test('Hdr incoming remains presentable over Direct history', () => {
    const p = probe();
    p.incomingFrame = hdrFrame();
    assert.equal(p.reproject(req()), true);
});

test('Return to Direct remains presentable', () => {
    const p = probe();
    assert.equal(p.reproject(req('2e-15')), true);
});

test('Manual BLA tolerance changes rejected for Hdr presentation', () => {
    const p = probe(hdrFrame()), r = req();
    r.tuning.blaPrecisionLog2 = -24;
    assert.equal(p.samePresentation(p.lastFrame, r), false);
});

test('Manual BLA tolerance changes rejected across crossover', () => {
    const p = probe(), r = req();
    r.tuning.blaPrecisionLog2 = -24;
    assert.equal(p.samePresentation(p.lastFrame, r), false);
});

for (const [label, change] of [
    ['family', r => r.family = 'julia'],
    ['colours', r => r.colors.offset = .5],
    ['iteration cap', r => r.maxIterations = 1100],
    ['useApprox', r => r.useApprox = false],
    ['export domain', r => r.exportDomain = { width: 1280, height: 720, x: 0, y: 0 }],
]) {
    test(label + ' changes rejected for presentation', () => {
        const p = probe(hdrFrame()), r = req();
        change(r);
        assert.equal(p.samePresentation(p.lastFrame, r), false);
    });
}

test('Julia constant changes rejected for presentation', () => {
    const f = {
        ...hdrFrame(),
        family: 'julia',
        juliaX: new Decimal('.1'),
        juliaY: new Decimal('.2'),
    };
    const r = {
        ...req(),
        family: 'julia',
        juliaX: new Decimal('.2'),
        juliaY: new Decimal('.2'),
    };
    assert.equal(probe(f).samePresentation(f, r), false);
});

test('Numerical BLA policy stays strict across Direct to Hdr', () => {
    const p = probe();
    assert.equal(p.sameBlaPolicy(p.lastFrame, req()), false);
});

test('Numerical BLA policy stays strict across Hdr to Direct', () => {
    const p = probe(hdrFrame());
    assert.equal(p.sameBlaPolicy(p.lastFrame, req('2e-15')), false);
});

test('Completion rejects wrong Direct method at exact Hdr geometry', () => {
    const p = probe();
    p.completedFrame = { ...req(), method: 0 };
    p.fieldComplete = true;
    p.currentImageValid = true;
    assert.equal(p.isComplete(req()), false);
});

test('Completion rejects wrong Hdr method at exact Direct geometry', () => {
    const p = probe();
    const r = req('2e-15');
    p.completedFrame = { ...r, method: 2 };
    p.fieldComplete = true;
    p.currentImageValid = true;
    assert.equal(p.isComplete(r), false);
});

test('Completion accepts matching exact Hdr method', () => {
    const p = probe();
    p.completedFrame = hdrFrame();
    p.fieldComplete = true;
    p.currentImageValid = true;
    assert.equal(p.isComplete(req()), true);
});

test('Direct proxy preserves manual epsilon provenance', () => {
    const p = probe(), r = req('2e-15');
    p.lastFrame.proxy = true;
    r.tuning.blaPrecisionLog2 = -24;
    assert.equal(p.samePresentation(p.lastFrame, r), false);
});

test('Stale appearance fallback permits Direct to Hdr route transition', () => {
    const p = probe();
    assert.equal(p.stalePresentationCompatible(p.lastFrame, req()), true);
});

test('Stale appearance fallback permits Hdr to Direct route transition', () => {
    const p = probe(hdrFrame());
    assert.equal(p.stalePresentationCompatible(p.lastFrame, req('2e-15')), true);
});

test('Stale appearance fallback rejects configured epsilon change', () => {
    const p = probe(), r = req();
    r.tuning.blaPrecisionLog2 = -24;
    assert.equal(p.stalePresentationCompatible(p.lastFrame, r), false);
});

test('Completion method guard remains strict without BLA policy discrimination, Direct field at Hdr scale', () => {
    const p = probe(), r = req();
    r.useApprox = false;
    p.completedFrame = { ...r, method: 0 };
    p.fieldComplete = true;
    p.currentImageValid = true;
    assert.equal(p.sameBlaPolicy(p.completedFrame, r), true);
    assert.equal(p.isComplete(r), false);
});

test('Completion method guard remains strict without BLA policy discrimination, Hdr field at Direct scale', () => {
    const p = probe(), r = req('2e-15');
    r.useApprox = false;
    p.completedFrame = { ...r, method: 2 };
    p.fieldComplete = true;
    p.currentImageValid = true;
    assert.equal(p.sameBlaPolicy(p.completedFrame, r), true);
    assert.equal(p.isComplete(r), false);
});
