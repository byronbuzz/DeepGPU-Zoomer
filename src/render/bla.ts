/**
 * Standard bivariate linear approximation (BLA).
 *
 * For one perturbation step
 *
 *     w' = 2*X*w + w^2 + d
 *
 * omit the nonlinear term while it is below the selected local tolerance:
 *
 *     w' ~= A*w + B*d,  A = 2*X, B = 1, |w| < epsilon*|A|.
 *
 * Adjacent steps are composed with the standard local-validity rule. Every
 * eligible sampling density uses this policy; the complete Wide recurrence is
 * the local fallback whenever a skip is unavailable.
 */

import Decimal from "decimal.js";

/** One reference iteration per level-0 entry. */
export const BASE_STEP = 1;
/** Empirical local tolerance selected for the accepted quality/performance tradeoff. */
const EPSILON_LOG2 = -21;
/** Sentinel log2-radius meaning "this step is never usable". */
export const NEVER = -1e30;
/** Matches the shader's LA_NEVER eligibility cutoff. */
const MIN_USABLE_RADIUS_LOG2 = -1e29;
/** Two complex coefficients, radius, padding. */
export const ENTRY_FLOATS = 12;

export interface BlaTable {
  data: Float32Array;
  levelOffsets: number[];
  levelCounts: number[];
  levels: number;
  entryCount: number;
  /** At least one packed range of two or more iterations can pass the shader's radius sentinel. */
  hasUsableMultiStep: boolean;
}

/** A complex number as (x, y) * 2^e, mantissa normalised near [1, 2). */
export interface Scaled { x: number; y: number; e: number }

export function normalise(x: number, y: number, e: number): Scaled {
  const magnitude = Math.max(Math.abs(x), Math.abs(y));
  if (magnitude === 0 || !Number.isFinite(magnitude)) return { x: 0, y: 0, e: 0 };
  const shift = Math.floor(Math.log2(magnitude)), scale = 2 ** -shift;
  return { x: x * scale, y: y * scale, e: e + shift };
}

export function multiply(a: Scaled, b: Scaled): Scaled {
  return normalise(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x, a.e + b.e);
}

export function add(a: Scaled, b: Scaled): Scaled {
  if (a.x === 0 && a.y === 0) return b;
  if (b.x === 0 && b.y === 0) return a;
  const difference = a.e - b.e;
  if (difference > 80) return a;
  if (difference < -80) return b;
  if (difference >= 0) {
    const scale = 2 ** -difference;
    return normalise(a.x + b.x * scale, a.y + b.y * scale, a.e);
  }
  const scale = 2 ** difference;
  return normalise(a.x * scale + b.x, a.y * scale + b.y, b.e);
}

export function log2Magnitude(value: Scaled): number {
  const magnitude = Math.hypot(value.x, value.y);
  return magnitude === 0 ? -Infinity : value.e + Math.log2(magnitude);
}

const ONE: Scaled = { x: 1, y: 0, e: 0 };

export interface Step { a: Scaled; b: Scaled; radiusLog2: number }

/** Compose first then second: A=A2*A1, B=A2*B1+B2. */
export function compose(first: Step, second: Step): Pick<Step, "a" | "b"> {
  return { a: multiply(second.a, first.a), b: add(multiply(second.a, first.b), second.b) };
}

export interface BuildOptions {
  epsilonLog2?: number;
  /** Four-word reference samples, with Julia relative components. */
  sampleWords: 10 | 20;
}

/** Preserve ordinary binary64 bounds, but never narrow a deep Decimal to zero. */
export function deltaBoundLog2(maxDelta: number | Decimal): number {
  if (typeof maxDelta === "number") return maxDelta > 0 ? Math.log2(maxDelta) : -Infinity;
  if (maxDelta.isZero()) return -Infinity;
  const ordinary = maxDelta.toNumber();
  if (ordinary >= 2 ** -1022 && Number.isFinite(ordinary)) return Math.log2(ordinary);
  // Split before conversion: even binary64 subnormals lose significant range
  // and precision. No high-precision transcendental is needed at deep zoom.
  const leading = maxDelta.div(new Decimal(`1e${maxDelta.e}`)).toNumber();
  const log = Math.log2(leading) + maxDelta.e * Math.LOG2E * Math.LN10;
  // Bias the split conversion outward by a few binary64 rounding units. The
  // existing log-radius composition and GPU packing policy remain unchanged.
  return log + 4 * Number.EPSILON * Math.max(1, Math.abs(log));
}

