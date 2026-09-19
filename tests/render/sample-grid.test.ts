import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { createSampleGridAnchor, planSampleGrid, sampleGridRemap } from "../../src/render/sample-grid";
import type { FrameView } from "../../src/render/reprojection";

const frame = (spacing = "1", x = "0", y = "0", width = 64, height = 48): FrameView => ({
  centerX: new Decimal(x), centerY: new Decimal(y), unitsPerPixel: new Decimal(spacing), width, height,
});

describe("stable sample grids", () => {
  it("keeps sample coordinates fixed during sub-sample camera movement", () => {
    const view = frame(), anchor = createSampleGridAnchor(view);
    const a = planSampleGrid(view, anchor);
    const b = planSampleGrid(frame("1", ".1", "-.1"), anchor);
    expect(b.firstX.eq(a.firstX)).toBe(true);
    expect(b.firstY.eq(a.firstY)).toBe(true);
    expect(sampleGridRemap(a, b)).toEqual({ offsetX: 0, offsetY: 0, step: 1, denominator: 1 });
  });

  it("plans spacing no coarser than requested, with complete overscan coverage", () => {
    const anchor = createSampleGridAnchor(frame());
    for (const spacing of [".49", ".5", ".99", "1", "1.99", "2"]) {
      const view = frame(spacing, "-2.3", "4.7"), grid = planSampleGrid(view, anchor);
      expect(grid.unitsPerPixel.lte(view.unitsPerPixel)).toBe(true);
      expect(grid.unitsPerPixel.times(2).gt(view.unitsPerPixel)).toBe(true);
      expect(grid.width % 8).toBe(0); expect(grid.height % 8).toBe(0);
      expect(grid.centerX.minus(view.centerX).abs().plus(view.unitsPerPixel.times(view.width / 2))
        .lte(grid.unitsPerPixel.times(grid.width / 2))).toBe(true);
      expect(grid.centerY.minus(view.centerY).abs().plus(view.unitsPerPixel.times(view.height / 2))
        .lte(grid.unitsPerPixel.times(grid.height / 2))).toBe(true);
    }
  });

  it("maps only identical world samples during pan, refinement and coarsening", () => {
    const original = frame(), anchor = createSampleGridAnchor(original);
    const old = planSampleGrid(original, anchor);
    for (const desired of [frame("1", "3", "-2"), frame(".5"), frame("2")]) {
      const next = planSampleGrid(desired, anchor), map = sampleGridRemap(old, next)!;
      expect(map).not.toBeNull();
      let reused = 0, missing = 0;
      for (let y = 0; y < next.height; y++) for (let x = 0; x < next.width; x++) {
        const ox = (map.offsetX + x * map.step) / map.denominator;
        const oy = (map.offsetY + y * map.step) / map.denominator;
        if (!Number.isInteger(ox) || !Number.isInteger(oy) || ox < 0 || oy < 0 || ox >= old.width || oy >= old.height) { missing++; continue; }
        reused++;
        expect(old.firstX.plus(old.unitsPerPixel.times(ox)).eq(next.firstX.plus(next.unitsPerPixel.times(x)))).toBe(true);
        expect(old.firstY.minus(old.unitsPerPixel.times(oy)).eq(next.firstY.minus(next.unitsPerPixel.times(y)))).toBe(true);
      }
      expect(reused).toBeGreaterThan(0); expect(missing).toBeGreaterThan(0);
    }
  });

  it("retains exact deep-coordinate identity without a Number centre conversion", () => {
    const view = frame("1e-52", "-0.527503118643534610789746402444915337566745947811707285339875197003203011", "0.075912178352287867071814194826348046366422194847978022539732593449186891");
    const anchor = createSampleGridAnchor(view), grid = planSampleGrid(view, anchor);
    const map = sampleGridRemap(view, grid);
    expect(map).not.toBeNull();
    expect(map!.denominator).toBe(1);
    expect(anchor.originX.plus(view.unitsPerPixel.times(map!.offsetX)).eq(grid.firstX)).toBe(true);
    expect(anchor.originY.minus(view.unitsPerPixel.times(map!.offsetY)).eq(grid.firstY)).toBe(true);
  });

  it("rejects fractional lattice phases and unsafe remap arithmetic", () => {
    expect(sampleGridRemap(frame(), frame("1", ".25"))).toBeNull();
    expect(sampleGridRemap(frame(), frame(".7"))).toBeNull();
    expect(sampleGridRemap(frame(), frame("1", "1e20"))).toBeNull();
    expect(sampleGridRemap(frame(), frame("2147483648"))).toBeNull();
    expect(sampleGridRemap(frame(), frame("1073741824"))).toBeNull();
  });
});
