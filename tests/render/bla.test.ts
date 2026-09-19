import { describe, expect, it } from "vitest";
import {
  BASE_STEP,
  NEVER,
  add,
  applyStep,
  buildBla,
  compose,
  log2Magnitude,
  multiply,
  normalise,
  readStep,
  stepRadiusLog2,
  type Scaled,
} from "../../src/render/bla";

/** Reference orbit samples in the reduced format the GPU emits. */
function makeOrbit(cx: number, cy: number, count: number) {
  const orbit = new Float32Array((count + 1) * 6);
  const xs = [0];
  const ys = [0];
  let x = 0;
  let y = 0;
  for (let i = 1; i <= count; i++) {
    const nx = x * x - y * y + cx;
    y = 2 * x * y + cy;
    x = nx;
    xs.push(x);
    ys.push(y);
  }
  for (let i = 0; i <= count; i++) {
    const hiX = Math.fround(xs[i]);
    const hiY = Math.fround(ys[i]);
    orbit[i * 6 + 0] = hiX;
    orbit[i * 6 + 1] = Math.fround(xs[i] - hiX);
    orbit[i * 6 + 3] = hiY;
    orbit[i * 6 + 4] = Math.fround(ys[i] - hiY);
  }
  return { orbit, xs, ys };
}

/** Exact perturbation iteration — the thing the approximation must reproduce. */
function iterate(
  xs: number[],
  ys: number[],
  from: number,
  steps: number,
  w: Scaled,
  delta: Scaled
): Scaled {
  let z = w;
  for (let k = 0; k < steps; k++) {
    const twoX = normalise(2 * xs[from + k], 2 * ys[from + k], 0);
    z = add(add(multiply(twoX, z), multiply(z, z)), delta);
  }
  return z;
}

function relativeError(a: Scaled, b: Scaled): number {
  const difference = add(a, { x: -b.x, y: -b.y, e: b.e });
  const scale = log2Magnitude(b);
  if (!Number.isFinite(scale)) return 0;
  return 2 ** (log2Magnitude(difference) - scale);
}

// Inside the period-3 bulb: bounded, and |X| varies without ever hitting zero.
const CX = -0.12;
const CY = 0.74;

