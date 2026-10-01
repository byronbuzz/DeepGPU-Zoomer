/**
 * Standard bivariate linear approximation (BLA).
 *
 * For one perturbation step
 *
 *     w' = 2*X*w + w^2 + d
 *
 * omit the nonlinear term while it is below the selected local tolerance:
 *
 *     w' ~= A*w + B*d,  A = 2*X, B = 1, |w| < epsilon*|A|.
 *
 * Adjacent steps are composed with the standard local-validity rule. Every
 * eligible sampling density uses this policy; the complete Wide recurrence is
 * the local fallback whenever a skip is unavailable.
 */

import Decimal from "decimal.js";

/** One reference iteration per level-0 entry. */
/** Compile-time research arm. The unset value retains the released policy. */
export const BLA_VARIANT = "quadratic4-envelope";
export const QUADRATIC = BLA_VARIANT.startsWith("quadratic");
export const QUADRATIC_CONTROL = BLA_VARIANT.endsWith("control");
export const QUADRATIC_ENVELOPE = BLA_VARIANT.includes("envelope");
export const BASE_STEP = BLA_VARIANT.includes("4") ? 4 : BLA_VARIANT.includes("8") ? 8 : 1;
/** Empirical local tolerance selected for the accepted quality/performance tradeoff. */
const EPSILON_LOG2 = -21;
/** Experimental lower-endpoint search budget; the released search uses 28. */
const RADIUS_BISECTIONS = 12;
/** Sentinel log2-radius meaning "this step is never usable". */
export const NEVER = -1e30;
/** Matches the shader's LA_NEVER eligibility cutoff. */
const MIN_USABLE_RADIUS_LOG2 = -1e29;
/** Two complex coefficients, radius, padding. */
export const ENTRY_FLOATS = QUADRATIC ? 32 : 12;

export interface BlaTable {
  data: Float32Array;
  levelOffsets: number[];
  levelCounts: number[];
  levels: number;
  entryCount: number;
  /** At least one packed range of two or more iterations can pass the shader's radius sentinel. */
  hasUsableMultiStep: boolean;
  /** Research-only CPU tree for checking radius and error envelopes. */
  diagnosticSteps?: Step[][];
}

/** A complex number as (x, y) * 2^e, mantissa normalised near [1, 2). */
export interface Scaled { x: number; y: number; e: number }

export function normalise(x: number, y: number, e: number): Scaled {
  const magnitude = Math.max(Math.abs(x), Math.abs(y));
  if (magnitude === 0 || !Number.isFinite(magnitude)) return { x: 0, y: 0, e: 0 };
  const shift = Math.floor(Math.log2(magnitude)), scale = 2 ** -shift;
  return { x: x * scale, y: y * scale, e: e + shift };
}

export function multiply(a: Scaled, b: Scaled): Scaled {
  return normalise(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x, a.e + b.e);
}

export function scale(a: Scaled, factor: number): Scaled {
  return normalise(a.x * factor, a.y * factor, a.e);
}

export function add(a: Scaled, b: Scaled): Scaled {
  if (a.x === 0 && a.y === 0) return b;
  if (b.x === 0 && b.y === 0) return a;
  const difference = a.e - b.e;
  if (difference > 80) return a;
  if (difference < -80) return b;
  if (difference >= 0) {
    const scale = 2 ** -difference;
    return normalise(a.x + b.x * scale, a.y + b.y * scale, a.e);
  }
  const scale = 2 ** difference;
  return normalise(a.x * scale + b.x, a.y * scale + b.y, b.e);
}

export function log2Magnitude(value: Scaled): number {
  const magnitude = Math.hypot(value.x, value.y);
  return magnitude === 0 ? -Infinity : value.e + Math.log2(magnitude);
}

const ONE: Scaled = { x: 1, y: 0, e: 0 };
const ZERO: Scaled = { x: 0, y: 0, e: 0 };

export interface Step { a: Scaled; b: Scaled; c?: Scaled; d?: Scaled; e?: Scaled; radiusLog2: number; parts?: readonly [Step,Step]; errorEnvelope?: readonly number[] }

