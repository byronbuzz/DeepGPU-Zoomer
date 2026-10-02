/** Fixed-point complex values and subtraction for reference-orbit packing. */
import { wrapSigned } from "./types";

export interface FixedComplex {
  x: bigint;
  y: bigint;
}

export function subFixed(a: bigint, b: bigint, limbs: number): bigint {
  return wrapSigned(a - b, limbs);
}
