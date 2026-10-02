/**
 * Fixed-point big numbers for the Mandelbrot reference orbit.
 *
 * A value is stored as a two's-complement integer spread over `limbs` u32
 * words, little-endian, scaled by `2^-(32 * (limbs - 1))`. The top limb holds
 * the sign and the integer part. The reference generator checks escape
 * before a value can exceed this fixed-point range.
 *
 * The reference worker uses BigInt arithmetic for fixed-point calculations.
 */

export const LIMB_BITS = 32n;
export const LIMB_MASK = (1n << LIMB_BITS) - 1n;

/** Fractional bits held by a value of the given width. */
export function fractionalBits(limbs: number): bigint {
  return LIMB_BITS * BigInt(limbs - 1);
}

/** Total bit width, including the integer/sign limb. */
export function totalBits(limbs: number): bigint {
  return LIMB_BITS * BigInt(limbs);
}

/** Wraps a signed BigInt into the two's-complement range for `limbs` words. */
export function wrapSigned(value: bigint, limbs: number): bigint {
  const modulus = 1n << totalBits(limbs);
  const wrapped = ((value % modulus) + modulus) % modulus;
  return wrapped >= modulus >> 1n ? wrapped - modulus : wrapped;
}

/** Packs a scaled integer (value × 2^F) into little-endian u32 limbs. */
export function toLimbs(scaled: bigint, limbs: number): Uint32Array {
  const modulus = 1n << totalBits(limbs);
  let raw = ((scaled % modulus) + modulus) % modulus;
  const out = new Uint32Array(limbs);
  for (let i = 0; i < limbs; i++) {
    out[i] = Number(raw & LIMB_MASK);
    raw >>= LIMB_BITS;
  }
  return out;
}

/** Reads limbs back as a signed scaled integer. */
export function fromLimbs(words: ArrayLike<number>, limbs: number): bigint {
  let raw = 0n;
  for (let i = limbs - 1; i >= 0; i--) {
    raw = (raw << LIMB_BITS) | BigInt(words[i] >>> 0);
  }
  return wrapSigned(raw, limbs);
}

/**
 * Parses a decimal string into fixed-point limbs, rounding to nearest.
 * Accepts plain and exponential notation, e.g. `-0.7451` or `1.706e-12`.
 */
export function parseFixed(text: string, limbs: number): Uint32Array {
  return toLimbs(scaleDecimal(text, fractionalBits(limbs)), limbs);
}

/** Converts a decimal string to `round(value × 2^bits)` exactly. */
export function scaleDecimal(text: string, bits: bigint): bigint {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`Not a decimal number: ${text}`);

  const [, sign, whole = "", fraction = "", exponent] = match;
  const digits = `${whole}${fraction}` || "0";
  // value = digits × 10^(exp - fraction.length)
  const power = BigInt(exponent ?? "0") - BigInt(fraction.length);

  let numerator = BigInt(digits) << bits;
  let denominator = 1n;
  if (power >= 0n) numerator *= 10n ** power;
  else denominator = 10n ** -power;

  // Round to nearest, ties away from zero.
  const scaled = (2n * numerator + denominator) / (2n * denominator);
  return sign === "-" ? -scaled : scaled;
}
