import {learnOrdinaryStripeCost} from './ordinary-stripes';

/** WGSL WideContinuation: five 48-byte Wide values plus exact-cycle state. */
export const CONTINUATION_STATE_BYTES = 304;
export const CONTINUATION_MAX_LANES = 4096;
export const CONTINUATION_HEADER_BYTES = 16 + CONTINUATION_MAX_LANES / 8;
export const DEFERRED_MAX_LANES = 65536;
export const DEFERRED_HEADER_BYTES = 16 + DEFERRED_MAX_LANES / 8;

/** Mandatory cold-work guard, independent of the optional hard-pixel control.
 * This bounds recurrence/skip loop operations per lane, not elapsed GPU time.
 * Cheap, measured work can still use the ordinary bulk dispatch path.
 */
export const COLD_CONTINUATION_OPERATIONS = 4096;
export const CONTINUATION_DISPATCH_OPERATIONS = CONTINUATION_MAX_LANES*256;
export const DEFERRED_MAX_DISPATCH_OPERATIONS = 32*CONTINUATION_DISPATCH_OPERATIONS;

export function continuationOperations(maxIterations:number, configured:number,
    msPerVisit:number, minimumVisits:number, targetMs:number):number {
  const cold=!Number.isFinite(msPerVisit)||msPerVisit<=0;
  if(cold) return maxIterations>COLD_CONTINUATION_OPERATIONS
    ? Math.min(COLD_CONTINUATION_OPERATIONS,configured>0?configured:COLD_CONTINUATION_OPERATIONS) : 0;
  // The optional override retains its expensive-minimum policy. Automatic
  // protection returns measured cheap work to the ordinary GPU controller;
  // multiplying by its historical occupancy floor would trap all work here.
  if(configured>0)return msPerVisit*minimumVisits>targetMs ? Math.min(maxIterations,configured) : 0;
  return maxIterations>COLD_CONTINUATION_OPERATIONS&&msPerVisit>targetMs ? COLD_CONTINUATION_OPERATIONS : 0;
}

/** A measured allowance must not be raised by the old unmeasured batch floor. */
export function measuredContinuationBudget(msPerVisit:number,targetMs:number):number | undefined {
  return Number.isFinite(msPerVisit)&&msPerVisit>0&&Number.isFinite(targetMs)&&targetMs>0
    ? Math.max(1,targetMs/msPerVisit) : undefined;
}

/** Turning the optional control Off cannot drain a paused sample in one pass. */
export function resumedContinuationOperations(configured:number, admitted:number,lanes:number):number {
  const perLane=Math.floor(CONTINUATION_DISPATCH_OPERATIONS/Math.max(1,lanes));
  return Math.max(1,Math.min(admitted,configured>0?configured:COLD_CONTINUATION_OPERATIONS,perLane));
}

/** The first cutoff counts cumulative executed loop bodies, not iteration n.
 * Every surviving lane consumes the whole slice, so the host can accumulate
 * this budget without another per-lane counter. Once deferred (or switched
 * Off), a saved sample still resumes in independently bounded slices. A
 * measured aggregate allowance can grow, but each lane still gets at least
 * one operation and at most the cold per-lane bound.
 */
export function deferredContinuationOperations(cutoff:number,executedFirst:number,lanes:number,deferred=false,
    aggregateBudget=CONTINUATION_DISPATCH_OPERATIONS):number {
  if(!Number.isSafeInteger(lanes)||lanes<1||lanes>DEFERRED_MAX_LANES)
    throw Error('Deferred continuation lane count exceeds capacity');
  const remaining=!deferred&&Number.isFinite(cutoff)&&cutoff>0
    ? Math.max(1,Math.floor(cutoff)-Math.max(0,Number.isFinite(executedFirst)?Math.floor(executedFirst):0))
    : COLD_CONTINUATION_OPERATIONS;
  const aggregate=Number.isFinite(aggregateBudget)
    ? Math.max(1,Math.min(DEFERRED_MAX_DISPATCH_OPERATIONS,Math.floor(aggregateBudget)))
    : CONTINUATION_DISPATCH_OPERATIONS;
  return Math.max(1,Math.min(remaining,COLD_CONTINUATION_OPERATIONS,
    Math.floor(aggregate/lanes)));
}