/** Compose first then second: A=A2*A1, B=A2*B1+B2. */
export function compose(first: Step, second: Step): Pick<Step, "a" | "b"> {
  return { a: multiply(second.a, first.a), b: add(multiply(second.a, first.b), second.b) };
}

export function composeQuadratic(first: Step, second: Step): Step {
  const a=first.a,b=first.b,c=first.c??ZERO,d=first.d??ZERO,e=first.e??ZERO;
  const A=second.a,C=second.c??ZERO,D=second.d??ZERO;
  return {
    a:multiply(A,a), b:add(multiply(A,b),second.b),
    c:add(multiply(A,c),multiply(C,multiply(a,a))),
    d:add(add(multiply(A,d),scale(multiply(C,multiply(a,b)),2)),multiply(D,a)),
    e:add(add(multiply(A,e),multiply(C,multiply(b,b))),add(multiply(D,b),second.e??ZERO)),
    radiusLog2:NEVER,parts:[first,second],
  };
}

// Outward-biased magnitude bound for a polynomial on |w|<=2^r, |d|<=2^delta.
// It includes every quadratic term when testing the second half's domain.
function boundPolyLog2(step:Step,r:number,delta:number):number {
  const terms=[log2Magnitude(step.a)+r,log2Magnitude(step.b)+delta,
    log2Magnitude(step.c??ZERO)+2*r,log2Magnitude(step.d??ZERO)+r+delta,
    log2Magnitude(step.e??ZERO)+2*delta];
  const peak=Math.max(...terms);
  return peak===-Infinity?-Infinity:peak+Math.log2(terms.reduce((s,v)=>s+2**(v-peak),0))+1e-6;
}

// Composition discards degree >=3. Bound the discarded terms of
// C2*(L1+Q1)^2 + D2*(L1+Q1)*d with triangle inequalities. The available
// error budget stays below the released linear tolerance at the domain edge.
function remainderLog2(first:Step,second:Step,r:number,delta:number):number {
  const linear=boundPolyLog2({a:first.a,b:first.b,radiusLog2:NEVER},r,delta);
  const quadratic=boundPolyLog2({a:ZERO,b:ZERO,c:first.c,d:first.d,e:first.e,radiusLog2:NEVER},r,delta);
  if(quadratic===-Infinity)return -Infinity;
  const c=log2Magnitude(second.c??ZERO),d=log2Magnitude(second.d??ZERO);
  return Math.max(c+1+linear+quadratic,c+2*quadratic,d+quadratic+delta)+2;
}

function logSum(values:number[]):number {
  const peak=Math.max(...values);
  return peak===-Infinity?-Infinity:peak+Math.log2(values.reduce((s,v)=>s+2**(v-peak),0));
}

