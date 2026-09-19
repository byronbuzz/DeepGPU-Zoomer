/**
 * Bilinear approximation, to second order.
 *
 * The perturbation step is `w <- 2*X_k*w + w^2 + d`, linear in the delta `w`
 * and in the pixel offset `d` apart from that one quadratic term. Expanding a
 * whole range of iterations as a polynomial in `(w, d)` and truncating gives
 *
 *     w_out = A*w + B*d + C*w^2 + D*w*d + E*d^2
 *
 * Keeping only `A` and `B` is the usual "BLA" — bilinear in the two inputs —
 * and its validity ends where the neglected `w^2` starts to matter. Carrying
 * the second-order coefficients moves that boundary out by roughly the square
 * root of the tolerance, so far more pixels take far longer skips.
 *
 * Per-iteration recurrences, from substituting the expansion into the step:
 *
 *     A' = 2X*A            B' = 2X*B + 1
 *     C' = 2X*C + A^2      D' = 2X*D + 2AB      E' = 2X*E + B^2
 *
 * Composing two ranges substitutes one polynomial into the other and drops
 * anything above second order; see `compose`.
 *
 * Everything carries an explicit binary exponent: `A` over a few thousand
 * iterations reaches 10^700 and would otherwise overflow to Infinity, while
 * the matching radius underflows to zero. Radii are stored as log2.
 */

/** Iterations covered by a level-0 step. */
export const BASE_STEP = 8;

/**
 * How far below `2*|X|` the delta must stay at each iteration.
 *
 * With second-order terms the leading neglected term is cubic, so the same
 * tolerance buys a much larger radius than it did for the linear form.
 */
const TOLERANCE = 2 ** -16;

/**
 * Radius penalty per merge, in log2. Errors accumulate along a step, and a
 * merged step covers twice as many iterations as its halves.
 */
const MERGE_PENALTY_LOG2 = 1;

/** Sentinel log2-radius meaning "this step is never usable". */
export const NEVER = -1e30;

/**
 * Floats per packed entry: five complex coefficients as
 * (xHi, xLo, yHi, yLo, exponent), then radiusLog2 and padding.
 */
export const ENTRY_FLOATS = 32;

export interface BlaTable {
  data: Float32Array;
  levelOffsets: number[];
  levelCounts: number[];
  levels: number;
  entryCount: number;
  /** True when second-order coefficients are populated. */
  quadratic: boolean;
}

/** A complex number as (x, y) * 2^e, mantissa normalised to [1, 2). */
export interface Scaled {
  x: number;
  y: number;
  e: number;
}

