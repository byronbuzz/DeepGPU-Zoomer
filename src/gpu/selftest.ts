/**
 * Runs the WGSL arithmetic against the BigInt oracle on a real device.
 *
 * The unit tests in tests/ cover the CPU oracle; this covers the shader, which
 * nothing else can. Invoked by the physical-browser regression suite.
 */

import {
  acquireGpu,
  compileShader,
  readBuffer,
  storageBuffer,
  type GpuContext,
} from "./device";
import bigfixedSource from "./shaders/bigfixed.wgsl?raw";
import arithtestBindings from "./shaders/arithtest-bindings.wgsl?raw";
import arithtestSource from "./shaders/arithtest.wgsl?raw";
import orbitBindings from "./shaders/orbit-bindings.wgsl?raw";
import orbitSource from "./shaders/orbit.wgsl?raw";
import quadSource from "../arithmetic/quad.wgsl?raw";
import Decimal from "decimal.js";
import { fixedToQuad, splitQuad } from "../arithmetic/quad";
import {
  fromLimbs,
  parseFixed,
  toLimbs,
  wrapSigned,
  fixedToNumber,
  fromHdr,
  scaleDecimal,
} from "../arithmetic/types";
import {
  addFixed,
  mulFixed,
  referenceOrbit,
  orbitStep,
  subFixed,
} from "../arithmetic/cpu-oracle";

// Bindings must precede the arithmetic library: WGSL has no forward references.
export const arithtestModule = [arithtestBindings, bigfixedSource, arithtestSource].join("\n");
export const orbitModule = [orbitBindings, bigfixedSource, orbitSource].join("\n");

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function randomFixed(random: () => number, limbs: number): bigint {
  let value = 0n;
  for (let i = 0; i < limbs; i++) value = (value << 32n) | BigInt(random());
  return wrapSigned(value, limbs);
}

function scratchWords(limbs: number): number {
  return 7 * limbs + 2 * limbs * 3;
}

async function checkMul32(ctx: GpuContext): Promise<CheckResult> {
  const { device } = ctx;
  const random = makeRandom(4242);
  const cases: number[] = [];
  const extremes = [
    0, 0, 0xffffffff, 0xffffffff, 0xffffffff, 1, 0x80000000, 2, 0xffff, 0xffff,
    0x10000, 0x10000,
  ];
  cases.push(...extremes);
  for (let i = 0; i < 4096; i++) cases.push(random(), random());
  const count = cases.length / 2;

  const module = await compileShader(device, arithtestModule, "arithtest");
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "testMul32", constants: { LIMBS: 8 } },
  });

  const operands = storageBuffer(device, cases.length, "mul32-in");
  const results = storageBuffer(device, count * 2, "mul32-out", GPUBufferUsage.COPY_SRC);
  const params = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  device.queue.writeBuffer(operands, 0, new Uint32Array(cases));
  device.queue.writeBuffer(params, 0, new Uint32Array([0, count, 0, 0]));

  // testMul32 never touches `scratch`, so layout:"auto" leaves binding 2 out of
  // the derived layout. Binding it anyway is a validation error, and the
  // dispatch would silently produce nothing.
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: operands } },
      { binding: 1, resource: { buffer: results } },
      { binding: 3, resource: { buffer: params } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(count / 256));
  pass.end();
  device.queue.submit([encoder.finish()]);

  const out = new Uint32Array(await readBuffer(device, results, count * 8));
  let failures = 0;
  let firstFailure = "";
  for (let i = 0; i < count; i++) {
    const expected = BigInt(cases[i * 2] >>> 0) * BigInt(cases[i * 2 + 1] >>> 0);
    const got = (BigInt(out[i * 2 + 1] >>> 0) << 32n) | BigInt(out[i * 2] >>> 0);
    if (got !== expected) {
      failures++;
      if (!firstFailure) {
        firstFailure = `${cases[i * 2]} * ${cases[i * 2 + 1]}: got ${got}, want ${expected}`;
      }
    }
  }

  [operands, results, params].forEach((b) => b.destroy());
  return {
    name: `mul32 (u32xu32 -> u64), ${count} cases`,
    passed: failures === 0,
    detail: failures === 0 ? "exact match with BigInt" : `${failures} failures; ${firstFailure}`,
  };
}