// A nonnegative polynomial in |w| with log2 coefficients for degrees 0..3.
// Pixel |d| is already bounded by the table's maxDelta. Degrees above three
// are lowered using |w|<=2^cap: w^k <= 2^((k-3)cap)*w^3.
type Envelope=readonly [number,number,number,number];
const EMPTY_ENVELOPE:Envelope=[-Infinity,-Infinity,-Infinity,-Infinity];
function logAdd(a:number,b:number):number {
  if(a===-Infinity)return b;
  if(b===-Infinity)return a;
  const high=Math.max(a,b),low=Math.min(a,b);
  return high+Math.log2(1+2**(low-high));
}
function envelopeAdd(a:Envelope,b:Envelope):Envelope {
  return [logAdd(a[0],b[0]),logAdd(a[1],b[1]),logAdd(a[2],b[2]),logAdd(a[3],b[3])];
}
function envelopeScale(a:Envelope,logFactor:number):Envelope {
  return a.map(x=>x===-Infinity||logFactor===-Infinity?-Infinity:x+logFactor) as unknown as Envelope;
}
function envelopeMultiply(a:Envelope,b:Envelope,cap:number):Envelope {
  const out=[-Infinity,-Infinity,-Infinity,-Infinity];
  for(let i=0;i<4;i++)for(let j=0;j<4;j++)if(a[i]!==-Infinity&&b[j]!==-Infinity){
    const degree=i+j,target=Math.min(3,degree);
    out[target]=logAdd(out[target],a[i]+b[j]+Math.max(0,degree-3)*cap);
  }
  return out as unknown as Envelope;
}
export function envelopeEval(a:Envelope,r:number):number {
  // Preserve logSum's left-to-right four-term reduction without allocating an
  // array for every radius candidate in the quadratic table search.
  const t0=a[0]===-Infinity?-Infinity:a[0]+0*r,
    t1=a[1]===-Infinity?-Infinity:a[1]+1*r,
    t2=a[2]===-Infinity?-Infinity:a[2]+2*r,
    t3=a[3]===-Infinity?-Infinity:a[3]+3*r;
  const peak=Math.max(t0,t1,t2,t3);
  if(peak===-Infinity)return -Infinity;
  const sum=0+2**(t0-peak)+2**(t1-peak)+2**(t2-peak)+2**(t3-peak);
  return peak+Math.log2(sum);
}
function polynomialBound(step:Step,delta:number):Envelope {
  return [logAdd(log2Magnitude(step.b)+delta,log2Magnitude(step.e??ZERO)+2*delta),
    logAdd(log2Magnitude(step.a),log2Magnitude(step.d??ZERO)+delta),
    log2Magnitude(step.c??ZERO),-Infinity];
}
function linearBound(step:Step,delta:number):Envelope {
  return [log2Magnitude(step.b)+delta,log2Magnitude(step.a),-Infinity,-Infinity];
}
function quadraticBound(step:Step,delta:number):Envelope {
  return [log2Magnitude(step.e??ZERO)+2*delta,log2Magnitude(step.d??ZERO)+delta,
    log2Magnitude(step.c??ZERO),-Infinity];
}
export function envelopeForMerge(first:Step,second:Step,delta:number):Envelope {
  const cap=first.radiusLog2;
  const p=polynomialBound(first,delta),l=linearBound(first,delta),q=quadraticBound(first,delta);
  const e1=(first.errorEnvelope??EMPTY_ENVELOPE) as Envelope;
  const e2=(second.errorEnvelope??EMPTY_ENVELOPE) as Envelope;
  const s=envelopeAdd(p,e1),s2=envelopeMultiply(s,s,cap);
  const secondError=envelopeAdd(envelopeAdd(
    envelopeScale(s,e2[1]),envelopeScale(s2,e2[2])),
    envelopeScale(envelopeMultiply(s2,s,cap),e2[3]));
  const inherited=envelopeAdd([e2[0],-Infinity,-Infinity,-Infinity],secondError);
  const sensitivity=envelopeAdd(envelopeAdd(
    [log2Magnitude(second.a),-Infinity,-Infinity,-Infinity],
    envelopeScale(p,log2Magnitude(second.c??ZERO)+1)),
    envelopeAdd(envelopeScale(e1,log2Magnitude(second.c??ZERO)),
      [log2Magnitude(second.d??ZERO)+delta,-Infinity,-Infinity,-Infinity]));
  const propagated=envelopeMultiply(e1,sensitivity,cap);
  const truncation=envelopeAdd(
    envelopeScale(envelopeAdd(envelopeScale(envelopeMultiply(l,q,cap),1),
      envelopeMultiply(q,q,cap)),log2Magnitude(second.c??ZERO)),
    envelopeScale(q,log2Magnitude(second.d??ZERO)+delta));
  return envelopeAdd(envelopeAdd(inherited,propagated),envelopeScale(truncation,2));
}

// Re-evaluate child error at the actual proposed entry radius. Using a saved
// worst-case child error at its much wider radius would exclude valid parents.
export function quadraticErrorLog2(step:Step,r:number,delta:number):number {
  if(!step.parts)return -Infinity; // One quadratic step is the exact recurrence.
  const [first,second]=step.parts;
  const firstError=quadraticErrorLog2(first,r,delta);
  const travel=logSum([boundPolyLog2(first,r,delta),firstError]);
  if(travel>=second.radiusLog2)return Infinity;
  const secondError=quadraticErrorLog2(second,travel,delta);
  const sensitivity=logSum([log2Magnitude(second.a),
    log2Magnitude(second.c??ZERO)+1+travel,log2Magnitude(second.d??ZERO)+delta])+1e-6;
  return logSum([remainderLog2(first,second,r,delta),
    sensitivity+firstError,secondError]);
}

