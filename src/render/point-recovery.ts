/** Selected-point recovery, deliberately independent of GPU/reference/BLA arithmetic.
 *
 * This is not a screen-wide fallback. The caller supplies exact rational coordinates,
 * a precision budget, and bounded operation slices. Each accepted escape count is
 * enclosed with integer arithmetic; a finite cap is never called mathematical interior.
 */
export interface ExactRational { numerator: bigint; denominator: bigint }
export interface ExactMandelbrotPoint { x: ExactRational; y: ExactRational }
export type RecoveryTrigger = 'method-disagreement' | 'reference-disagreement' |
  'numerical-periodicity' | 'explicit-selection';
export interface PointRecoveryRequest {
  point: ExactMandelbrotPoint;
  maxIterations: number;
  /** Increasing binary precisions: a computational budget, not an error tolerance. */
  precisions: readonly number[];
  trigger: RecoveryTrigger;
}
export interface PointObservation {
  point: ExactMandelbrotPoint;
  maxIterations: number;
  /** null means unescaped through the requested cap, not mathematical interior. */
  escapeIteration: number | null;
  methodIdentity: string;
  referenceIdentity: string | null;
}

/** Exact count/classification disagreement is a concrete recovery trigger.
 * Agreement between two finite calculations is expressly not a certificate.
 */
export function comparePointObservations(a:PointObservation,b:PointObservation):
  RecoveryTrigger | 'agreement-without-certification' | 'incomparable' {
  const same=(x:ExactRational,y:ExactRational)=>
    x.denominator!==0n&&y.denominator!==0n&&x.numerator*y.denominator===y.numerator*x.denominator;
  if(a.maxIterations!==b.maxIterations||!same(a.point.x,b.point.x)||!same(a.point.y,b.point.y))
    return 'incomparable';
  if(a.escapeIteration===b.escapeIteration)return 'agreement-without-certification';
  return a.methodIdentity===b.methodIdentity&&a.referenceIdentity!==b.referenceIdentity?
    'reference-disagreement':'method-disagreement';
}
export interface OrbitEnclosure {
  /** Exact disk center (real + i*imaginary)/2^bits and radius/2^bits. */
  real: bigint;
  imaginary: bigint;
  radius: bigint;
  bits: number;
}
export type PointRecoveryResult = {
  status: 'analytic-interior';
  certificate: 'main-cardioid' | 'period-two-bulb';
  trigger: RecoveryTrigger;
  iterations: 0;
  operations: 0;
} | {
  status: 'escaped' | 'cap-unresolved' | 'precision-exhausted';
  trigger: RecoveryTrigger;
  /** Escape count, reached cap, or first iteration whose bailout was ambiguous. */
  iterations: number;
  operations: number;
  attempts: number;
  enclosure: OrbitEnclosure;
};
export interface PointRecoveryProgress {
  status: 'running';
  iterations: number;
  operations: number;
  attempts: number;
  bits: number;
}

function rational(numerator: bigint, denominator = 1n): ExactRational {
  if (denominator === 0n) throw Error('A rational denominator must be nonzero');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  return { numerator, denominator };
}
function add(a: ExactRational, b: ExactRational) {
  return rational(a.numerator*b.denominator+b.numerator*a.denominator,
    a.denominator*b.denominator);
}
function multiply(a: ExactRational, b: ExactRational) {
  return rational(a.numerator*b.numerator, a.denominator*b.denominator);
}
function less(a: ExactRational, b: ExactRational) {
  return a.numerator*b.denominator < b.numerator*a.denominator;
}

/** Strict rational inequalities certify membership, without a floating-point margin. */
export function exactAnalyticInterior(point: ExactMandelbrotPoint):
  'main-cardioid' | 'period-two-bulb' | null {
  const x = rational(point.x.numerator, point.x.denominator);
  const y = rational(point.y.numerator, point.y.denominator);
  const y2 = multiply(y,y);
  const shifted = add(x,rational(1n));
  if (less(add(multiply(shifted,shifted),y2),rational(1n,16n))) return 'period-two-bulb';
  const quarter = add(x,rational(-1n,4n));
  const q = add(multiply(quarter,quarter),y2);
  return less(multiply(q,add(q,quarter)),multiply(y2,rational(1n,4n))) ? 'main-cardioid' : null;
}

