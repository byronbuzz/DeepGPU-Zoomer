import { subFixed, type FixedComplex } from "../arithmetic/fixed-complex";
import { createReferenceStep } from "./reference-step";
import { fromLimbs, parseFixed } from "../arithmetic/types";

const SUPPORTED_LIMBS = new Set([8, 16, 32, 64, 128, 256]);
export const REFERENCE_FORMAT_VERSION = 2;
export type ReferenceSampleWords = 10 | 20;
const WORD_MASK = 0xffffffffn;
const QUAD_SCALES = [2 ** -23, 2 ** -47, 2 ** -71, 2 ** -95] as const;
export const MAX_REFERENCE_ITERATIONS = 10_000_000;
/** Bounds one worker allocation and leaves cancellation opportunities between suffixes. */
export const REFERENCE_CHUNK_ITERATIONS = 65_536;

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
  formatVersion: typeof REFERENCE_FORMAT_VERSION;
  sampleWords: ReferenceSampleWords;
  /** Global index of the first sample in buffer, not a new orbit origin. */
  startIndex: number;
  /** Total samples in the original trajectory through terminal.iteration. */
  length: number;
  escaped: boolean;
  escapeIndex: number;
  iterationsComputed: number;
  complete: boolean;
  terminal: ReferenceResumeState;
}

/** Exact fixed-point recurrence state; never reconstruct this from packed samples. */
export interface ReferenceResumeState {
  identity: string;
  iteration: number;
  x: bigint;
  y: bigint;
  escaped: boolean;
  escapeIndex: number;
}

/** Iteration demand is excluded; Mandelbrot also ignores the unused Julia constant. */
export function referenceIdentity(input: ReferenceOrbitInput): string {
  return JSON.stringify(input.family === "julia"
    ? [input.family, input.centerX, input.centerY, input.juliaX, input.juliaY, input.limbs]
    : [input.family, input.centerX, input.centerY, input.limbs]);
}

/** Mandelbrot starts at zero, so its relative reference equals its absolute one. */
export function referenceSampleWords(family: ReferenceOrbitInput['family']): ReferenceSampleWords {
  return family === 'julia' ? 20 : 10;
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
  // Fixed-point reference values have at most 32 integer bits. Read the upper
  // words exactly, avoiding a full-width string for ordinary orbit values.
  const upper = magnitude >> context.lowWordShift;
  let bits: number;
  if (upper !== 0n) {
    bits = context.fractionalBits - 32 + (upper >= 0x100000000n
      ? 64 - Math.clz32(Number(upper >> 32n))
      : 32 - Math.clz32(Number(upper)));
  } else {
    const hexadecimal = magnitude.toString(16);
    bits = (hexadecimal.length - 1) * 4 + 32 - Math.clz32(parseInt(hexadecimal[0], 16));
  }
  const sign = value < 0n ? -1 : 1;
  const shift = bits - 96;
  const window = shift >= 0 ? magnitude >> BigInt(shift) : magnitude << BigInt(-shift);
  const high = Number(window >> 48n), low = Number(window & 0xffffffffffffn);
  target[offset] = sign * Math.floor(high / 0x1000000) * QUAD_SCALES[0];
  target[offset + 1] = sign * (high % 0x1000000) * QUAD_SCALES[1];
  target[offset + 2] = sign * Math.floor(low / 0x1000000) * QUAD_SCALES[2];
  target[offset + 3] = sign * (low % 0x1000000) * QUAD_SCALES[3];
  target[offset + 4] = bits - 1 - context.fractionalBits;
}

function writeSample(
  target: Float32Array,
  index: number,
  value: FixedComplex,
  initial: FixedComplex,
  context: PackingContext,
  sampleWords: ReferenceSampleWords,
): void {
  const offset = index * sampleWords;
  writeComponent(target, offset, value.x, context);
  writeComponent(target, offset + 5, value.y, context);
  if (sampleWords === 20) {
    writeComponent(target, offset + 10, subFixed(value.x, initial.x, context.limbs), context);
    writeComponent(target, offset + 15, subFixed(value.y, initial.y, context.limbs), context);
  }
}

/**
 * Generates and packs the exact transport consumed by the perturbation shader.
 * The recurrence is serial and intentionally synchronous inside a dedicated
 * worker; terminating that worker is the cancellation mechanism.
 */