function mergedRadius(first:Step,second:Step,maxDeltaLog2:number,quadratic:boolean,toleranceLog2:number,errorEnvelope?:Envelope,composedStep?:Step):number {
  if(!quadratic){
    const injected=log2Magnitude(first.b)+maxDeltaLog2;
    if(injected>=second.radiusLog2)return NEVER;
    const remaining=second.radiusLog2+Math.log2(1-2**(injected-second.radiusLog2));
    const radius=Math.min(first.radiusLog2,remaining-log2Magnitude(first.a));
    return Number.isFinite(radius)?radius:NEVER;
  }
  // The control intentionally stays inside the first-order domain. The
  // candidate uses the wider quadratic domain and sums propagated and newly
  // discarded remainder bounds. Both use the requested policy tolerance.
  let lo=first.radiusLog2-96,hi=first.radiusLog2;
  const composed=composedStep??composeQuadratic(first,second);
  const travelEnvelope=errorEnvelope?envelopeAdd(polynomialBound(first,maxDeltaLog2),
    (first.errorEnvelope??EMPTY_ENVELOPE) as Envelope):undefined;
  const budgetEnvelope=errorEnvelope?linearBound(composed,maxDeltaLog2):undefined;
  const valid=(r:number)=>{
    if(errorEnvelope){
      const travel=envelopeEval(travelEnvelope!,r);
      return travel+1e-6<second.radiusLog2 &&
        envelopeEval(errorEnvelope,r)+1e-6 < envelopeEval(budgetEnvelope!,r)+toleranceLog2;
    }
    const error=quadraticErrorLog2(composed,r,maxDeltaLog2);
    const budget=boundPolyLog2({a:composed.a,b:composed.b,radiusLog2:NEVER},r,maxDeltaLog2)+toleranceLog2;
    return error+(QUADRATIC_CONTROL?8:0)<budget;
  };
  if(!Number.isFinite(hi)||!valid(lo))return NEVER;
  for(let i=0;i<RADIUS_BISECTIONS;i++){const mid=(lo+hi)/2;if(valid(mid))lo=mid;else hi=mid;}
  return lo-(QUADRATIC_CONTROL?1:0.25);
}

export interface BuildOptions {
  maxLevels?: number;
  auditBlocks?: Step[];
  epsilonLog2?: number;
  /** Legacy reduced samples or packed four-word reference samples. */
  sampleWords?: 6 | 10 | 20;
  keepDiagnosticSteps?: boolean;
}

/** Preserve ordinary binary64 bounds, but never narrow a deep Decimal to zero. */
export function deltaBoundLog2(maxDelta: number | Decimal): number {
  if (typeof maxDelta === "number") return maxDelta > 0 ? Math.log2(maxDelta) : -Infinity;
  if (maxDelta.isZero()) return -Infinity;
  const ordinary = maxDelta.toNumber();
  if (ordinary >= 2 ** -1022 && Number.isFinite(ordinary)) return Math.log2(ordinary);
  // Split before conversion: even binary64 subnormals lose significant range
  // and precision. No high-precision transcendental is needed at deep zoom.
  const leading = maxDelta.div(new Decimal(`1e${maxDelta.e}`)).toNumber();
  const log = Math.log2(leading) + maxDelta.e * Math.LOG2E * Math.LN10;
  // Bias the split conversion outward by a few binary64 rounding units. The
  // existing log-radius composition and GPU packing policy remain unchanged.
  return log + 4 * Number.EPSILON * Math.max(1, Math.abs(log));
}