function floorDivide(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator;
  return numerator < 0n && numerator % denominator !== 0n ? quotient-1n : quotient;
}
function ceilDividePositive(numerator: bigint, denominator: bigint) {
  return (numerator+denominator-1n)/denominator;
}
function sqrtFloor(value: bigint): bigint {
  if (value < 0n) throw Error('Negative squared magnitude');
  if (value < 2n) return value;
  let root = 1n << BigInt(Math.ceil(value.toString(2).length/2));
  while (true) {
    const next = (root+value/root)>>1n;
    if (next >= root) return root;
    root = next;
  }
}

/** A stateful CPU calculation. step(k) performs no more than k recurrence steps.
 * A retry starts from z0=0 at a higher precision; packed GPU values are never seeds.
 */
export function createPointRecovery(request: PointRecoveryRequest) {
  if (!Number.isSafeInteger(request.maxIterations) || request.maxIterations < 1)
    throw Error('Invalid point-recovery iteration budget');
  const precisions = [...request.precisions];
  const maxIterations=request.maxIterations, trigger=request.trigger;
  if (!precisions.length || precisions.some((bits,index) => !Number.isSafeInteger(bits) ||
      bits < 32 || bits > 16384 || (index > 0 && bits <= precisions[index-1])))
    throw Error('Point-recovery precisions must increase between 32 and 16384 bits');
  const point = {
    x:rational(request.point.x.numerator,request.point.x.denominator),
    y:rational(request.point.y.numerator,request.point.y.denominator),
  };
  const certificate = exactAnalyticInterior(point);
  let result: PointRecoveryResult | null = certificate ? {
    status:'analytic-interior',certificate,trigger,iterations:0,operations:0,
  } : null;
  let attempt = 0, operations = 0, n = 0;
  let scale = 1n, cx = 0n, cy = 0n, parameterRadius = 0n;
  let x = 0n, y = 0n, radius = 0n, normUpper = 0n;
  function reset() {
    scale = 1n << BigInt(precisions[attempt]);
    const nx = point.x.numerator*scale, ny = point.y.numerator*scale;
    cx = floorDivide(nx,point.x.denominator);
    cy = floorDivide(ny,point.y.denominator);
    // The L1 bound encloses the Euclidean parameter error without a sqrt.
    parameterRadius = (nx%point.x.denominator === 0n ? 0n : 1n) +
      (ny%point.y.denominator === 0n ? 0n : 1n);
    x=0n;y=0n;radius=0n;normUpper=0n;n=0;
  }
  reset();
  function finish(status: 'escaped' | 'cap-unresolved' | 'precision-exhausted') {
    result = {status,trigger,iterations:n,operations,attempts:attempt+1,
      enclosure:{real:x,imaginary:y,radius,bits:precisions[attempt]}};
    return result;
  }
  return {
    step(maxOperations: number): PointRecoveryProgress | PointRecoveryResult {
      if (!Number.isSafeInteger(maxOperations) || maxOperations < 1)
        throw Error('A recovery slice must contain a positive operation budget');
      if (result) return result;
      for (let used=0;used<maxOperations;used++) {
        const realNumerator=x*x-y*y, imaginaryNumerator=2n*x*y;
        const arithmeticRadius=(realNumerator%scale === 0n ? 0n : 1n)+
          (imaginaryNumerator%scale === 0n ? 0n : 1n);
        // |(z+e)^2-z^2| <= 2|z||e|+|e|^2. Every division rounds outward.
        radius=ceilDividePositive(2n*normUpper*radius+radius*radius,scale)+
          parameterRadius+arithmeticRadius;
        x=floorDivide(realNumerator,scale)+cx;
        y=floorDivide(imaginaryNumerator,scale)+cy;
        n++;operations++;
        const squared=x*x+y*y;
        const normLower=sqrtFloor(squared);
        normUpper=normLower+(normLower*normLower === squared ? 0n : 1n);
        const bailout=16n*scale;
        if (normLower-radius > bailout) return finish('escaped');
        if (normUpper+radius > bailout) {
          if (attempt+1 === precisions.length) return finish('precision-exhausted');
          attempt++;reset();
        } else if (n === maxIterations) return finish('cap-unresolved');
      }
      return {status:'running',iterations:n,operations,attempts:attempt+1,bits:precisions[attempt]};
    },
  };
}
