import { describe, expect, it } from "vitest";
import { fixedToQuad } from "../../src/arithmetic/quad";
import { fractionalBits, toLimbs, totalBits, wrapSigned } from "../../src/arithmetic/types";
import {
  fixedBigIntToQuad,
  generatePackedReference,
  gpuReferenceEscaped,
  gpuReferenceEscapedFixed,
} from "../../src/render/reference-orbit";

const mandelbrot = (overrides: Partial<Parameters<typeof generatePackedReference>[0]> = {}) => ({
  family: "mandelbrot" as const, centerX: "0", centerY: "0", juliaX: "-0.8", juliaY: "0.156",
  limbs: 8, maxIterations: 8, ...overrides,
});
describe("packed CPU reference orbit", () => {
  it("directly packs boundary values with the legacy 96-bit encoding", () => {
    for (const limbs of [8, 16, 32, 64, 128, 256]) {
      const width = totalBits(limbs), maximum = (1n << (width - 1n)) - 1n, minimum = -(1n << (width - 1n));
      const positions = [0n, 1n, 22n, 23n, 24n, 25n, 47n, 48n, 71n, 72n, 95n, 96n,
        fractionalBits(limbs) - 1n, fractionalBits(limbs), fractionalBits(limbs) + 1n];
      const values = new Set<bigint>([0n, 1n, -1n, maximum, minimum]);
      for (const position of positions) {
        if (position < width - 1n) {
          const value = wrapSigned((1n << position) | 0xabcdefn, limbs);
          values.add(value); values.add(wrapSigned(-value, limbs));
        }
      }
      for (const value of values) {
        const legacy = new Float32Array(fixedToQuad(toLimbs(value, limbs), limbs));
        const direct = fixedBigIntToQuad(value, limbs);
        expect(Array.from(new Uint32Array(direct.buffer))).toEqual(Array.from(new Uint32Array(legacy.buffer)));
      }
    }
  });

  it("extracts the bailout top words without materialising every limb", () => {
    for (const limbs of [8, 16, 32, 64, 128, 256]) {
      const one = 1n << fractionalBits(limbs);
      const coordinates = [0n, 1n, -1n, 15n * one, 16n * one + 1n, -16n * one - 1n, 17n * one];
      for (const x of coordinates) for (const y of coordinates) {
        expect(gpuReferenceEscapedFixed(x, y, limbs))
          .toBe(gpuReferenceEscaped(toLimbs(x, limbs), toLimbs(y, limbs), limbs));
      }
    }
  });

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
