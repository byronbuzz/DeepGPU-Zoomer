import type { FixedComplex } from "../arithmetic/fixed-complex";

/** Fixed-width recurrence for the worker; the independent oracle is unchanged. */
export function createReferenceStep(limbs: number): (z: FixedComplex, c: FixedComplex) => FixedComplex {
  const bits = 32 * limbs;
  const shift = BigInt(bits - 32);
  return (z, c) => {
    const xx = (z.x * z.x) >> shift;
    const yy = (z.y * z.y) >> shift;
    const product = z.x * z.y;
    // The oracle truncates negative products toward zero, not toward -Infinity.
    const xy = product < 0n ? -((-product) >> shift) : product >> shift;
    // Intermediate wraps in sums/differences can be deferred to the final sum.
    return {
      x: BigInt.asIntN(bits, xx - yy + c.x),
      y: BigInt.asIntN(bits, xy + xy + c.y),
    };
  };
}
