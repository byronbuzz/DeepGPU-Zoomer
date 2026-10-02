import Decimal from "decimal.js";

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
