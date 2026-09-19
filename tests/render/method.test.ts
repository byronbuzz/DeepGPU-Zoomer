import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { Method, methodForScale } from "../../src/render/webgpu-renderer";

const upp = (span: string, height = 1080) => new Decimal(span).div(height);

describe("methodForScale", () => {
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
});
