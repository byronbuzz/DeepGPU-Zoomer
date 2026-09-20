import { orbitStep, subFixed, type FixedComplex } from "../arithmetic/cpu-oracle";
import { fixedToQuad } from "../arithmetic/quad";
import { fromLimbs, parseFixed, toLimbs } from "../arithmetic/types";

const SUPPORTED_LIMBS = new Set([8, 16, 32, 64, 128, 256]);
const SAMPLE_FLOATS = 20;
const CHUNK_SAMPLES = 8192;
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

function writeComponent(target: Float32Array, offset: number, value: bigint, limbs: number): Uint32Array {
  const words = toLimbs(value, limbs);
  target.set(fixedToQuad(words, limbs), offset);
  return words;
}

function writeSample(
  target: Float32Array,
  index: number,
  value: FixedComplex,
  initial: FixedComplex,
  limbs: number,
): { x: Uint32Array; y: Uint32Array } {
  const offset = index * SAMPLE_FLOATS;
  const x = writeComponent(target, offset, value.x, limbs);
  const y = writeComponent(target, offset + 5, value.y, limbs);
  writeComponent(target, offset + 10, subFixed(value.x, initial.x, limbs), limbs);
  writeComponent(target, offset + 15, subFixed(value.y, initial.y, limbs), limbs);
  return { x, y };
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
  writeComponent(packed, 0, initial.x, limbs);
  writeComponent(packed, 5, initial.y, limbs);

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
      if (gpuReferenceEscaped(toLimbs(z.x, limbs), toLimbs(z.y, limbs), limbs)) {
        escaped = true; escapeIndex = iteration;
      }
    }
    if (!reportedPacking) { reportedPacking = true; onStage?.("packing"); }
    for (const sample of batch) {
      writeSample(packed, sample.index, sample.value, initial, limbs);
      length = sample.index + 1;
    }
  }
  const byteLength = length * SAMPLE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
  return { buffer: packed.buffer.slice(0, byteLength), length, escaped, escapeIndex };
}

export const REFERENCE_SAMPLE_FLOATS = SAMPLE_FLOATS;
