import Decimal from 'decimal.js';
import { ExactGeometryCache } from './exact-geometry-cache';

const powers = new ExactGeometryCache<Decimal>(8);

/** Identically rounded powers for coordinate packing. Configuration is part of
 * the key; eviction changes only cost. Never expose the retained Decimal.
 */
export function coordinatePower(base: 2 | 10, exponent: number): Decimal {
  if (!Number.isSafeInteger(exponent)) return new Decimal(base).pow(exponent);
  return new Decimal(powers.get([], [base, exponent], () => new Decimal(base).pow(exponent)));
}