/** Survivors consumed their full allowance; completed lanes can only add cost.
 * Ignore sparse tails and completion-heavy passes when predicting a full pass.
 */
export function learnDeferredOperationCost(previous:number,ms:number,operations:number,before:number,survivors:number):number {
  if(!Number.isFinite(ms)||ms<=0||!Number.isSafeInteger(operations)||operations<1||
      !Number.isSafeInteger(before)||before<CONTINUATION_MAX_LANES||
      !Number.isSafeInteger(survivors)||survivors<before/2||survivors>before)return previous;
  return learnOrdinaryStripeCost(previous,ms,operations*survivors);
}

export function continuationLaneLimit(storageBytes:number):number {
  return Math.max(0,Math.min(CONTINUATION_MAX_LANES,
    Math.floor((storageBytes-CONTINUATION_HEADER_BYTES)/CONTINUATION_STATE_BYTES)));
}

export function deferredLaneLimit(storageBytes:number):number {
  if(!Number.isFinite(storageBytes))return 0;
  return Math.max(0,Math.min(DEFERRED_MAX_LANES,
    Math.floor((storageBytes-DEFERRED_HEADER_BYTES)/CONTINUATION_STATE_BYTES)));
}

export function continuationRegion(width:number,height:number,stride:number,limit:number) {
  const columns=Math.ceil(width/stride),rows=Math.ceil(height/stride);
  const lanes=columns*rows,bytes=CONTINUATION_HEADER_BYTES+lanes*CONTINUATION_STATE_BYTES;
  if(!Number.isSafeInteger(lanes)||lanes<1||lanes>CONTINUATION_MAX_LANES||bytes>limit)throw Error('Continuation region exceeds GPU scratch capacity');
  return {columns,rows,lanes,bytes};
}

export function deferredRegion(width:number,height:number,stride:number,limit:number) {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||!Number.isSafeInteger(stride)||
      width<1||height<1||stride<1||!Number.isFinite(limit))
    throw Error('Deferred continuation region exceeds GPU scratch capacity');
  const columns=Math.ceil(width/stride),rows=Math.ceil(height/stride);
  const lanes=columns*rows,bytes=DEFERRED_HEADER_BYTES+lanes*CONTINUATION_STATE_BYTES;
  if(!Number.isSafeInteger(columns)||!Number.isSafeInteger(rows)||columns<1||rows<1||
      !Number.isSafeInteger(lanes)||lanes>DEFERRED_MAX_LANES||bytes>limit)
    throw Error('Deferred continuation region exceeds GPU scratch capacity');
  return {columns,rows,lanes,bytes};
}

/** Cold continuation keeps its original header and state offsets. A separate
 * deferred pipeline is required for the larger pending bitset.
 */
export function continuationShaderSource(source:string,deferred=false):string {
  if(!deferred)return source;
  const bits='pendingBits: array<atomic<u32>, 128>,';
  if(source.split(bits).length!==2)throw Error('Continuation shader header no longer matches');
  return source.replace(bits,`pendingBits: array<atomic<u32>, ${DEFERRED_MAX_LANES/32}>,`);
}

/** The incumbent module stays byte-for-byte unchanged; only this entry resumes. */
export function continuationEntry(source:string) {
  const call='let s = iterateAny(pixel, distanceMode);';
  const known='let previous = field[fieldIndex(col, row)];';
  const skip='if (skipKnown) {';
  if(source.split(call).length!==2||source.split(known).length!==2||source.split(skip).length!==2)throw Error('Continuation shader entry no longer matches');
  return source.replace(call,'let s = iterateWideContinued(pixel, stateIndex);\n            if (s.z2 < 0.0) { return; }\n            if (continuation.resume != 0u) { atomicAnd(&continuation.pendingBits[stateIndex / 32u], ~(1u << (stateIndex % 32u))); }')
    .replace(known,known+'\n    let stateIndex = position.y * continuation.columns + position.x;\n    if (continuation.resume != 0u && (atomicLoad(&continuation.pendingBits[stateIndex / 32u]) & (1u << (stateIndex % 32u))) == 0u) { return; }')
    .replace(skip,
      'if (continuation.resume != 0u && determined && (u.reuseField != 2u || resolved)) {\n        retireContinuedSample(stateIndex);\n        return;\n    }\n    if (continuation.resume == 0u && skipKnown) {');
}
