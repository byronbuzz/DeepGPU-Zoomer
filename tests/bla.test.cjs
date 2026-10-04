// Golden tables from accepted main 8d0c992: hash packed bytes plus all metadata.
// Load actual TypeScript modules; do not duplicate the baseline BLA builder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(root + '/node_modules/typescript');
const cache = new Map();
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename);
  const exports = {};
  cache.set(filename, exports);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('exports', 'require', js)(exports, id => id.startsWith('.')
    ? load(path.resolve(path.dirname(filename), id) + '.ts')
    : require(root + '/node_modules/' + id));
  return exports;
}
const { generatePackedReference } = load('src/render/reference-orbit.ts');
const { buildBlaAsync } = load('src/render/bla.ts');
const Decimal = require(root + '/node_modules/decimal.js');
function orbitFor(fixture) {
  const [length, family] = fixture;
  if (length < 3) return { orbit: new Float32Array(length * 10), length, sampleWords: 10 };
  const escaped = family === 'escaping';
  const packed = generatePackedReference({
    family: family === 'julia' ? 'julia' : 'mandelbrot',
    centerX: escaped ? '-0.743643887037151' : family === 'julia' ? '.1' : '.25',
    centerY: escaped ? '0.13182590420533' : family === 'julia' ? '.2' : '0',
    juliaX: '-.1', juliaY: '.2', limbs: 8, maxIterations: length - 1,
  });
  return { orbit: new Float32Array(packed.buffer), length: packed.length, sampleWords: packed.sampleWords };
}
function fingerprint(table) {
  const metadata = {
    levelOffsets: table.levelOffsets, levelCounts: table.levelCounts,
    levels: table.levels, entryCount: table.entryCount, hasUsableMultiStep: table.hasUsableMultiStep,
  };
  return crypto.createHash('sha256').update(Buffer.from(table.data.buffer,
    table.data.byteOffset, table.data.byteLength)).update(JSON.stringify(metadata)).digest('hex');
}
const fixtures = [
  [0,"mandelbrot",-21,"0","f4b8cc8a3051e69fbd80f3bc41bab14650110f3a04d6795097ba5ed7cc43f33b",0],
  [1,"mandelbrot",-21,"0","f4b8cc8a3051e69fbd80f3bc41bab14650110f3a04d6795097ba5ed7cc43f33b",0],
  [2,"mandelbrot",-21,"0","f4b8cc8a3051e69fbd80f3bc41bab14650110f3a04d6795097ba5ed7cc43f33b",0],
  [3,"mandelbrot",-24,"0","f4b8cc8a3051e69fbd80f3bc41bab14650110f3a04d6795097ba5ed7cc43f33b",1],
  [5,"mandelbrot",-14,"1e-12","8e16b54862d4073ab59cfe17447ca191b06fa168ec51ae7de94f0eae3a93a2c5",3],
  [6,"mandelbrot",-21,"0","3a41350908ee2c1951110c5eda838b6dcf2d1d2275226b4ad8df7468ac14c40c",5],
  [66,"julia",-24,"1e-12","910811d343158cd4039c05407a991d511c3557d6b112306893229a9ba6098b75",13],
  [17,"mandelbrot",-21,"1e-100000","51b9c6b90204351fdde790dd7a92fa0ade6288f498af7c4e0c1c682ba2b57d04",7],
  [65,"mandelbrot",-24,"1e-12","13b9ccb375cb4346142089b40773149e5a4fff694a4d9f008ccc766798b00cd6",11],
  [4095,"mandelbrot",-21,"0","7df37d151a6c61a94c9b174d6be2dd17801be4af5fac6f00cbeea58da60b42ac",23],
  [4096,"mandelbrot",-14,"1e-12","d3b404398aaca5be8a61bf07211f8ce94c92eb71f2938941ff2c4f0fe4a2c090",23],
  [4097,"mandelbrot",-24,"1e-100000","b2613929786235269fa1098ddcae6748e93f4396b83e947a7e589057570a9d0a",23],
  [17,"julia",-21,"0","b1da2e05e14cea278cd2df0502f3adf65fc6bd0cf6e16270a2dd135fdb7314d9",7],
  [4098,"mandelbrot",-21,"1e-12","2af62a838f028d6dab49837b250158be6dd441ab07164064323902f1987711e2",25],
  [4099,"mandelbrot",-21,"1e-100000","2af62a838f028d6dab49837b250158be6dd441ab07164064323902f1987711e2",26],
  [4097,"julia",-14,"1e-100000","f0d4e97f04a8ec106ee9a481bd9b0ccab8f8f2748c7419e1b02a2b36abd4bb25",23],
  [8193,"escaping",-21,"1e-12","e5825e5a89bf0b41659b13f87023efe0a2f6e428cb937c3fc360331e01007101",23],
];

for (const fixture of fixtures) {
  const [requestedLength, family, epsilonLog2, delta, expectedHash, expectedCheckpoints] = fixture;
  test(`BLA golden ${family}, length ${requestedLength}, epsilon ${epsilonLog2}, delta ${delta}`, async () => {
    const input = orbitFor(fixture);
    const bytes = Buffer.from(input.orbit.buffer);
    const before = crypto.createHash('sha256').update(bytes).digest('hex');
    let checkpoints = 0;
    const table = await buildBlaAsync(input.orbit, input.length, new Decimal(delta),
      async () => { checkpoints++; }, { sampleWords: input.sampleWords, epsilonLog2 });
    assert.equal(fingerprint(table), expectedHash);
    assert.equal(checkpoints, expectedCheckpoints);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), before);
  });
}

test('BLA cancellation propagates at a checkpoint and preserves reference input', async () => {
  const input = orbitFor([4097, 'julia']);
  const bytes = Buffer.from(input.orbit.buffer);
  const before = crypto.createHash('sha256').update(bytes).digest('hex');
  const cancellation = new Error('BLA cancelled');
  let checkpoints = 0;
  await assert.rejects(buildBlaAsync(input.orbit, input.length, new Decimal('1e-12'), async () => {
    if (++checkpoints === 4) throw cancellation;
  }, { sampleWords: input.sampleWords, epsilonLog2: -21 }), error => error === cancellation);
  assert.equal(checkpoints, 4);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), before);
});