describe("second-order bilinear approximation", () => {
  it("recovers the first-order coefficients exactly", () => {
    // Adding the quadratic terms must not disturb A and B: they obey their own
    // recurrences and nothing above them feeds back down.
    const { orbit } = makeOrbit(CX, CY, 2048);
    const quadratic = buildBla(orbit, 2049, 1e-30, { quadratic: true });
    const linear = buildBla(orbit, 2049, 1e-30, { quadratic: false });

    for (let level = 0; level < Math.min(quadratic.levels, 5); level++) {
      for (let i = 0; i < Math.min(quadratic.levelCounts[level], 8); i++) {
        const q = readStep(quadratic, level, i);
        const l = readStep(linear, level, i);
        expect(q.a).toEqual(l.a);
        expect(q.b).toEqual(l.b);
      }
    }
  });

  it("populates second-order coefficients only when asked", () => {
    const { orbit } = makeOrbit(CX, CY, 1024);
    const linear = buildBla(orbit, 1025, 1e-30, { quadratic: false });
    const quadratic = buildBla(orbit, 1025, 1e-30, { quadratic: true });

    // Step 1 avoids X_0 = 0, which zeroes everything legitimately.
    expect(log2Magnitude(readStep(linear, 0, 1).c)).toBe(-Infinity);
    expect(log2Magnitude(readStep(quadratic, 0, 1).c)).toBeGreaterThan(-Infinity);
  });

  it("admits a much larger entry radius than the first-order form", () => {
    const { orbit } = makeOrbit(CX, CY, 4096);
    const quadratic = buildBla(orbit, 4097, 1e-30, { quadratic: true });
    const linear = buildBla(orbit, 4097, 1e-30, { quadratic: false });

    let wider = 0;
    let compared = 0;
    for (let i = 1; i < Math.min(quadratic.levelCounts[0], 200); i++) {
      const q = stepRadiusLog2(quadratic, 0, i);
      const l = stepRadiusLog2(linear, 0, i);
      if (q <= NEVER / 2 || l <= NEVER / 2) continue;
      compared++;
      if (q > l + 4) wider++;
    }
    expect(compared).toBeGreaterThan(50);
    // Halving the log2 budget should buy several octaves of radius.
    expect(wider / compared).toBeGreaterThan(0.9);
  });

  it("reproduces exact iteration at its own radius", () => {
    const { orbit, xs, ys } = makeOrbit(CX, CY, 4096);
    const delta = normalise(1e-24, -7e-25, 0);
    const table = buildBla(orbit, 4097, 2e-24, { quadratic: true });

    let checked = 0;
    let worst = 0;
    for (let level = 0; level < Math.min(table.levels, 7); level++) {
      const steps = BASE_STEP << level;
      for (let index = 1; index < Math.min(table.levelCounts[level], 10); index++) {
        const radiusLog2 = stepRadiusLog2(table, level, index);
        if (radiusLog2 <= NEVER / 2) continue;

        // Enter right at the allowed radius: the worst legal case.
        const w = normalise(1, 0.3, Math.round(radiusLog2));
        const approx = applyStep(readStep(table, level, index), w, delta);
        const exact = iterate(xs, ys, index * steps, steps, w, delta);

        worst = Math.max(worst, relativeError(approx, exact));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(worst).toBeLessThan(1e-3);
  });

  it("beats the first-order form at the same entry delta", () => {
    // At a delta the linear form only just tolerates, the quadratic form should
    // be markedly more accurate — that extra accuracy is what buys the radius.
    const { orbit, xs, ys } = makeOrbit(CX, CY, 2048);
    const delta = normalise(1e-24, 0, 0);
    const quadratic = buildBla(orbit, 2049, 2e-24, { quadratic: true });
    const linear = buildBla(orbit, 2049, 2e-24, { quadratic: false });

    const index = 4;
    const radius = stepRadiusLog2(linear, 0, index);
    expect(radius).toBeGreaterThan(NEVER / 2);

    const w = normalise(1, 0.4, Math.round(radius));
    const exact = iterate(xs, ys, index * BASE_STEP, BASE_STEP, w, delta);
    const qError = relativeError(applyStep(readStep(quadratic, 0, index), w, delta), exact);
    const lError = relativeError(applyStep(readStep(linear, 0, index), w, delta), exact);

    expect(qError).toBeLessThan(lError);
  });

  it("composes without overflowing to Infinity", () => {
    const { orbit } = makeOrbit(CX, CY, 8192);
    const table = buildBla(orbit, 8193, 1e-40, { quadratic: true });
    for (let i = 0; i < table.data.length; i++) {
      expect(Number.isFinite(table.data[i])).toBe(true);
    }
    let biggest = 0;
    for (let level = 0; level < table.levels; level++) {
      for (let index = 0; index < table.levelCounts[level]; index++) {
        biggest = Math.max(biggest, Math.abs(readStep(table, level, index).a.e));
      }
    }
    // Beyond anything a double could hold as a plain number.
    expect(biggest).toBeGreaterThan(1100);
  });

  it("composition matches iterating the two halves in turn", () => {
    const { orbit, xs, ys } = makeOrbit(CX, CY, 512);
    const table = buildBla(orbit, 513, 1e-28, { quadratic: true });
    const delta = normalise(1e-28, 0, 0);

    const first = readStep(table, 0, 2);
    const second = readStep(table, 0, 3);
    const merged = { ...compose(first, second), radiusLog2: 0 };

    const w = normalise(1, 0, -70);
    const viaMerged = applyStep(merged, w, delta);
    const viaHalves = applyStep(second, applyStep(first, w, delta), delta);
    expect(relativeError(viaMerged, viaHalves)).toBeLessThan(1e-6);

    const exact = iterate(xs, ys, 2 * BASE_STEP, 2 * BASE_STEP, w, delta);
    expect(relativeError(viaMerged, exact)).toBeLessThan(1e-5);
  });
});
