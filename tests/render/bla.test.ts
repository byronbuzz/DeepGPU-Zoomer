import { describe, expect, it, vi } from "vitest";
import {
  BASE_STEP,
  ENTRY_FLOATS,
  add,
  applyStep,
  buildBla,
  buildBlaAsync,
  compose,
  log2Magnitude,
  multiply,
  normalise,
  readStep,
  stepRadiusLog2,
  type Scaled,
} from "../../src/render/bla";

function makeOrbit(cx: number, cy: number, count: number) {
  const orbit = new Float32Array((count + 1) * 6);
  const xs = [0], ys = [0];
  let x = 0, y = 0;
  for (let i = 1; i <= count; i++) {
    const nextX = x * x - y * y + cx;
    y = 2 * x * y + cy;
    x = nextX;
    xs.push(x); ys.push(y);
  }
  for (let i = 0; i <= count; i++) {
    const xHi = Math.fround(xs[i]), yHi = Math.fround(ys[i]);
    orbit[i * 6] = xHi; orbit[i * 6 + 1] = Math.fround(xs[i] - xHi);
    orbit[i * 6 + 3] = yHi; orbit[i * 6 + 4] = Math.fround(ys[i] - yHi);
  }
  return { orbit, xs, ys };
}

function iterate(xs: number[], ys: number[], from: number, steps: number, w: Scaled, delta: Scaled) {
  let current = w;
  for (let k = 0; k < steps; k++) {
    const twiceReference = normalise(2 * xs[from + k], 2 * ys[from + k], 0);
    current = add(add(multiply(twiceReference, current), multiply(current, current)), delta);
  }
  return current;
}

function relativeError(actual: Scaled, expected: Scaled) {
  const difference = add(actual, { x: -expected.x, y: -expected.y, e: expected.e });
  return 2 ** (log2Magnitude(difference) - log2Magnitude(expected));
}