function* buildBlaSteps(
  orbit: Float32Array,
  length: number,
  maxDelta: number | Decimal,
  options: BuildOptions,
): Generator<void, BlaTable> {
  // Reference index zero has X=0, so its perturbation step contains only the
  // nonlinear w^2 term plus d and cannot be represented by a linear BLA.
  // Store entries for reference indices 1..length-2; the shader uses the same
  // index-1 alignment at every merged level.
  const count = Math.max(0, length - 2);
  const counts = [count], maxLevels = 21;
  for (let level = 1; level < maxLevels; level++) {
    const nextCount = Math.floor(counts[level - 1] / 2);
    if (nextCount < 1) break;
    counts.push(nextCount);
  }
  const levelOffsets: number[] = [], levelCounts: number[] = [];
  let entryCount = 0;
  for (let level = 0; level < counts.length; level++) {
    const storedCount = level === 0 ? 0 : counts[level];
    levelOffsets.push(entryCount); levelCounts.push(storedCount); entryCount += storedCount;
  }
  const data = new Float32Array(Math.max(1, entryCount) * ENTRY_FLOATS);
  // Keep full binary64 coefficients until every dependent merge is complete.
  // Only the current and next levels live here; the f32 transport is output,
  // never input to a higher level's coefficient or radius calculation.
  const STEP_DOUBLES = 7;
  let current = new Float64Array(count * STEP_DOUBLES);
  const store = (target: Float64Array, index: number, a: Scaled, b: Scaled, radius: number) => {
    const at = index * STEP_DOUBLES;
    target[at] = a.x; target[at + 1] = a.y; target[at + 2] = a.e;
    target[at + 3] = b.x; target[at + 4] = b.y; target[at + 5] = b.e; target[at + 6] = radius;
  };
  const load = (source: Float64Array, index: number, step: Step) => {
    const at = index * STEP_DOUBLES;
    step.a.x = source[at]; step.a.y = source[at + 1]; step.a.e = source[at + 2];
    step.b.x = source[at + 3]; step.b.y = source[at + 4]; step.b.e = source[at + 5]; step.radiusLog2 = source[at + 6];
  };
  const maxDeltaLog2 = deltaBoundLog2(maxDelta);
  for (let i = 0; i < count; i++) {
    if (i % 4096 === 0) yield;
    const at = (i + 1) * options.sampleWords;
    const x = (orbit[at] + orbit[at + 1] + orbit[at + 2] + orbit[at + 3]) * 2 ** orbit[at + 4];
    const y = (orbit[at + 5] + orbit[at + 6] + orbit[at + 7] + orbit[at + 8]) * 2 ** orbit[at + 9];
    const a = normalise(2 * x, 2 * y, 0);
    const magnitude = log2Magnitude(a);
    store(current, i, a, ONE, Number.isFinite(magnitude) ? magnitude + (options.epsilonLog2 ?? EPSILON_LOG2) : NEVER);
  }
  const first: Step = { a: {x:0,y:0,e:0}, b: {x:0,y:0,e:0}, radiusLog2:NEVER };
  const second: Step = { a: {x:0,y:0,e:0}, b: {x:0,y:0,e:0}, radiusLog2:NEVER };
  let hasUsableMultiStep = false;
  for (let levelIndex = 0; levelIndex < counts.length; levelIndex++) {
    // Finalize this level directly into its predetermined transport range.
    // The omitted base level is still retained in binary64 for its first merge.
    const offset = levelOffsets[levelIndex];
    for (let index = 0; index < levelCounts[levelIndex]; index++) {
      if (index % 4096 === 0) yield;
      const target = (offset + index) * ENTRY_FLOATS, source = index * STEP_DOUBLES;
      for (let slot = 0; slot < 2; slot++) {
        const at = source + slot * 3, to = target + slot * 5;
        data[to] = current[at]; data[to + 1] = current[at] - Math.fround(current[at]);
        data[to + 2] = current[at + 1]; data[to + 3] = current[at + 1] - Math.fround(current[at + 1]);
        data[to + 4] = current[at + 2];
      }
      const radius = current[source + 6];
      data[target + 10] = radius;
      if (levelIndex > 0 && radius > MIN_USABLE_RADIUS_LOG2) hasUsableMultiStep = true;
    }
    if (levelIndex + 1 === counts.length) break;
    const mergedCount = counts[levelIndex + 1], merged = new Float64Array(mergedCount * STEP_DOUBLES);
    for (let i = 0; i < mergedCount; i++) {
      if (i % 2048 === 0) yield;
      load(current, 2 * i, first); load(current, 2 * i + 1, second);
      const injectedLog2 = log2Magnitude(first.b) + maxDeltaLog2;
      let radiusLog2 = NEVER;
      if (injectedLog2 < second.radiusLog2) {
        const remaining = second.radiusLog2 + Math.log2(1 - 2 ** (injectedLog2 - second.radiusLog2));
        radiusLog2 = Math.min(first.radiusLog2, remaining - log2Magnitude(first.a));
      }
      if (!Number.isFinite(radiusLog2)) radiusLog2 = NEVER;
      const combined = compose(first, second);
      store(merged, i, combined.a, combined.b, radiusLog2);
    }
    current = merged;
  }
  return { data, levelOffsets, levelCounts, levels: counts.length, entryCount, hasUsableMultiStep };
}

export async function buildBlaAsync(
  orbit: Float32Array,
  length: number,
  maxDelta: number | Decimal,
  checkpoint: () => Promise<void>,
  options: BuildOptions,
): Promise<BlaTable> {
  const steps = buildBlaSteps(orbit, length, maxDelta, options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    await checkpoint();
  }
}