export function generatePackedReference(
  input: ReferenceOrbitInput,
  resume?: ReferenceResumeState,
  iterationBudget?: number,
): PackedReferenceOrbit {
  if (input.family !== "mandelbrot" && input.family !== "julia") throw new Error("Unsupported reference family");
  if (![input.centerX, input.centerY, input.juliaX, input.juliaY].every(value => typeof value === "string")) {
    throw new Error("Invalid reference coordinate identity");
  }
  if (!SUPPORTED_LIMBS.has(input.limbs)) throw new Error(`Unsupported reference precision: ${input.limbs} limbs`);
  if (!Number.isInteger(input.maxIterations) || input.maxIterations < 1 || input.maxIterations > MAX_REFERENCE_ITERATIONS) {
    throw new Error("Unsupported reference iteration limit");
  }
  if (iterationBudget !== undefined && (!Number.isInteger(iterationBudget) || iterationBudget < 1 || iterationBudget > MAX_REFERENCE_ITERATIONS)) {
    throw new Error("Unsupported reference chunk budget");
  }
  // Use the complete supplied identity, including decimal spelling. Rejecting
  // an equivalent alternate spelling is safer than admitting a changed input.
  const identity = referenceIdentity(input);
  if (resume && (resume.identity !== identity || !Number.isInteger(resume.iteration) ||
      resume.iteration < 1 || resume.iteration > input.maxIterations ||
      typeof resume.x !== "bigint" || typeof resume.y !== "bigint" ||
      typeof resume.escaped !== "boolean" ||
      (resume.escaped ? resume.escapeIndex !== resume.iteration : resume.escapeIndex !== 0))) {
    throw new Error("Incompatible reference continuation");
  }
  const { limbs } = input;
  const step = createReferenceStep(limbs);
  const julia = input.family === "julia";
  const sampleWords = referenceSampleWords(input.family);
  const context = packingContext(limbs);
  const initial: FixedComplex = {
    x: fromLimbs(parseFixed(julia ? input.centerX : "0", limbs), limbs),
    y: fromLimbs(parseFixed(julia ? input.centerY : "0", limbs), limbs),
  };
  const constant: FixedComplex = {
    x: fromLimbs(parseFixed(julia ? input.juliaX : input.centerX, limbs), limbs),
    y: fromLimbs(parseFixed(julia ? input.juliaY : input.centerY, limbs), limbs),
  };
  if (resume && (BigInt.asIntN(32 * limbs, resume.x) !== resume.x ||
      BigInt.asIntN(32 * limbs, resume.y) !== resume.y ||
      gpuReferenceEscapedFixed(resume.x, resume.y, limbs) !== resume.escaped)) {
    throw new Error("Incompatible reference continuation state");
  }
  const escapeGate = 8n << BigInt(context.fractionalBits);
  const negativeEscapeGate = -escapeGate;
  const initialIteration = resume?.iteration ?? 0;
  const targetIteration = Math.min(input.maxIterations, initialIteration + (iterationBudget ?? input.maxIterations));
  const startIndex = resume ? initialIteration + 1 : 0;
  const packed = new Float32Array((resume?.escaped ? 0 : targetIteration + 1 - startIndex) * sampleWords);
  // Julia sample zero is its absolute initial state plus ten zero relative words.
  if (julia && !resume) {
    writeComponent(packed, 0, initial.x, context);
    writeComponent(packed, 5, initial.y, context);
  }

  let z = resume ? { x: resume.x, y: resume.y } : initial;
  let iteration = initialIteration, length = initialIteration + 1;
  let escaped = resume?.escaped ?? false, escapeIndex = resume?.escapeIndex ?? 0;
  while (iteration < targetIteration && !escaped) {
    iteration++;
    z = step(z, constant);
    // Preserve the emitted sample and the GPU bailout predicate ordering.
    // Inside this square, even rounded f32 coordinates stay far below r^2=256.
    // Avoid conversion on ordinary iterations; preserve the exact GPU predicate outside.
    if (z.x <= negativeEscapeGate || z.x >= escapeGate || z.y <= negativeEscapeGate || z.y >= escapeGate) {
      const ax = gpuApproximationFixed(z.x, context), ay = gpuApproximationFixed(z.y, context);
      if (Math.fround(Math.fround(ax * ax) + Math.fround(ay * ay)) > 256) {
        escaped = true; escapeIndex = iteration;
      }
    }
    // Julia relative samples keep the ORIGINAL initial point across suffixes.
    writeSample(packed, iteration - startIndex, z, initial, context, sampleWords);
    length = iteration + 1;
  }
  const byteLength = (length - startIndex) * sampleWords * Float32Array.BYTES_PER_ELEMENT;
  const buffer = byteLength === packed.byteLength ? packed.buffer : packed.buffer.slice(0, byteLength);
  return { buffer, formatVersion: REFERENCE_FORMAT_VERSION, sampleWords, startIndex, length, escaped, escapeIndex,
    iterationsComputed: iteration - initialIteration,
    complete: escaped || iteration === input.maxIterations,
    terminal: { identity, iteration, x: z.x, y: z.y, escaped, escapeIndex } };
}
