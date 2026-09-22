import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { referenceViewportRadius } from "../../src/render/webgpu-renderer";

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
    expect(target).toBeLessThan(initial);
  });

  it("still detects a real viewport expansion", () => {
    const initial = radius(refX, refY, new Decimal(1));
    expect(radius(refX, refY, new Decimal(1.01))).toBeGreaterThan(initial);
  });
});