function* buildBlaSteps(
  orbit: Float32Array,
  length: number,
  maxDelta: number | Decimal,
  options: BuildOptions = {},
): Generator<void, BlaTable> {
  // Reference index zero has X=0, so its perturbation step contains only the
  // nonlinear w^2 term plus d and cannot be represented by a linear BLA.
  // Store entries for reference indices 1..length-2; the shader uses the same
  // index-1 alignment at every merged level.
  const count = options.auditBlocks ? 0 : Math.max(0, length - 2);
  const refX = new Float64Array(count), refY = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (i % 8192 === 0) yield;
    if (options.sampleWords === 10 || options.sampleWords === 20) {
      const at = (i + 1) * options.sampleWords;
      refX[i] = (orbit[at] + orbit[at + 1] + orbit[at + 2] + orbit[at + 3]) * 2 ** orbit[at + 4];
      refY[i] = (orbit[at + 5] + orbit[at + 6] + orbit[at + 7] + orbit[at + 8]) * 2 ** orbit[at + 9];
    } else {
      const at = (i + 1) * 6;
      refX[i] = (orbit[at] + orbit[at + 1]) * 2 ** orbit[at + 2];
      refY[i] = (orbit[at + 3] + orbit[at + 4]) * 2 ** orbit[at + 5];
    }
  }

  const maxDeltaLog2 = deltaBoundLog2(maxDelta);
  const toleranceLog2=options.epsilonLog2??EPSILON_LOG2;
  const levels: Step[][] = [[]];
  for (let i = 0; i < count; i++) {
    if (i % 4096 === 0) yield;
    const a = normalise(2 * refX[i], 2 * refY[i], 0);
    const magnitude = log2Magnitude(a);
    const escapeHeadroom=16-Math.hypot(refX[i],refY[i]);
    const quadraticRadius=QUADRATIC&&!QUADRATIC_CONTROL ?
      Math.min((magnitude+toleranceLog2)/2,escapeHeadroom>0?Math.log2(escapeHeadroom):NEVER) :
      magnitude+toleranceLog2;
    levels[0].push({ a, b: ONE, ...(QUADRATIC?{c:ONE,d:ZERO,e:ZERO}:{}),
      radiusLog2: Number.isFinite(magnitude) ? quadraticRadius : NEVER });
  }

  // Form base blocks from the same one-step entries and radius composition.
  // This leaves the released base-1 path byte-for-byte equivalent in policy.
  if (BASE_STEP > 1) {
    const blocks: Step[] = [];
    for (let start = 0; start + BASE_STEP <= levels[0].length; start += BASE_STEP) {
      // Quadratic block composition is expensive enough to monopolize the UI
      // at deep caps. At roughly 20 us/block here, 512 blocks bound a slice
      // near 11 ms while retaining the existing cancellation checkpoint.
      if (QUADRATIC && start % (BASE_STEP * 512) === 0) yield;
      let block = levels[0][start];
      for (let k = 1; k < BASE_STEP; k++) {
        const second = levels[0][start + k];
        const errorEnvelope=QUADRATIC_ENVELOPE?envelopeForExactStep(block,second,maxDeltaLog2):undefined;
        const composed=QUADRATIC?composeQuadratic(block,second):undefined;
        const radiusLog2=mergedRadius(block,second,maxDeltaLog2,QUADRATIC,toleranceLog2,errorEnvelope,composed);
        block = { ...(composed??compose(block,second)), radiusLog2,errorEnvelope };
      }
      blocks.push(block);
    }
    levels[0] = blocks;
  }

  if(options.auditBlocks) levels[0] = options.auditBlocks;
  const maxLevels = options.maxLevels ?? 21;
  for (let level = 1; level < maxLevels; level++) {
    const previous = levels[level - 1], mergedCount = Math.floor(previous.length / 2);
    if (mergedCount < 1) break;
    const merged: Step[] = [];
    for (let i = 0; i < mergedCount; i++) {
      if (i % (QUADRATIC ? 512 : 2048) === 0) yield;
      const first = previous[2 * i], second = previous[2 * i + 1];
      const errorEnvelope=QUADRATIC_ENVELOPE?envelopeForMerge(first,second,maxDeltaLog2):undefined;
      const composed=QUADRATIC?composeQuadratic(first,second):undefined;
      const radiusLog2=mergedRadius(first,second,maxDeltaLog2,QUADRATIC,toleranceLog2,errorEnvelope,composed);
      merged.push({ ...(composed??compose(first,second)), radiusLog2,errorEnvelope });
    }
    levels.push(merged);
  }

  const entryCount = levels.reduce((sum, level) => sum + level.length, 0);
  const data = new Float32Array(Math.max(1, entryCount) * ENTRY_FLOATS);
  const levelOffsets: number[] = [], levelCounts: number[] = [];
  let offset = 0, hasUsableMultiStep = false;
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
    const level = levels[levelIndex];
    levelOffsets.push(offset); levelCounts.push(level.length);
    for (let index = 0; index < level.length; index++) {
      if (index % 4096 === 0) yield;
      const target = (offset + index) * ENTRY_FLOATS, step = level[index];
      const put = (slot: number, value: Scaled) => {
        data[target + slot * 5] = value.x;
        data[target + slot * 5 + 1] = value.x - Math.fround(value.x);
        data[target + slot * 5 + 2] = value.y;
        data[target + slot * 5 + 3] = value.y - Math.fround(value.y);
        data[target + slot * 5 + 4] = value.e;
      };
      put(0, step.a); put(1, step.b);
      if(QUADRATIC){put(2,step.c??ZERO);put(3,step.d??ZERO);put(4,step.e??ZERO);}
      data[target + (QUADRATIC?25:10)] = step.radiusLog2;
      // Level zero spans one iteration and is deliberately ignored by the
      // shader. Use the same radius eligibility cutoff as takeSkip.
      if ((levelIndex > 0 || BASE_STEP > 1) && step.radiusLog2 > MIN_USABLE_RADIUS_LOG2) hasUsableMultiStep = true;
    }
    offset += level.length;
  }
  return { data, levelOffsets, levelCounts, levels: levels.length, entryCount, hasUsableMultiStep,
    ...(options.keepDiagnosticSteps?{diagnosticSteps:levels}:{}) };
}

