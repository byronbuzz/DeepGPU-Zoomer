import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { approximationDeltaBound, approximationEligible, referenceViewportRadius } from "../../src/render/webgpu-renderer";
import wideShader from "../../src/render/wide.wgsl?raw";

describe("reference viewport radius", () => {
  const width = 192, height = 128;
  const refX = new Decimal(0), refY = new Decimal(0);
  const radius = (centerX: Decimal, centerY: Decimal, unitsPerPixel: Decimal) =>
    referenceViewportRadius({ centerX, centerY, unitsPerPixel, width, height }, refX, refY);

  it("keeps a corner-focused inward zoom inside its existing domain", () => {
    const initial = radius(refX, refY, new Decimal(1));
    const scale = new Decimal(Math.exp(-0.035));
    const target = radius(
      new Decimal(1).minus(scale).times(90),
      new Decimal(1).minus(scale).times(57),
      scale,
    );
    expect(target.lt(initial)).toBe(true);
  });

  it("still detects a real viewport expansion", () => {
    const initial = radius(refX, refY, new Decimal(1));
    expect(radius(refX, refY, new Decimal(1.01)).gt(initial)).toBe(true);
  });

  it("uses zero parameter injection for Julia while retaining its initial offset", () => {
    const view = { centerX: new Decimal(2), centerY: new Decimal(3), unitsPerPixel: new Decimal(0.01), width, height };
    expect(approximationDeltaBound("julia", view, refX, refY).isZero()).toBe(true);
    expect(approximationDeltaBound("mandelbrot", view, refX, refY).gt(0)).toBe(true);
    expect(wideShader).toContain("var delta = injection;");
    expect(wideShader).toMatch(/if \(JULIA\) \{ parameterDelta = Wide\(vec4<f32>\(0\.0\), vec4<f32>\(0\.0\), 0\); \}/);
    expect(wideShader).toContain("wantDerivative, parameterDelta, u.maxIterations - n");
  });

  it("keeps Julia distance and diagnostic modes off the skip path", () => {
    expect(approximationEligible("julia", 0)).toBe(true);
    expect(approximationEligible("julia", 1)).toBe(false);
    expect(approximationEligible("julia", 2)).toBe(false);
    expect(approximationEligible("mandelbrot", 1)).toBe(true);
    expect(approximationEligible("mandelbrot", 2)).toBe(false);
    expect(wideShader).toContain("APPROX && (!JULIA || u.mode == 0u)");
  });
});
