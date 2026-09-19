/**
 * Exact `BigInt` implementation of every operation the GPU shaders perform.
 * The GPU is only ever considered correct when it agrees with this file.
 */

import {
  fractionalBits,
  fromLimbs,
  toLimbs,
  totalBits,
  wrapSigned,
} from "./types";

export interface FixedComplex {
  x: bigint;
  y: bigint;
}

/** Adds two scaled integers, wrapping like the GPU carry chain does. */
export function addFixed(a: bigint, b: bigint, limbs: number): bigint {
  return wrapSigned(a + b, limbs);
}

export function subFixed(a: bigint, b: bigint, limbs: number): bigint {
  return wrapSigned(a - b, limbs);
}

/**
 * Fixed-point multiply: the full product carries 2F fractional bits, so it is
 * shifted back down by F.
 *
 * The shader multiplies magnitudes and reapplies the sign, which truncates
 * toward zero. BigInt's `>>` floors instead, so the sign is handled explicitly
 * here to match bit for bit — the two differ by one ULP on negative products.
 */
export function mulFixed(a: bigint, b: bigint, limbs: number): bigint {
  const shift = fractionalBits(limbs);
  const negative = a < 0n !== b < 0n;
  const magnitude = (a < 0n ? -a : a) * (b < 0n ? -b : b);
  const shifted = magnitude >> shift;
  return wrapSigned(negative ? -shifted : shifted, limbs);
}

/** One step of the reference recurrence: z <- z² + c. */
export function orbitStep(
  z: FixedComplex,
  c: FixedComplex,
  limbs: number
): FixedComplex {
  const xx = mulFixed(z.x, z.x, limbs);
  const yy = mulFixed(z.y, z.y, limbs);
  const xy = mulFixed(z.x, z.y, limbs);
  return {
    x: addFixed(subFixed(xx, yy, limbs), c.x, limbs),
    y: addFixed(addFixed(xy, xy, limbs), c.y, limbs),
  };
}

/** True once |z|² exceeds 4, using exact arithmetic. */
export function hasEscaped(z: FixedComplex, limbs: number): boolean {
  const shift = fractionalBits(limbs);
  const magnitude = (z.x * z.x + z.y * z.y) >> shift;
  return magnitude > 4n << shift;
}

/** Runs the reference orbit on the CPU, returning every sample. */
export function referenceOrbit(
  c: FixedComplex,
  limbs: number,
  maxIterations: number
): FixedComplex[] {
  const samples: FixedComplex[] = [{ x: 0n, y: 0n }];
  let z: FixedComplex = { x: 0n, y: 0n };
  for (let i = 0; i < maxIterations; i++) {
    z = orbitStep(z, c, limbs);
    samples.push(z);
    if (hasEscaped(z, limbs)) break;
  }
  return samples;
}

// ------------------------------------------------------------------ u32 utils
// Mirrors of the WGSL primitives, so the tests can exercise them directly.

export interface U64 {
  lo: number;
  hi: number;
}

export function mul32(a: number, b: number): U64 {
  const product = BigInt(a >>> 0) * BigInt(b >>> 0);
  return {
    lo: Number(product & 0xffffffffn),
    hi: Number((product >> 32n) & 0xffffffffn),
  };
}

export function addU64(a: U64, b: U64): U64 {
  const sum = ((BigInt(a.hi >>> 0) << 32n) | BigInt(a.lo >>> 0)) +
    ((BigInt(b.hi >>> 0) << 32n) | BigInt(b.lo >>> 0));
  return {
    lo: Number(sum & 0xffffffffn),
    hi: Number((sum >> 32n) & 0xffffffffn),
  };
}

/** Round-trips a scaled integer through the limb encoding. */
export function roundTrip(value: bigint, limbs: number): bigint {
  return fromLimbs(toLimbs(value, limbs), limbs);
}

export { fractionalBits, totalBits, fromLimbs, toLimbs, wrapSigned };