describe("standard linear BLA", () => {
  it("builds cooperatively and propagates cancellation", async () => {
    const orbit = new Float32Array(10001 * 6);
    for (let i = 0; i < 10001; i++) { orbit[i * 6] = 0.3; orbit[i * 6 + 3] = 0.4; }
    let checkpoints = 0;
    const table = await buildBlaAsync(orbit, 10001, 1e-20, async () => { checkpoints++; });
    expect(table).toEqual(buildBla(orbit, 10001, 1e-20));
    expect(checkpoints).toBeGreaterThan(1);
    await expect(buildBlaAsync(orbit, 10001, 1e-20, async () => { throw Error("cancelled"); }))
      .rejects.toThrow("cancelled");
  });

  it("keeps fixed checkpoints when off and adds time checkpoints only when enabled", async () => {
    const orbit = new Float32Array(257 * 6);
    for (let i = 0; i < 257; i++) { orbit[i * 6] = 0.3; orbit[i * 6 + 3] = 0.4; }
    let fixedCheckpoints = 0, offCheckpoints = 0, timedCheckpoints = 0;
    const fixed = await buildBlaAsync(orbit, 257, 1e-20, async () => { fixedCheckpoints++; });
    const off = await buildBlaAsync(orbit, 257, 1e-20, async () => { offCheckpoints++; }, {}, () => 0);
    expect(offCheckpoints).toBe(fixedCheckpoints);
    expect(off).toEqual(fixed);

    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => ++clock);
    try {
      const timed = await buildBlaAsync(orbit, 257, 1e-20, async () => { timedCheckpoints++; }, {}, () => 1);
      expect(timedCheckpoints).toBeGreaterThan(fixedCheckpoints);
      expect(timed).toEqual(fixed);
    } finally {
      now.mockRestore();
    }
  });

  it("starts at reference index one and packs only A, B and radius", () => {
    const orbit = new Float32Array(3 * 20);
    orbit[20] = 0.5;
    orbit[22] = 2 ** -49;
    const table = buildBla(orbit, 3, 0, { sampleWords: 20 });
    expect(BASE_STEP).toBe(1);
    expect(ENTRY_FLOATS).toBe(12);
    expect(table.levelCounts[0]).toBe(1);
    const first = readStep(table, 0, 0);
    expect(first.a.x * 2 ** first.a.e).toBe(1 + 2 ** -48);
    expect(first.b).toEqual({ x: 1, y: 0, e: 0 });
  });

  it("keeps the Julia radius override separate from the default policy", () => {
    const orbit = new Float32Array(3 * 20);
    orbit[20] = 0.5;
    const standard = buildBla(orbit, 3, 0, { sampleWords: 20 });
    const julia = buildBla(orbit, 3, 0, { sampleWords: 20, epsilonLog2: -40 });
    expect(readStep(standard, 0, 0).radiusLog2).toBe(-21);
    expect(readStep(julia, 0, 0).radiusLog2).toBe(-40);
  });

  it("distinguishes a table with no shader-usable multi-step entries", () => {
    const orbit = new Float32Array(65 * 6);
    for (let i = 0; i < 65; i++) orbit[i * 6] = 0.3;
    const wideDomain = buildBla(orbit, 65, 1);
    const narrowDomain = buildBla(orbit, 65, 1e-30);
    expect(wideDomain.entryCount).toBeGreaterThan(0);
    expect(wideDomain.levels).toBeGreaterThan(1);
    expect(wideDomain.hasUsableMultiStep).toBe(false);
    expect(narrowDomain.hasUsableMultiStep).toBe(true);
  });

  it("composes adjacent index-one-aligned ranges", () => {
    const { orbit } = makeOrbit(-0.12, 0.74, 64);
    const table = buildBla(orbit, 65, 1e-30);
    const first = readStep(table, 0, 0);
    const second = readStep(table, 0, 1);
    const merged = readStep(table, 1, 0);
    const composed = compose(first, second);
    expect(relativeError(merged.a, composed.a)).toBeLessThan(1e-14);
    expect(relativeError(merged.b, composed.b)).toBeLessThan(1e-14);
  });

  it("matches the full recurrence well inside a stored validity radius", () => {
    const { orbit, xs, ys } = makeOrbit(-0.12, 0.74, 4096);
    const delta = normalise(1e-30, -7e-31, 0);
    const table = buildBla(orbit, 4097, 2e-30);
    let checked = 0;
    for (let level = 0; level < Math.min(8, table.levels); level++) {
      const steps = 1 << level;
      for (let index = 0; index < Math.min(8, table.levelCounts[level]); index++) {
        const step = readStep(table, level, index);
        if (step.radiusLog2 < -1e20) continue;
        const w = normalise(1, 0.25, Math.floor(step.radiusLog2) - 12);
        const approximate = applyStep(step, w, delta);
        const exact = iterate(xs, ys, 1 + index * steps, steps, w, delta);
        expect(relativeError(approximate, exact)).toBeLessThan(5e-5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("keeps every packed table value finite at long ranges", () => {
    const { orbit } = makeOrbit(-0.12, 0.74, 8192);
    const table = buildBla(orbit, 8193, 1e-40);
    expect(Array.from(table.data).every(Number.isFinite)).toBe(true);
    expect(table.levels).toBeGreaterThan(10);
  });

  it("stores every parent radius no larger than its same-start child radius", () => {
    const { orbit } = makeOrbit(-0.12, 0.74, 4096);
    for (const epsilonLog2 of [-21, -40]) {
      for (const maxDelta of [1e-20, 1e-40, 1]) {
        const table = buildBla(orbit, 4097, maxDelta, { epsilonLog2 });
        for (let level = 1; level < table.levels; level++) {
          for (let index = 0; index < table.levelCounts[level]; index++) {
            const parent = stepRadiusLog2(table, level, index);
            const sameStartChild = stepRadiusLog2(table, level - 1, index * 2);
            expect(Number.isFinite(parent)).toBe(true);
            expect(parent).toBeLessThanOrEqual(sameStartChild);
          }
        }
      }
    }
  });

  it("keeps the largest valid skip at radius equality and across eligibility boundaries", () => {
    const { orbit } = makeOrbit(-0.12, 0.74, 256);
    const cutoff = -1e29;
    const choice = (table: ReturnType<typeof buildBla>, at: number, remaining: number, dzLog2: number, guarded: boolean) => {
      const unit = at - 1;
      let top = table.levels - 1;
      if (unit !== 0) top = Math.min(top, 31 - Math.clz32(unit & -unit));
      if (guarded) {
        if (top < 1 || remaining < 2 || (unit >> 1) >= table.levelCounts[1]) return 0;
        const shortest = stepRadiusLog2(table, 1, unit >> 1);
        if (shortest <= cutoff || dzLog2 > shortest) return 0;
      }
      for (let level = top; level >= 1; level--) {
        const index = unit >> level;
        if (index >= table.levelCounts[level] || (1 << level) > remaining) continue;
        const radius = stepRadiusLog2(table, level, index);
        if (radius > cutoff && dzLog2 <= radius) return 1 << level;
      }
      return 0;
    };
    for (const epsilonLog2 of [-21, -40]) {
      for (const maxDelta of [1e-40, 1]) {
        const table = buildBla(orbit, 257, maxDelta, { epsilonLog2 });
        for (let at = 1; at < 256; at++) {
          const shortestIndex = (at - 1) >> 1;
          const shortest = shortestIndex < table.levelCounts[1] ? stepRadiusLog2(table, 1, shortestIndex) : cutoff;
          for (const remaining of [0, 1, 2, 3, 8, 64]) {
            for (const dzLog2 of [shortest - 1, shortest, shortest + 1, cutoff, Infinity]) {
              expect(choice(table, at, remaining, dzLog2, true))
                .toBe(choice(table, at, remaining, dzLog2, false));
            }
          }
        }
      }
    }
  });
});
