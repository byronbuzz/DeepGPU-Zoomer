import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { buildBla, buildBlaAsync, deltaBoundLog2, stepRadiusLog2 } from "../../src/render/bla";
import { approximationDeltaBound, referenceViewportRadius } from "../../src/render/webgpu-renderer";
import { rotationBasis } from "../../src/rotation";

const zero = new Decimal(0);
const spans = ["1e-3", "1e-100", "1e-307", "1e-308", "5e-324", "2e-324", "1e-1000", "1e-2400"];
const view = (span: string, angle = 0) => ({
  centerX: zero, centerY: zero, unitsPerPixel: new Decimal(span).div(2), width: 2, height: 2, angle,
});

describe("BLA viewport radius range", () => {
  it("preserves ordinary tables and converts deep bounds conservatively without binary64 underflow", () => {
    const D = Decimal.clone({ precision: 40 });
    const orbit = new Float32Array(66 * 6);
    for (let i = 0; i < 66; i++) orbit[i * 6] = 1;
    for (const span of spans) {
      const value = new Decimal(span), log = deltaBoundLog2(value);
      expect(Number.isFinite(log)).toBe(true);
      if (value.gte(new Decimal(2).pow(-1022))) {
        expect(buildBla(orbit, 66, value)).toEqual(buildBla(orbit, 66, value.toNumber()));
      } else {
        const oracle = new D(span).log(2);
        expect(new D(log).gte(oracle)).toBe(true);
        expect(new D(log).minus(oracle).toNumber()).toBeLessThan(1e-10);
      }
    }
    expect(deltaBoundLog2(new Decimal(0))).toBe(-Infinity);
  });
  it.each(spans)("retains the nonzero far-corner radius at span %s", span => {
    const radius = new Decimal(referenceViewportRadius(view(span), zero, zero));
    const expected = new Decimal(span).times(new Decimal(2).sqrt()).div(2);
    expect(radius.gt(0)).toBe(true);
    expect(radius.div(expected).minus(1).abs().toNumber()).toBeLessThan(1e-15);
  });

  it.each(["1e-3", "2e-324", "1e-1000", "1e-2400"])("covers rotated corners and reference offsets at span %s", span => {
    for (const angle of [0, 37, 90, 180]) {
      const request = { ...view(span, angle), centerX: new Decimal(span).times(3), centerY: new Decimal(span).times(-2) };
      const radius = new Decimal(referenceViewportRadius(request, zero, zero));
      const { c, s } = rotationBasis(angle);
      for (const x of [-1, 1]) for (const y of [-1, 1]) {
        const dx = request.centerX.plus(request.unitsPerPixel.times(x * c)).minus(request.unitsPerPixel.times(y * s));
        const dy = request.centerY.plus(request.unitsPerPixel.times(x * s)).plus(request.unitsPerPixel.times(y * c));
        const distance = Decimal.hypot(dx, dy);
        expect(radius.div(distance).toNumber()).toBeGreaterThanOrEqual(1 - 1e-15);
      }
    }
  });

  it.each(spans)("keeps amplified parameter injection in merged bounds at span %s", async span => {
    // Synthetic A=2 orbit isolates the bound: B grows as 2^n-1. Even a
    // sub-binary64 delta eventually exhausts the second block's valid radius.
    const orbit = new Float32Array(16386 * 20);
    for (let i = 0; i < 16386; i++) orbit[i * 20] = 1;
    const delta = approximationDeltaBound("mandelbrot", view(span), zero, zero);
    const table = buildBla(orbit, 16386, delta, { sampleWords: 20 });
    const noInjection = buildBla(orbit, 16386, 0, { sampleWords: 20 });
    expect(stepRadiusLog2(table, table.levels - 1, 0)).toBeLessThan(-1e29);
    expect(stepRadiusLog2(noInjection, noInjection.levels - 1, 0)).toBeGreaterThan(-1e29);
    for (let level = 1; level < table.levels; level++) {
      for (let index = 0; index < table.levelCounts[level]; index++) {
        expect(stepRadiusLog2(table, level, index)).toBeLessThanOrEqual(stepRadiusLog2(table, level - 1, index * 2));
        expect(stepRadiusLog2(table, level, index)).toBeLessThanOrEqual(stepRadiusLog2(noInjection, level, index));
      }
    }
    expect(Array.from(table.data).every(Number.isFinite)).toBe(true);
    expect(await buildBlaAsync(orbit, 16386, delta, async () => {}, { sampleWords: 20 })).toEqual(table);
  });

  it("preserves Julia zero injection at extreme depth and its separate tolerance", () => {
    const orbit = new Float32Array(10 * 20);
    for (let i = 0; i < 10; i++) orbit[i * 20] = 1;
    for (const span of spans) {
      const delta = approximationDeltaBound("julia", view(span), zero, zero);
      expect(new Decimal(delta).isZero()).toBe(true);
      expect(buildBla(orbit, 10, delta, { sampleWords: 20, epsilonLog2: -40 }))
        .toEqual(buildBla(orbit, 10, 0, { sampleWords: 20, epsilonLog2: -40 }));
    }
  });
});