async function checkBigOp(
  ctx: GpuContext,
  op: 0 | 1 | 2,
  limbs: number,
  caseCount: number
): Promise<CheckResult> {
  const { device } = ctx;
  const names = ["multiply", "add", "subtract"];
  const random = makeRandom(limbs * 7919 + op);

  const pairs: bigint[][] = [];
  // Exercise the boundaries first.
  const one = 1n << (32n * BigInt(limbs - 1));
  pairs.push([one, one], [one, -one], [-one, -one], [one / 2n, one / 2n]);
  pairs.push([0n, one], [one, 0n], [0n, 0n]);
  pairs.push([wrapSigned((1n << (32n * BigInt(limbs) - 1n)) - 1n, limbs), one]);
  while (pairs.length < caseCount) {
    pairs.push([randomFixed(random, limbs), randomFixed(random, limbs)]);
  }

  const operands = new Uint32Array(pairs.length * 2 * limbs);
  pairs.forEach(([a, b], i) => {
    operands.set(toLimbs(a, limbs), i * 2 * limbs);
    operands.set(toLimbs(b, limbs), i * 2 * limbs + limbs);
  });

  const module = await compileShader(device, arithtestModule, "arithtest");
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "testBigOp", constants: { LIMBS: limbs } },
  });

  const inBuf = storageBuffer(device, operands.length, "bigop-in");
  const outBuf = storageBuffer(
    device,
    pairs.length * limbs,
    "bigop-out",
    GPUBufferUsage.COPY_SRC
  );
  const scratch = storageBuffer(device, scratchWords(limbs), "bigop-scratch");
  const params = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  device.queue.writeBuffer(inBuf, 0, operands);
  device.queue.writeBuffer(params, 0, new Uint32Array([op, pairs.length, 0, 0]));

  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inBuf } },
      { binding: 1, resource: { buffer: outBuf } },
      { binding: 2, resource: { buffer: scratch } },
      { binding: 3, resource: { buffer: params } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(1);
  pass.end();
  device.queue.submit([encoder.finish()]);

  const out = new Uint32Array(await readBuffer(device, outBuf, pairs.length * limbs * 4));
  let failures = 0;
  let firstFailure = "";
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    const expected =
      op === 0 ? mulFixed(a, b, limbs) : op === 1 ? addFixed(a, b, limbs) : subFixed(a, b, limbs);
    const got = fromLimbs(out.subarray(i * limbs, (i + 1) * limbs), limbs);
    if (got !== expected) {
      failures++;
      if (!firstFailure) {
        firstFailure = `case ${i}: got ${got}, want ${expected} (diff ${got - expected})`;
      }
    }
  }

  [inBuf, outBuf, scratch, params].forEach((b) => b.destroy());
  return {
    name: `${names[op]} @ ${limbs} limbs, ${pairs.length} cases`,
    passed: failures === 0,
    detail: failures === 0 ? "exact match with BigInt" : `${failures} failures; ${firstFailure}`,
  };
}

/**
 * @param batchSize when set, the orbit is advanced in several dispatches
 * instead of one. That path has its own index bookkeeping and has to be
 * checked separately -- a single dispatch cannot catch a batch-boundary bug.
 */
