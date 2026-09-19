/**
 * Fixed-point big numbers for the Mandelbrot reference orbit.
 *
 * A value is stored as a two's-complement integer spread over `limbs` u32
 * words, little-endian, scaled by `2^-(32 * (limbs - 1))`. The top limb holds
 * the sign and the integer part, which only ever needs to represent values in
 * (-4, 4) — anything larger means the orbit has escaped.
 *
 * Every operation here has a `BigInt` implementation so the GPU shaders can be
 * checked against an exact oracle.
 */

export const LIMB_BITS = 32n;
export const LIMB_MASK = (1n << LIMB_BITS) - 1n;

/** Supported precision profiles, in u32 limbs. */
export const LIMB_PROFILES = [8, 16, 32, 64, 128, 256, 512, 1024] as const;
export type LimbCount = (typeof LIMB_PROFILES)[number];

/** Fractional bits held by a value of the given width. */
export function fractionalBits(limbs: number): bigint {
  return LIMB_BITS * BigInt(limbs - 1);
}

/** Total bit width, including the integer/sign limb. */
export function totalBits(limbs: number): bigint {
  return LIMB_BITS * BigInt(limbs);
}

/** Roughly how many decimal digits this profile resolves. */
export function decimalDigits(limbs: number): number {
  return Math.floor(Number(fractionalBits(limbs)) * Math.LOG10E * Math.LN2);
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

/**
 * Largest magnitude the format can hold: the integer part is the top limb, so
 * anything from 2^31 upwards wraps. The orbit never approaches this — it bails
 * out at |z| = 2 — but conversions should not be handed values outside it.
 */
export function maxMagnitude(): number {
  return 2 ** 31;
}

/** Exact conversion of fixed-point limbs to the nearest double. */
export function fixedToNumber(words: ArrayLike<number>, limbs: number): number {
  const scaled = fromLimbs(words, limbs);
  if (scaled === 0n) return 0;

  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  // Shift down to ~64 significant bits before touching a double, so the
  // intermediate never overflows for wide profiles.
  const bitLength = magnitude.toString(2).length;
  const shift = BigInt(Math.max(0, bitLength - 64));
  const top = Number(magnitude >> shift);
  const exponent = Number(shift - fractionalBits(limbs));
  const value = top * 2 ** exponent;
  return negative ? -value : value;
}

/** Renders fixed-point limbs as a decimal string with `digits` places. */
export function formatFixed(
  words: ArrayLike<number>,
  limbs: number,
  digits = 40
): string {
  const scaled = fromLimbs(words, limbs);
  const bits = fractionalBits(limbs);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;

  const whole = magnitude >> bits;
  const remainder = magnitude - (whole << bits);
  const fraction = ((remainder * 10n ** BigInt(digits)) >> bits)
    .toString()
    .padStart(digits, "0");

  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * The reduced sample format handed to the perturbation renderer: a double-float
 * mantissa plus a binary exponent, so the tiny magnitudes that appear at deep
 * zoom survive the trip through f32 storage.
 */
export interface HdrValue {
  mantissaHi: number;
  mantissaLo: number;
  exponent: number;
}

/** Splits a JS double into the HDR triple. */
export function toHdr(value: number): HdrValue {
  if (value === 0 || !Number.isFinite(value)) {
    return { mantissaHi: 0, mantissaLo: 0, exponent: 0 };
  }
  const exponent = Math.floor(Math.log2(Math.abs(value)));
  const normalized = value / 2 ** exponent;
  const mantissaHi = Math.fround(normalized);
  return {
    mantissaHi,
    mantissaLo: Math.fround(normalized - mantissaHi),
    exponent,
  };
}

export function fromHdr(value: HdrValue): number {
  return (value.mantissaHi + value.mantissaLo) * 2 ** value.exponent;
}

/** Converts fixed-point limbs straight to the HDR sample format. */
export function fixedToHdr(words: ArrayLike<number>, limbs: number): HdrValue {
  const scaled = fromLimbs(words, limbs);
  if (scaled === 0n) return { mantissaHi: 0, mantissaLo: 0, exponent: 0 };

  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const bitLength = magnitude.toString(2).length;

  // Match orbit.wgsl emitSample, including rounding of the residual.
  // Truncating to 48 bits here biased Julia sample zero on every rebase.
  const shift = bitLength - 64;
  const top = shift >= 0 ? magnitude >> BigInt(shift) : magnitude << BigInt(-shift);
  const high = top >> 32n;
  const low = top & 0xffffffffn;
  const exponent = bitLength - 32 - Number(fractionalBits(limbs));
  const sign = negative ? -1 : 1;
  const mantissaHi = sign * Number(high >> 8n) * 256;
  return {
    mantissaHi,
    mantissaLo: sign * Math.fround(Number(high & 255n) + Math.fround(Number(low)) * 2 ** -32),
    exponent,
  };
}
