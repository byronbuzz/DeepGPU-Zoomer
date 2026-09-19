import Decimal from "decimal.js";
import { fractionalBits, fromLimbs } from "./types";

/** The exact binary value, avoiding Number.toString rounding the residual. */
function exactFloat(value: number): Decimal {
  if (value === 0) return new Decimal(0);
  const bytes = new DataView(new ArrayBuffer(4));
  bytes.setFloat32(0, value);
  const bits = bytes.getUint32(0);
  const exponent = (bits >>> 23) & 255;
  const significand = (bits & 0x7fffff) + (exponent ? 0x800000 : 0);
  return new Decimal(significand).times(new Decimal(2).pow((exponent || 1) - 150))
    .times(bits >>> 31 ? -1 : 1);
}

/** Four non-overlapping f32 components, largest first. Input is normalized. */
export function splitQuad(value: Decimal): Float32Array {
  const result = new Float32Array(4);
  let remainder = value;
  for (let i = 0; i < 4; i++) {
    result[i] = Math.fround(remainder.toNumber());
    remainder = remainder.minus(exactFloat(result[i]));
  }
  return result;
}

/** Same 96-bit chunk encoding as orbit.wgsl's wide sample emitter. */
export function fixedToQuad(words: ArrayLike<number>, limbs: number): number[] {
  const value = fromLimbs(words, limbs);
  if (value === 0n) return [0, 0, 0, 0, 0];
  const magnitude = value < 0n ? -value : value;
  const bits = magnitude.toString(2).length;
  const sign = value < 0n ? -1 : 1;
  const components = [0, 1, 2, 3].map(i => {
    const shift = bits - 24 * (i + 1);
    const chunk = (shift >= 0 ? magnitude >> BigInt(shift) : magnitude << BigInt(-shift)) & 0xffffffn;
    return sign * Number(chunk) * 2 ** (1 - 24 * (i + 1));
  });
  return [...components, bits - 1 - Number(fractionalBits(limbs))];
}