export function normalise(x: number, y: number, e: number): Scaled {
  const magnitude = Math.max(Math.abs(x), Math.abs(y));
  if (magnitude === 0 || !Number.isFinite(magnitude)) return { x: 0, y: 0, e: 0 };
  const shift = Math.floor(Math.log2(magnitude));
  const scale = 2 ** -shift;
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

export function scale(a: Scaled, factor: number): Scaled {
  return normalise(a.x * factor, a.y * factor, a.e);
}

export function log2Magnitude(v: Scaled): number {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? -Infinity : v.e + Math.log2(m);
}

const ONE: Scaled = { x: 1, y: 0, e: 0 };
const ZERO: Scaled = { x: 0, y: 0, e: 0 };

/** One skip: the truncated polynomial plus the entry radius it is valid for. */
export interface Step {
  a: Scaled;
  b: Scaled;
  c: Scaled;
  d: Scaled;
  e: Scaled;
  radiusLog2: number;
}

/**
 * Substitutes `first` into `second`, keeping terms up to second order.
 *
 * With `w1 = A1*w + B1*d + C1*w^2 + D1*w*d + E1*d^2`, the composite is
 * `A2*w1 + B2*d + C2*w1^2 + D2*w1*d + E2*d^2`, and `w1^2` only contributes at
 * second order through its own linear part.
 */
export function compose(first: Step, second: Step): Omit<Step, "radiusLog2"> {
  const a1 = first.a;
  const b1 = first.b;
  const a2 = second.a;
  const c2 = second.c;
  const d2 = second.d;

  return {
    a: multiply(a2, a1),
    b: add(multiply(a2, b1), second.b),
    // C = A2*C1 + C2*A1^2
    c: add(multiply(a2, first.c), multiply(c2, multiply(a1, a1))),
    // D = A2*D1 + 2*C2*A1*B1 + D2*A1
    d: add(
      add(multiply(a2, first.d), scale(multiply(c2, multiply(a1, b1)), 2)),
      multiply(d2, a1)
    ),
    // E = A2*E1 + C2*B1^2 + D2*B1 + E2
    e: add(
      add(multiply(a2, first.e), multiply(c2, multiply(b1, b1))),
      add(multiply(d2, b1), second.e)
    ),
  };
}

export interface BuildOptions {
  maxLevels?: number;
  /** Set false to drop the second-order terms, for A/B comparison. */
  quadratic?: boolean;
}

/**
 * Builds the skip table from reference orbit samples.
 *
 * @param orbit reduced samples, 6 floats per entry (hi, lo, exp per component)
 * @param length valid sample count
 * @param maxDelta largest |d| any pixel will use, so radii can account for the
 *   terms `d` injects without knowing the pixel
 */
export function buildBla(
  orbit: Float32Array,
  length: number,
  maxDelta: number,
  options: BuildOptions = {}
): BlaTable {
  const maxLevels = options.maxLevels ?? 14;
  const quadratic = options.quadratic ?? true;

  // Reference samples are O(1), so plain doubles hold them; only the products
  // above need exponents.
  const count = Math.max(0, length - 1);
  const refX = new Float64Array(count + 1);
  const refY = new Float64Array(count + 1);
  for (let i = 0; i <= count; i++) {
    refX[i] = (orbit[i * 6 + 0] + orbit[i * 6 + 1]) * 2 ** orbit[i * 6 + 2];
    refY[i] = (orbit[i * 6 + 3] + orbit[i * 6 + 4]) * 2 ** orbit[i * 6 + 5];
  }

  const maxDeltaLog2 = maxDelta > 0 ? Math.log2(maxDelta) : -Infinity;
  const toleranceLog2 = Math.log2(TOLERANCE);
  const levels: Step[][] = [];

  // ---- level 0 -------------------------------------------------------------
  const level0Count = Math.floor(count / BASE_STEP);
  const level0: Step[] = [];

  for (let s = 0; s < level0Count; s++) {
    const start = s * BASE_STEP;
    let a = ONE;
    let b = ZERO;
    let c = ZERO;
    let d = ZERO;
    let e = ZERO;

    // Linearity has to hold at *every* iteration, not just on entry. At step k
    // the travelling delta is A_k*w + B_k*d (+ higher order), so require the
    // first neglected term to stay below tolerance * |2*X_k|.
    //
    // Without second-order terms the neglected term is quadratic and the bound
    // is on |w| directly. With them it is cubic, so the same tolerance permits
    // an entry radius larger by roughly 1/sqrt(tolerance).
    let radiusLog2 = Infinity;

    for (let k = 0; k < BASE_STEP; k++) {
      const twoXValue = Math.hypot(2 * refX[start + k], 2 * refY[start + k]);
      if (twoXValue === 0) {
        radiusLog2 = NEVER;
        break;
      }

      // Bound on the travelling delta |w_k| at this iteration.
      //
      // Truncating at first order leaves |w_k|^2 against the retained
      // |2*X_k*w_k|, so |w_k| <= tolerance * |2*X_k|. Truncating at second
      // order leaves |w_k|^3, so |w_k| <= sqrt(tolerance * |2*X_k|) — the same
      // tolerance, but a square root larger.
      const linearBound = toleranceLog2 + Math.log2(twoXValue);
      const budgetLog2 = quadratic ? linearBound / 2 : linearBound;

      // Part of that budget is already spent by the B_k*d term, which exists
      // no matter how small the entry delta is.
      const injectedLog2 = log2Magnitude(b) + maxDeltaLog2;
      if (injectedLog2 >= budgetLog2) {
        radiusLog2 = NEVER;
        break;
      }
      const headroomLog2 =
        injectedLog2 === -Infinity
          ? budgetLog2
          : budgetLog2 + Math.log2(1 - 2 ** (injectedLog2 - budgetLog2));

      // w_k = A_k * w, so divide through by |A_k|.
      radiusLog2 = Math.min(radiusLog2, headroomLog2 - log2Magnitude(a));

      const twoX = normalise(2 * refX[start + k], 2 * refY[start + k], 0);
      // Second-order updates use the *previous* A and B, so compute them first.
      const nextC = add(multiply(twoX, c), multiply(a, a));
      const nextD = add(multiply(twoX, d), scale(multiply(a, b), 2));
      const nextE = add(multiply(twoX, e), multiply(b, b));
      a = multiply(twoX, a);
      b = add(multiply(twoX, b), ONE);
      if (quadratic) {
        c = nextC;
        d = nextD;
        e = nextE;
      }
    }

    level0.push({
      a,
      b,
      c,
      d,
      e,
      radiusLog2: Number.isFinite(radiusLog2) ? radiusLog2 : NEVER,
    });
  }
  levels.push(level0);

  // ---- merge pairs ---------------------------------------------------------
  for (let level = 1; level < maxLevels; level++) {
    const previous = levels[level - 1];
    const mergedCount = Math.floor(previous.length / 2);
    if (mergedCount < 1) break;

    const merged: Step[] = [];
    for (let s = 0; s < mergedCount; s++) {
      const first = previous[2 * s];
      const second = previous[2 * s + 1];
      const composed = compose(first, second);

      // Entering the second half the delta has become |A1*w + B1*d|, which has
      // to land inside the second radius, worst case over the largest |d|.
      const b1dLog2 = log2Magnitude(first.b) + maxDeltaLog2;
      let radiusLog2 = NEVER;
      if (b1dLog2 < second.radiusLog2) {
        const headroomLog2 =
          second.radiusLog2 + Math.log2(1 - 2 ** (b1dLog2 - second.radiusLog2));
        const mapped = headroomLog2 - log2Magnitude(first.a);
        radiusLog2 = Math.min(first.radiusLog2, mapped) - MERGE_PENALTY_LOG2;
      }
      if (!Number.isFinite(radiusLog2)) radiusLog2 = NEVER;

      merged.push({ ...composed, radiusLog2 });
    }
    levels.push(merged);
  }

  // ---- pack ----------------------------------------------------------------
  let entryCount = 0;
  for (const level of levels) entryCount += level.length;

  const data = new Float32Array(Math.max(1, entryCount) * ENTRY_FLOATS);
  const levelOffsets: number[] = [];
  const levelCounts: number[] = [];
  let offset = 0;

  for (const level of levels) {
    levelOffsets.push(offset);
    levelCounts.push(level.length);
    level.forEach((step, index) => {
      const target = (offset + index) * ENTRY_FLOATS;
      const put = (slot: number, v: Scaled) => {
        data[target + slot * 5] = v.x;
        data[target + slot * 5 + 1] = v.x - Math.fround(v.x);
        data[target + slot * 5 + 2] = v.y;
        data[target + slot * 5 + 3] = v.y - Math.fround(v.y);
        data[target + slot * 5 + 4] = v.e;
      };
      put(0, step.a);
      put(1, step.b);
      put(2, step.c);
      put(3, step.d);
      put(4, step.e);
      data[target + 25] = step.radiusLog2;
    });
    offset += level.length;
  }

  return {
    data,
    levelOffsets,
    levelCounts,
    levels: levels.length,
    entryCount,
    quadratic,
  };
}

/** Reads a packed entry back, for tests and the CPU mirror. */
export function readStep(table: BlaTable, level: number, index: number): Step {
  const base = (table.levelOffsets[level] + index) * ENTRY_FLOATS;
  const get = (slot: number): Scaled => ({
    x: table.data[base + slot * 5] + table.data[base + slot * 5 + 1],
    y: table.data[base + slot * 5 + 2] + table.data[base + slot * 5 + 3],
    e: table.data[base + slot * 5 + 4],
  });
  return {
    a: get(0),
    b: get(1),
    c: get(2),
    d: get(3),
    e: get(4),
    radiusLog2: table.data[base + 25],
  };
}

/** CPU mirror of the shader's skip, for tests. */
export function applyStep(step: Step, w: Scaled, delta: Scaled): Scaled {
  let out = add(multiply(step.a, w), multiply(step.b, delta));
  out = add(out, multiply(step.c, multiply(w, w)));
  out = add(out, scale(multiply(step.d, multiply(w, delta)), 1));
  out = add(out, multiply(step.e, multiply(delta, delta)));
  return out;
}

export function stepRadiusLog2(
  table: BlaTable,
  level: number,
  index: number
): number {
  return table.data[(table.levelOffsets[level] + index) * ENTRY_FLOATS + 25];
}
