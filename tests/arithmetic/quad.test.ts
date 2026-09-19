import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { fixedToQuad, splitQuad } from "../../src/arithmetic/quad";
import { fractionalBits, fromLimbs, parseFixed } from "../../src/arithmetic/types";

// Decode the actual f32 bits into an independent 512-bit fixed-point value.
function decode(value: number, exponent = 0): bigint {
  if (!value) return 0n;
  const buffer = new ArrayBuffer(4);
  new Float32Array(buffer)[0] = value;
  const bits = new Uint32Array(buffer)[0];
  const n = BigInt((bits & 0x7fffff) | 0x800000);
  const shift = 512 + ((bits >>> 23) & 255) - 150 + exponent;
  return (bits >>> 31 ? -1n : 1n) * (shift >= 0 ? n << BigInt(shift) : n >> BigInt(-shift));
}
const abs = (n: bigint) => n < 0n ? -n : n;

describe("Julia four-component transport", () => {
  it("preserves decimal residuals beyond the Number conversion precision", () => {
    Decimal.set({ precision: 100 });
    for (const text of ["-0.8", "0.156", "1.2345678901234567890123456789012345", "-0.5275031186435346107897464024449153375667459478"]) {
      const value = new Decimal(text);
      const parts = splitQuad(value);
      const reconstructed = [...parts].reduce((sum, part) => sum + decode(part), 0n);
      const expected = BigInt(value.times(new Decimal(2).pow(512)).trunc().toFixed());
      expect(abs(reconstructed - expected) < (1n << 418n)).toBe(true);
      expect(parts[2]).not.toBe(0);
    }
  });

  it("encodes signed and tiny fixed-point samples within one 96-bit truncation unit", () => {
    for (const limbs of [8, 16]) {
      for (const text of ["0", "1", "-2", "0.156", "-0.8", "1.0000000000000000000000000001e-50", "-3.141592653589793238462643383279e-42"]) {
        const words = parseFixed(text, limbs);
        const sample = fixedToQuad(words, limbs);
        const actual = sample.slice(0, 4).reduce((sum, part) => sum + decode(part, sample[4]), 0n);
        const expected = fromLimbs(words, limbs) << (512n - fractionalBits(limbs));
        const tolerance = 1n << BigInt(Math.max(0, 512 + sample[4] - 95));
        expect(abs(actual - expected) < tolerance).toBe(true);
      }
    }
  });
});
