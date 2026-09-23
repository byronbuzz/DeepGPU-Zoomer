import Decimal from 'decimal.js';

// The renderer and reference worker support at most 256 limbs (8160 fractional
// bits). Include the entire final decimal decade so values near its binary
// rounding boundary remain supported; this does not change fixed-point rounding.
export const MIN_COORDINATE_EXPONENT = -Math.ceil(32 * (256 - 1) * Math.LOG10E * Math.LN2);
export const MAX_COORDINATE_INPUT_LENGTH = 12000;
export const MAX_FIXED_COORDINATE_LENGTH = MAX_COORDINATE_INPUT_LENGTH - MIN_COORDINATE_EXPONENT + 3;

function unsupported(name: string): never {
  throw Error(`${name} exceeds the current GPU coordinate precision profiles`);
}

/** Check compact decimal metadata before any fixed-point expansion. */
export function assertCoordinatePreparation(value: Decimal, name = 'Coordinate'): void {
  if (!value.isFinite()) throw Error(`Invalid ${name}`);
  if (!value.isZero() && value.e < MIN_COORDINATE_EXPONENT) unsupported(name);
  const fixedLength = Math.max(1, value.e + 1) + value.decimalPlaces() + 2;
  if (value.precision() > MAX_COORDINATE_INPUT_LENGTH || fixedLength > MAX_FIXED_COORDINATE_LENGTH) unsupported(name);
}

/** Saved input also needs a lexical check: Decimal may underflow extreme exponents to zero. */
export function parseCoordinateInput(text: unknown, name: string): Decimal {
  if (typeof text !== 'string' || text.length > MAX_COORDINATE_INPUT_LENGTH) throw Error(`Invalid ${name}`);
  const match = /^[+-]?(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw Error(`Invalid ${name}`);
  const significand = match[1], point = significand.indexOf('.');
  const wholeLength = point < 0 ? significand.length : point;
  const digits = significand.replace('.', ''), first = digits.search(/[1-9]/);
  if (first >= 0) {
    const exponent = BigInt(match[2] ?? '0') + BigInt(wholeLength - first - 1);
    if (exponent < BigInt(MIN_COORDINATE_EXPONENT)) unsupported(name);
  }
  const value = new Decimal(text);
  assertCoordinatePreparation(value, name);
  // A configured Decimal minE must not silently turn meaningful input into zero.
  if (first >= 0 && value.isZero()) unsupported(name);
  return value;
}

/** Preserve every supplied digit; never round or clamp during worker transport. */
export function coordinateToFixed(value: Decimal, name = 'Coordinate'): string {
  assertCoordinatePreparation(value, name);
  return value.toFixed();
}
