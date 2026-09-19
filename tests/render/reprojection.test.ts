import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { reprojectionFor, type FrameView } from "../../src/render/reprojection";

/** A view, described the way the renderer describes one. */
const frame = (
  span: string,
  width = 1200,
  height = 800,
  cx = "0",
  cy = "0"
): FrameView => ({
  centerX: new Decimal(cx),
  centerY: new Decimal(cy),
  unitsPerPixel: new Decimal(span).div(height),
  width,
  height,
});

describe("reprojectionFor", () => {
  it("is the identity when nothing has changed", () => {
    const r = reprojectionFor(frame("2.8"), frame("2.8"))!;
    expect(r.scale).toBeCloseTo(1, 10);
    expect(r.offsetX).toBeCloseTo(0, 10);
    expect(r.offsetY).toBeCloseTo(0, 10);
  });

  it("is the identity when only the resolution changed", () => {
    // The regression that caused the zoom bounce. Interaction renders at a
    // quarter scale, which changes units-per-pixel fourfold while the view
    // stays exactly where it was; reading that as a zoom scaled the previous
    // frame by four at the start of every gesture and back again at the end.
    const full = frame("2.8", 1200, 800);
    const quarter = frame("2.8", 300, 200);
    const r = reprojectionFor(full, quarter)!;
    expect(r.scale).toBeCloseTo(1, 10);
    expect(r.offsetX).toBeCloseTo(0, 10);
    expect(r.offsetY).toBeCloseTo(0, 10);

    // And back the other way, which is the end of the gesture.
    const back = reprojectionFor(quarter, full)!;
    expect(back.scale).toBeCloseTo(1, 10);
  });

  it("halves the scale when the view zooms in twofold", () => {
    const r = reprojectionFor(frame("2.8"), frame("1.4"))!;
    expect(r.scale).toBeCloseTo(0.5, 10);
    // The centre of the screen still samples the centre of the old frame.
    expect(r.offsetX + r.scale * 0.5).toBeCloseTo(0.5, 10);
  });

  it("zooming in at a different resolution still reads as one zoom", () => {
    const r = reprojectionFor(frame("2.8", 1200, 800), frame("1.4", 300, 200))!;
    expect(r.scale).toBeCloseTo(0.5, 10);
  });

  it("maps a pan of half a screen to half a frame of offset", () => {
    const before = frame("2.8", 1200, 800, "0", "0");
    // Width spans 2.8 * 1200/800 = 4.2, so half a screen right is 2.1.
    const after = frame("2.8", 1200, 800, "2.1", "0");
    const r = reprojectionFor(before, after)!;
    expect(r.scale).toBeCloseTo(1, 10);
    expect(r.offsetX).toBeCloseTo(0.5, 10);
  });

  it("negates y, because the screen and the imaginary axis disagree", () => {
    const before = frame("2.8", 1200, 800, "0", "0");
    const after = frame("2.8", 1200, 800, "0", "1.4");
    const r = reprojectionFor(before, after)!;
    expect(r.offsetY).toBeCloseTo(-0.5, 10);
  });

  it("declines when there is too little overlap to be worth reusing", () => {
    expect(reprojectionFor(frame("2.8"), frame("0.01"))).toBeNull();
    expect(reprojectionFor(frame("2.8"), frame("1000"))).toBeNull();
    expect(
      reprojectionFor(frame("2.8", 1200, 800, "0", "0"), frame("2.8", 1200, 800, "500", "0"))
    ).toBeNull();
  });

  it("declines when the aspect ratio changed", () => {
    expect(reprojectionFor(frame("2.8", 1200, 800), frame("2.8", 800, 800))).toBeNull();
  });

  it("survives depths far outside double range", () => {
    const deep = reprojectionFor(frame("1e-300"), frame("5e-301"))!;
    expect(deep.scale).toBeCloseTo(0.5, 6);
    // 1e-600 underflows a double to zero; the maths runs in Decimal.
    const deeper = reprojectionFor(frame("1e-600"), frame("5e-601"))!;
    expect(deeper.scale).toBeCloseTo(0.5, 6);
  });
});
