import { describe, expect, it } from "vitest";
import { generatePackedReference } from "../../src/render/reference-orbit";

const mandelbrot = (overrides: Partial<Parameters<typeof generatePackedReference>[0]> = {}) => ({
  family: "mandelbrot" as const, centerX: "0", centerY: "0", juliaX: "-0.8", juliaY: "0.156",
  limbs: 8, maxIterations: 8, ...overrides,
});
describe("packed CPU reference orbit", () => {
  it("preserves sample zero and a capped Mandelbrot orbit", () => {
    const result = generatePackedReference(mandelbrot({ maxIterations: 3 }));
    expect(result).toMatchObject({ length: 4, escaped: false, escapeIndex: 0 });
    expect(Array.from(new Float32Array(result.buffer).slice(0, 20))).toEqual(Array(20).fill(0));
  });

  it("uses the GPU f32 bailout predicate and emits the escaping sample", () => {
    const result = generatePackedReference(mandelbrot({ centerX: "16", centerY: "1e-30", maxIterations: 3 }));
    expect(result).toMatchObject({ length: 3, escaped: true, escapeIndex: 2 });
  });

  it("retains an ordinary early escape", () => {
    expect(generatePackedReference(mandelbrot({ centerX: "17", maxIterations: 3 })))
      .toMatchObject({ length: 2, escaped: true, escapeIndex: 1 });
  });

  it("packs Julia absolute and wrapped origin-relative samples", () => {
    const result = generatePackedReference({
      family: "julia", centerX: "-0.5", centerY: "0.25", juliaX: "-0.8", juliaY: "0.156",
      limbs: 8, maxIterations: 1,
    });
    const words = new Float32Array(result.buffer);
    expect(Array.from(words.slice(10, 20))).toEqual(Array(10).fill(0));
    expect(Array.from(words.slice(20, 30))).not.toEqual(Array.from(words.slice(30, 40)));
  });

  it("keeps every bounded iteration limit and supported precision profile", () => {
    for (const maxIterations of [1, 255, 256, 257, 511, 512, 513]) {
      expect(generatePackedReference(mandelbrot({ maxIterations })).length).toBe(maxIterations + 1);
    }
    for (const limbs of [8, 16, 32, 64, 128, 256]) {
      expect(generatePackedReference(mandelbrot({ limbs, maxIterations: 1 })).length).toBe(2);
    }
    expect(() => generatePackedReference(mandelbrot({ limbs: 512 }))).toThrow(/Unsupported reference precision/);
  });

  it("does not pre-bail an initially exterior Julia reference", () => {
    const result = generatePackedReference({
      family: "julia", centerX: "17", centerY: "0", juliaX: "0", juliaY: "0",
      limbs: 8, maxIterations: 2,
    });
    expect(result).toMatchObject({ length: 2, escaped: true, escapeIndex: 1 });
  });
});