export function buildBla(orbit: Float32Array, length: number, maxDelta: number | Decimal, options: BuildOptions = {}): BlaTable {
  const steps = buildBlaSteps(orbit, length, maxDelta, options);
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

export async function buildBlaAsync(orbit: Float32Array, length: number, maxDelta: number | Decimal, checkpoint: () => Promise<void>, options: BuildOptions = {}): Promise<BlaTable> {
  const steps = buildBlaSteps(orbit, length, maxDelta, options);
  for (;;) { const next = steps.next(); if (next.done) return next.value; await checkpoint(); }
}

export function readStep(table: BlaTable, level: number, index: number): Step {
  const base = (table.levelOffsets[level] + index) * ENTRY_FLOATS;
  const get = (slot: number): Scaled => ({
    x: table.data[base + slot * 5] + table.data[base + slot * 5 + 1],
    y: table.data[base + slot * 5 + 2] + table.data[base + slot * 5 + 3],
    e: table.data[base + slot * 5 + 4],
  });
  return { a: get(0), b: get(1), ...(QUADRATIC?{c:get(2),d:get(3),e:get(4)}:{}),
    radiusLog2: table.data[base + (QUADRATIC?25:10)] };
}

export function applyStep(step: Step, w: Scaled, delta: Scaled): Scaled {
  let value=add(multiply(step.a, w), multiply(step.b, delta));
  if(QUADRATIC) value=add(value,add(add(multiply(step.c??ZERO,multiply(w,w)),
    multiply(step.d??ZERO,multiply(w,delta))),multiply(step.e??ZERO,multiply(delta,delta))));
  return value;
}

export function stepRadiusLog2(table: BlaTable, level: number, index: number): number {
  return table.data[(table.levelOffsets[level] + index) * ENTRY_FLOATS + (QUADRATIC?25:10)];
}

// Base blocks append an exact single recurrence: B=C=1, D=E=0, no inherited second error.
function envelopeForExactStep(first:Step,second:Step,delta:number):Envelope {
  const cap=first.radiusLog2;
  const p=polynomialBound(first,delta),l=linearBound(first,delta),q=quadraticBound(first,delta);
  const e1=(first.errorEnvelope??EMPTY_ENVELOPE) as Envelope;
  const sensitivity=envelopeAdd(envelopeAdd(
    [log2Magnitude(second.a),-Infinity,-Infinity,-Infinity],envelopeScale(p,1)),e1);
  const propagated=envelopeMultiply(e1,sensitivity,cap);
  const truncation=envelopeAdd(envelopeScale(envelopeMultiply(l,q,cap),1),envelopeMultiply(q,q,cap));
  return envelopeAdd(propagated,envelopeScale(truncation,2));
}