async function checkOrbit(
  ctx: GpuContext,
  limbs: number,
  centerX: string,
  centerY: string,
  iterations: number,
  batchSize?: number,
  juliaInitial?: [string, string]
): Promise<CheckResult> {
  const { device } = ctx;
  const maxSamples = iterations + 1;
  const stride = juliaInitial ? 20 : 12;

  const module = await compileShader(device, orbitModule, "orbit");
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "advanceOrbit", constants: { LIMBS: limbs, SAMPLE_WORDS: stride } },
  });

  const state = storageBuffer(device, limbs * 2, "orbit-state");
  const seed = storageBuffer(device, limbs * 4, "orbit-seed");
  const scratch = storageBuffer(device, scratchWords(limbs), "orbit-scratch");
  const samples = storageBuffer(device, maxSamples * stride, "orbit-samples", GPUBufferUsage.COPY_SRC);
  const status = storageBuffer(device, 4, "orbit-status", GPUBufferUsage.COPY_SRC);
  const params = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const seedData = new Uint32Array(limbs * 4);
  seedData.set(parseFixed(centerX, limbs), 0);
  seedData.set(parseFixed(centerY, limbs), limbs);
  const initialX = parseFixed(juliaInitial?.[0] ?? "0", limbs);
  const initialY = parseFixed(juliaInitial?.[1] ?? "0", limbs);
  seedData.set(initialX, limbs * 2);
  seedData.set(initialY, limbs * 3);
  device.queue.writeBuffer(seed, 0, seedData);
  const initialState = new Uint32Array(limbs * 2);
  initialState.set(initialX); initialState.set(initialY, limbs);
  device.queue.writeBuffer(state, 0, initialState);
  // status[0] is the resume cursor: the shader continues from the last sample
  // written, and sample 0 (z = 0) is written here.
  device.queue.writeBuffer(status, 0, new Uint32Array([1, 0, 0, 0]));
  device.queue.writeBuffer(samples, 0, new Float32Array(juliaInitial ?
    [...fixedToQuad(initialX, limbs), ...fixedToQuad(initialY, limbs), ...Array(10).fill(0)] : Array(12).fill(0)));

  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: state } },
      { binding: 1, resource: { buffer: seed } },
      { binding: 2, resource: { buffer: scratch } },
      { binding: 3, resource: { buffer: samples } },
      { binding: 4, resource: { buffer: status } },
      { binding: 5, resource: { buffer: params } },
    ],
  });

  const started = performance.now();
  let rawStatus = new Uint32Array(4);
  let sampleCount = 1;
  const batch = batchSize ?? iterations;

  while (sampleCount - 1 < iterations) {
    const done = sampleCount - 1;
    device.queue.writeBuffer(
      params,
      0,
      new Uint32Array([Math.min(batch, iterations - done), 0, maxSamples, 0])
    );
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);

    rawStatus = new Uint32Array(await readBuffer(device, status, 16));
    if (rawStatus[0] <= sampleCount) break;
    sampleCount = rawStatus[0];
    if (rawStatus[1] === 1) break;
  }
  const elapsed = performance.now() - started;
  const data = new Float32Array(await readBuffer(device, samples, maxSamples * stride * 4));

  // Oracle.
  const c = {
    x: fromLimbs(parseFixed(centerX, limbs), limbs),
    y: fromLimbs(parseFixed(centerY, limbs), limbs),
  };
  if (juliaInitial) {
    const origin = { x: fromLimbs(initialX, limbs), y: fromLimbs(initialY, limbs) };
    let z = origin;
    let mismatches = 0;
    for (let i = 0; i < sampleCount; i++) {
      const expected = [z.x, z.y, z.x - origin.x, z.y - origin.y]
        .flatMap(value => fixedToQuad(toLimbs(value, limbs), limbs));
      expected.forEach((value, j) => { if (data[i * stride + j] !== value) mismatches++; });
      z = orbitStep(z, c, limbs);
    }
    [state, seed, scratch, samples, status, params].forEach(b => b.destroy());
    return { name: "Julia wide absolute/relative GPU samples", passed: sampleCount === maxSamples && mismatches === 0,
      detail: `${sampleCount} samples, ${mismatches} component mismatches, batch=${batchSize}` };
  }
  const expected = referenceOrbit(c, limbs, iterations);

  let worst = 0;
  let worstIndex = -1;
  const compared = Math.min(expected.length, sampleCount, maxSamples);
  for (let i = 1; i < compared; i++) {
    const gx = fromHdr({
      mantissaHi: data[i * 12 + 0],
      mantissaLo: data[i * 12 + 1],
      exponent: data[i * 12 + 2],
    });
    const gy = fromHdr({
      mantissaHi: data[i * 12 + 3],
      mantissaLo: data[i * 12 + 4],
      exponent: data[i * 12 + 5],
    });
    const ex = fixedToNumber(toLimbs(expected[i].x, limbs), limbs);
    const ey = fixedToNumber(toLimbs(expected[i].y, limbs), limbs);
    const error = Math.max(Math.abs(gx - ex), Math.abs(gy - ey));
    if (error > worst) {
      worst = error;
      worstIndex = i;
    }
  }

  [state, seed, scratch, samples, status, params].forEach((b) => b.destroy());

  // Samples are emitted with ~48 mantissa bits, so agreement to ~1e-12 is the
  // most the reduced format can promise.
  const passed = compared > 1 && worst < 1e-11;
  return {
    name: `orbit @ ${limbs} limbs, ${iterations} iterations${batchSize ? `, batched by ${batchSize}` : ""} (${centerX})`,
    passed,
    detail: `compared ${compared - 1} samples, worst error ${worst.toExponential(2)} at #${worstIndex}, ${elapsed.toFixed(1)}ms, escaped=${rawStatus[1] === 1}`,
  };
}

