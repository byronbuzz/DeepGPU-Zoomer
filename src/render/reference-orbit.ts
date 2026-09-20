import { orbitStep, subFixed, type FixedComplex } from "../arithmetic/cpu-oracle";
import { fromLimbs, parseFixed } from "../arithmetic/types";

const SUPPORTED_LIMBS = new Set([8, 16, 32, 64, 128, 256]);
const SAMPLE_FLOATS = 20;
const CHUNK_SAMPLES = 8192;
const WORD_MASK = 0xffffffffn;
const QUAD_SCALES = [2 ** -23, 2 ** -47, 2 ** -71, 2 ** -95] as const;
export type ReferenceStage = "generation" | "packing";

export interface ReferenceOrbitInput {
  family: "mandelbrot" | "julia";
  centerX: string;
  centerY: string;
  juliaX: string;
  juliaY: string;
  limbs: number;
  maxIterations: number;
}

export interface PackedReferenceOrbit {
  buffer: ArrayBuffer;
  length: number;
  escaped: boolean;
  escapeIndex: number;
}

interface PackingContext {
  limbs: number;
  fractionalBits: number;
  highWordShift: bigint;
  lowWordShift: bigint;
}

function packingContext(limbs: number): PackingContext {
  const highWordShift = 32n * BigInt(limbs - 1);
  return {
    limbs,
    fractionalBits: 32 * (limbs - 1),
    highWordShift,
    lowWordShift: highWordShift - 32n,
  };
}

function gpuApproximation(words: Uint32Array, limbs: number): number {
  const high = Math.fround(words[limbs - 1] | 0);
  const low = Math.fround(Math.fround(words[limbs - 2] >>> 0) * Math.fround(2 ** -32));
  return Math.fround(high + low);
}

/** Mirrors the f32 reference-bailout predicate in orbit.wgsl. */
export function gpuReferenceEscaped(x: Uint32Array, y: Uint32Array, limbs: number): boolean {
  const ax = gpuApproximation(x, limbs), ay = gpuApproximation(y, limbs);
  return Math.fround(Math.fround(ax * ax) + Math.fround(ay * ay)) > 256;
}

function gpuApproximationFixed(value: bigint, context: PackingContext): number {
  const high = Number((value >> context.highWordShift) & WORD_MASK) | 0;
  const low = Number((value >> context.lowWordShift) & WORD_MASK) >>> 0;
  return Math.fround(Math.fround(high) + Math.fround(Math.fround(low) * Math.fround(2 ** -32)));
}

/** Mirrors the GPU predicate without materialising every fixed-point limb. */
export function gpuReferenceEscapedFixed(x: bigint, y: bigint, limbs: number): boolean {
  const context = packingContext(limbs);
  const ax = gpuApproximationFixed(x, context), ay = gpuApproximationFixed(y, context);
  return Math.fround(Math.fround(ax * ax) + Math.fround(ay * ay)) > 256;
}

function writeComponent(target: Float32Array, offset: number, value: bigint, context: PackingContext): void {
  // Every sample region is written once in a newly zeroed Float32Array.
  if (value === 0n) return;
  const magnitude = value < 0n ? -value : value;
  const bits = magnitude.toString(2).length;
  const sign = value < 0n ? -1 : 1;
  for (let index = 0; index < 4; index++) {
    const shift = bits - 24 * (index + 1);
    const chunk = (shift >= 0 ? magnitude >> BigInt(shift) : magnitude << BigInt(-shift)) & 0xffffffn;
    target[offset + index] = sign * Number(chunk) * QUAD_SCALES[index];
  }
  target[offset + 4] = bits - 1 - context.fractionalBits;
}

/** Test-facing wrapper around the allocation-free production packer. */
export function fixedBigIntToQuad(value: bigint, limbs: number): Float32Array {
  const packed = new Float32Array(5);
  writeComponent(packed, 0, value, packingContext(limbs));
  return packed;
}

function writeSample(
  target: Float32Array,
  index: number,
  value: FixedComplex,
  initial: FixedComplex,
  context: PackingContext,
  relativeIsAbsolute: boolean,
): void {
  const offset = index * SAMPLE_FLOATS;
  writeComponent(target, offset, value.x, context);
  writeComponent(target, offset + 5, value.y, context);
  if (relativeIsAbsolute) {
    if (value.x !== 0n || value.y !== 0n) target.copyWithin(offset + 10, offset, offset + 10);
  } else {
    writeComponent(target, offset + 10, subFixed(value.x, initial.x, context.limbs), context);
    writeComponent(target, offset + 15, subFixed(value.y, initial.y, context.limbs), context);
  }
}

/**
 * Generates and packs the exact transport consumed by the perturbation shader.
 * The recurrence is serial and intentionally synchronous inside a dedicated
 * worker; terminating that worker is the cancellation mechanism.
 */
export function generatePackedReference(input: ReferenceOrbitInput, onStage?: (stage: ReferenceStage) => void): PackedReferenceOrbit {
  if (!SUPPORTED_LIMBS.has(input.limbs)) throw new Error(`Unsupported reference precision: ${input.limbs} limbs`);
  if (!Number.isInteger(input.maxIterations) || input.maxIterations < 1 || input.maxIterations > 1_000_000) {
    throw new Error("Unsupported reference iteration limit");
  }
  const { limbs } = input;
  const julia = input.family === "julia";
  const context = packingContext(limbs);
  const initial: FixedComplex = {
    x: fromLimbs(parseFixed(julia ? input.centerX : "0", limbs), limbs),
    y: fromLimbs(parseFixed(julia ? input.centerY : "0", limbs), limbs),
  };
  const constant: FixedComplex = {
    x: fromLimbs(parseFixed(julia ? input.juliaX : input.centerX, limbs), limbs),
    y: fromLimbs(parseFixed(julia ? input.juliaY : input.centerY, limbs), limbs),
  };
  const packed = new Float32Array((input.maxIterations + 1) * SAMPLE_FLOATS);
  // GPU sample zero is the absolute initial state plus ten zero relative words.
  if (julia) {
    writeComponent(packed, 0, initial.x, context);
    writeComponent(packed, 5, initial.y, context);
  }

  let z = initial, length = 1, escaped = false, escapeIndex = 0, iteration = 0;
  let reportedGeneration = false, reportedPacking = false;
  while (iteration < input.maxIterations && !escaped) {
    if (!reportedGeneration) { reportedGeneration = true; onStage?.("generation"); }
    const batch: Array<{ index: number; value: FixedComplex }> = [];
    while (batch.length < CHUNK_SAMPLES && iteration < input.maxIterations && !escaped) {
      iteration++;
      z = orbitStep(z, constant, limbs);
      batch.push({ index: iteration, value: z });
      // Preserve GPU ordering: the sample is logically emitted before this
      // f32 predicate. Physical packing follows in the bounded batch below.
      const ax = gpuApproximationFixed(z.x, context), ay = gpuApproximationFixed(z.y, context);
      if (Math.fround(Math.fround(ax * ax) + Math.fround(ay * ay)) > 256) {
        escaped = true; escapeIndex = iteration;
      }
    }
    if (!reportedPacking) { reportedPacking = true; onStage?.("packing"); }
    for (const sample of batch) {
      writeSample(packed, sample.index, sample.value, initial, context, !julia);
      length = sample.index + 1;
    }
  }
  const byteLength = length * SAMPLE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
  const buffer = byteLength === packed.byteLength ? packed.buffer : packed.buffer.slice(0, byteLength);
  return { buffer, length, escaped, escapeIndex };
}

export const REFERENCE_SAMPLE_FLOATS = SAMPLE_FLOATS;
