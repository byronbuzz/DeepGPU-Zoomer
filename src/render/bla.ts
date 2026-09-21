/**
 * Standard bivariate linear approximation (BLA).
 *
 * For one perturbation step
 *
 *     w' = 2*X*w + w^2 + d
 *
 * omit the nonlinear term while it is below f32 unit roundoff:
 *
 *     w' ~= A*w + B*d,  A = 2*X, B = 1, |w| < epsilon*|A|.
 *
 * Adjacent steps are composed with the standard local-validity rule. Every
 * eligible sampling density uses this policy; the complete Wide recurrence is
 * the local fallback whenever a skip is unavailable.
 */

/** One reference iteration per level-0 entry. */
export const BASE_STEP = 1;
/** f32 unit roundoff used by the published local linearity test. */
const EPSILON_LOG2 = -23;
/** Sentinel log2-radius meaning "this step is never usable". */
export const NEVER = -1e30;
/** Two complex coefficients, radius, padding. */
export const ENTRY_FLOATS = 12;

export interface BlaTable {
  data: Float32Array;
  levelOffsets: number[];
  levelCounts: number[];
  levels: number;
  entryCount: number;
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
  maxLevels?: number;
  /** Legacy reduced samples or the renderer's four-word reference samples. */
  sampleWords?: 6 | 20;
}

function* buildBlaSteps(
  orbit: Float32Array,
  length: number,
  maxDelta: number,
  options: BuildOptions = {},
): Generator<void, BlaTable> {
  // Reference index zero has X=0, so its perturbation step contains only the
  // nonlinear w^2 term plus d and cannot be represented by a linear BLA.
  // Store entries for reference indices 1..length-2; the shader uses the same
  // index-1 alignment at every merged level.
  const count = Math.max(0, length - 2);
  const refX = new Float64Array(count), refY = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (i % 8192 === 0) yield;
    if (options.sampleWords === 20) {
      const at = (i + 1) * 20;
      refX[i] = (orbit[at] + orbit[at + 1] + orbit[at + 2] + orbit[at + 3]) * 2 ** orbit[at + 4];
      refY[i] = (orbit[at + 5] + orbit[at + 6] + orbit[at + 7] + orbit[at + 8]) * 2 ** orbit[at + 9];
    } else {
      const at = (i + 1) * 6;
      refX[i] = (orbit[at] + orbit[at + 1]) * 2 ** orbit[at + 2];
      refY[i] = (orbit[at + 3] + orbit[at + 4]) * 2 ** orbit[at + 5];
    }
  }

  const maxDeltaLog2 = maxDelta > 0 ? Math.log2(maxDelta) : -Infinity;
  const levels: Step[][] = [[]];
  for (let i = 0; i < count; i++) {
    if (i % 4096 === 0) yield;
    const a = normalise(2 * refX[i], 2 * refY[i], 0);
    const magnitude = log2Magnitude(a);
    levels[0].push({ a, b: ONE, radiusLog2: Number.isFinite(magnitude) ? magnitude + EPSILON_LOG2 : NEVER });
  }

  const maxLevels = options.maxLevels ?? 21;
  for (let level = 1; level < maxLevels; level++) {
    const previous = levels[level - 1], mergedCount = Math.floor(previous.length / 2);
    if (mergedCount < 1) break;
    const merged: Step[] = [];
    for (let i = 0; i < mergedCount; i++) {
      if (i % 2048 === 0) yield;
      const first = previous[2 * i], second = previous[2 * i + 1];
      const injectedLog2 = log2Magnitude(first.b) + maxDeltaLog2;
      let radiusLog2 = NEVER;
      if (injectedLog2 < second.radiusLog2) {
        const remaining = second.radiusLog2 + Math.log2(1 - 2 ** (injectedLog2 - second.radiusLog2));
        radiusLog2 = Math.min(first.radiusLog2, remaining - log2Magnitude(first.a));
      }
      if (!Number.isFinite(radiusLog2)) radiusLog2 = NEVER;
      merged.push({ ...compose(first, second), radiusLog2 });
    }
    levels.push(merged);
  }

  const entryCount = levels.reduce((sum, level) => sum + level.length, 0);
  const data = new Float32Array(Math.max(1, entryCount) * ENTRY_FLOATS);
  const levelOffsets: number[] = [], levelCounts: number[] = [];
  let offset = 0;
  for (const level of levels) {
    levelOffsets.push(offset); levelCounts.push(level.length);
    for (let index = 0; index < level.length; index++) {
      if (index % 4096 === 0) yield;
      const target = (offset + index) * ENTRY_FLOATS, step = level[index];
      const put = (slot: number, value: Scaled) => {
        data[target + slot * 5] = value.x;
        data[target + slot * 5 + 1] = value.x - Math.fround(value.x);
        data[target + slot * 5 + 2] = value.y;
        data[target + slot * 5 + 3] = value.y - Math.fround(value.y);
        data[target + slot * 5 + 4] = value.e;
      };
      put(0, step.a); put(1, step.b); data[target + 10] = step.radiusLog2;
    }
    offset += level.length;
  }
  return { data, levelOffsets, levelCounts, levels: levels.length, entryCount };
}

export function buildBla(orbit: Float32Array, length: number, maxDelta: number, options: BuildOptions = {}): BlaTable {
  const steps = buildBlaSteps(orbit, length, maxDelta, options);
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

export async function buildBlaAsync(orbit: Float32Array, length: number, maxDelta: number, checkpoint: () => Promise<void>, options: BuildOptions = {}): Promise<BlaTable> {
  const steps = buildBlaSteps(orbit, length, maxDelta, options);
  for (;;) { const next = steps.next(); if (next.done) return next.value; await checkpoint(); }
}

export function readStep(table: BlaTable, level: number, index: number): Step {
  const base = (table.levelOffsets[level] + index) * ENTRY_FLOATS;
  const get = (slot: number): Scaled => ({
    x: table.data[base + slot * 5] + table.data[base + slot * 5 + 1],
    y: table.data[base + slot * 5 + 2] + table.data[base + slot * 5 + 3],
    e: table.data[base + slot * 5 + 4],
  });
  return { a: get(0), b: get(1), radiusLog2: table.data[base + 10] };
}

export function applyStep(step: Step, w: Scaled, delta: Scaled): Scaled {
  return add(multiply(step.a, w), multiply(step.b, delta));
}

export function stepRadiusLog2(table: BlaTable, level: number, index: number): number {
  return table.data[(table.levelOffsets[level] + index) * ENTRY_FLOATS + 10];
}