async function checkQuad(ctx: GpuContext): Promise<CheckResult> {
  const cases = [
    ["1.000000000000000000001", "-1"],
    ["-1.000000000000000000001", "1"],
    ["1.2345678901234567890123456789", "-0.98765432109876543210987654321"],
    ["-0.8", "0.156"],
    ["0", "0"],
  ];
  Decimal.set({ precision: Math.max(Decimal.precision, 100) });
  const { device } = ctx;
  const input = storageBuffer(device, cases.length * 8, "quad-input");
  const output = storageBuffer(device, cases.length * 8, "quad-output", GPUBufferUsage.COPY_SRC);
  device.queue.writeBuffer(input, 0, new Float32Array(cases.flatMap(pair => pair.flatMap(v => [...splitQuad(new Decimal(v))]))));
  const module = await compileShader(device, quadSource + `
    @group(0) @binding(0) var<storage,read> inputs: array<vec4<f32>>;
    @group(0) @binding(1) var<storage,read_write> outputs: array<vec4<f32>>;
    @compute @workgroup_size(1) fn check(@builtin(global_invocation_id) id: vec3<u32>) {
      let a=inputs[id.x*2u]; let b=inputs[id.x*2u+1u];
      outputs[id.x*2u]=qAdd(a,b); outputs[id.x*2u+1u]=qMul(a,b);
    }`, "quad-check");
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "check" } });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } },
  ] });
  const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(cases.length); pass.end();
  device.queue.submit([encoder.finish()]);
  const result = new Float32Array(await readBuffer(device, output, cases.length * 32));
  const raw = new Uint32Array(result.buffer);
  // Exact binary decoding, independent of the Decimal component splitter.
  const decode = (index: number) => {
    const word = raw[index]; if ((word & 0x7fffffff) === 0) return 0n;
    const exponent = (word >>> 23) & 255;
    const mantissa = BigInt((word & 0x7fffff) + (exponent ? 0x800000 : 0));
    return (word >>> 31 ? -1n : 1n) * (mantissa << BigInt(256 + (exponent || 1) - 150));
  };
  let failures = 0;
  cases.forEach(([left, right], i) => {
    const a = scaleDecimal(left, 256n), b = scaleDecimal(right, 256n);
    [a + b, a * b / (1n << 256n)].forEach((expected, operation) => {
      let actual = 0n;
      for (let j = 0; j < 4; j++) actual += decode(i * 8 + operation * 4 + j);
      const error = actual - expected;
      if ((error < 0n ? -error : error) > (1n << 176n)) failures++;
    });
  });
  input.destroy(); output.destroy();
  return { name: "Julia quad addition, cancellation and products", passed: failures === 0,
    detail: `${cases.length * 2} results, ${failures} outside absolute 2^-80 tolerance` };
}

export async function runSelfTest(
  log: (result: CheckResult) => void
): Promise<boolean> {
  const ctx = await acquireGpu();
  log({
    name: "device",
    passed: true,
    detail: `${ctx.capabilities.adapterInfo}; workgroup storage ${ctx.capabilities.maxComputeWorkgroupStorageSize}B; ${ctx.capabilities.maxComputeInvocationsPerWorkgroup} invocations`,
  });

  const results: CheckResult[] = [];
  results.push(await checkQuad(ctx));
  results.push(await checkMul32(ctx));
  for (const limbs of [8, 16, 64]) {
    results.push(await checkBigOp(ctx, 1, limbs, 64));
    results.push(await checkBigOp(ctx, 2, limbs, 64));
    results.push(await checkBigOp(ctx, 0, limbs, 64));
  }
  results.push(await checkOrbit(ctx, 16, "-1", "0", 32));
  results.push(await checkOrbit(ctx, 16, "-0.8", "0.156", 256, 7, [
    "-0.52750311864353461078974640244491533756674594781170728533987519700320301109745",
    "0.07591217835228786707181419482634804636642219484797802253973259344918689150308",
  ]));
  results.push(await checkOrbit(ctx, 32, "-0.25", "0", 128));
  results.push(await checkOrbit(ctx, 64, "-0.743643887037151", "0.13182590420533", 256));
  results.push(
    await checkOrbit(
      ctx,
      64,
      "-0.600705755160234496572763605385",
      "0.441239870241679552586993134940",
      512
    )
  );
  // The renderer advances the orbit in batches; that bookkeeping needs its own
  // coverage, and must agree sample-for-sample with the single-dispatch run.
  for (const batch of [1, 7, 128]) {
    results.push(
      await checkOrbit(
        ctx,
        32,
        "-0.600705755160234496572763605385",
        "0.441239870241679552586993134940",
        400,
        batch
      )
    );
  }

  results.forEach(log);
  return results.every((r) => r.passed);
}
