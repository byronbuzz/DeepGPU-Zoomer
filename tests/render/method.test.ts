import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { binaryExponent, Method, methodForScale, limbsForScale } from "../../src/render/webgpu-renderer";
import { DEFAULT_TUNING } from "../../src/tuning";

const upp = (span: string, height = 1080) => new Decimal(span).div(height);

describe("methodForScale", () => {
  it("normalises exact powers of two and adjacent values at ordinary and upper profiles", () => {
    Decimal.set({ precision: 2600 });
    for (const exponent of [-10, -3953]) {
      const power = new Decimal(2).pow(exponent), epsilon = new Decimal(10).pow(-100);
      expect(binaryExponent(power)).toBe(exponent);
      expect(binaryExponent(power.times(new Decimal(1).minus(epsilon)))).toBe(exponent-1);
      expect(binaryExponent(power.times(new Decimal(1).plus(epsilon)))).toBe(exponent);
    }
  });
  it("keeps enough reference bits for the selected pixel mantissa", () => {
    const spacing = new Decimal("1e-40");
    expect(limbsForScale(spacing)).toBe(8);
    expect(limbsForScale(spacing, 96)).toBe(16);
    expect(limbsForScale(new Decimal("1e-52"), 96)).toBe(16);
  });
  it("iterates c directly when the view is wider than f32 can blur", () => {
    expect(methodForScale(upp("2.8"))).toBe(Method.Direct);
    expect(methodForScale(upp("0.02"))).toBe(Method.Direct);
  });

  it("switches to perturbation before f32 loses the pixel grid", () => {
    // 6e-8 is roughly f32's resolution near |c| ~ 1; direct iteration has to
    // be gone well before the pixel spacing gets there.
    expect(methodForScale(upp("1e-3"))).toBe(Method.Plain);
    expect(methodForScale(upp("6e-6"))).toBe(Method.Plain);
  });

  it("keeps the plain delta across the range where it is fastest", () => {
    expect(methodForScale(upp("1e-8"))).toBe(Method.Plain);
    expect(methodForScale(upp("3e-11"))).toBe(Method.Plain);
    expect(methodForScale(upp("1e-18"))).toBe(Method.Plain);
  });

  it("gives the delta its own exponent well above the f32 floor", () => {
    // A plain f32 denormalises at 1.2e-38; the handover is 13 decades early.
    expect(methodForScale(upp("1e-25"))).toBe(Method.Hdr);
    expect(methodForScale(upp("6e-42"))).toBe(Method.Hdr);
    expect(methodForScale(upp("1e-300"))).toBe(Method.Hdr);
  });

  it("depends on pixel spacing, not span alone", () => {
    // The same span on a taller viewport resolves finer and can need a
    // stronger method.
    expect(methodForScale(new Decimal("1e-2").div(100))).toBe(Method.Direct);
    expect(methodForScale(new Decimal("1e-2").div(100000))).toBe(Method.Plain);
  });

  it("keeps 5183 boundaries by default and moves only the selected crossovers", () => {
    for (const spacing of ["1e-4", "1e-5", "1e-6", "1e-24", "1e-25", "1e-26"])
      expect(methodForScale(new Decimal(spacing), DEFAULT_TUNING)).toBe(methodForScale(new Decimal(spacing)));
    const tuned={...DEFAULT_TUNING,directExponent:8,hdrExponent:20};
    expect(methodForScale(new Decimal("1e-6"),tuned)).toBe(Method.Direct);
    expect(methodForScale(new Decimal("1e-9"),tuned)).toBe(Method.Plain);
    expect(methodForScale(new Decimal("1e-21"),tuned)).toBe(Method.Hdr);
  });
});
