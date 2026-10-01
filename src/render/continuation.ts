/** WGSL WideContinuation: five 48-byte Wide values plus exact-cycle state. */
export const CONTINUATION_STATE_BYTES = 304;
export const CONTINUATION_MAX_LANES = 4096;
export const CONTINUATION_HEADER_BYTES = 16 + CONTINUATION_MAX_LANES / 8;

/** Mandatory cold-work guard, independent of the optional hard-pixel control.
 * This bounds recurrence/skip loop operations per lane, not elapsed GPU time.
 * Cheap, measured work can still use the ordinary bulk dispatch path.
 */
export const COLD_CONTINUATION_OPERATIONS = 4096;
export const CONTINUATION_DISPATCH_OPERATIONS = CONTINUATION_MAX_LANES*256;

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

export function continuationLaneLimit(storageBytes:number):number {
  return Math.max(0,Math.min(CONTINUATION_MAX_LANES,
    Math.floor((storageBytes-CONTINUATION_HEADER_BYTES)/CONTINUATION_STATE_BYTES)));
}

export function continuationRegion(width:number,height:number,stride:number,limit:number) {
  const columns=Math.ceil(width/stride),rows=Math.ceil(height/stride);
  const lanes=columns*rows,bytes=CONTINUATION_HEADER_BYTES+lanes*CONTINUATION_STATE_BYTES;
  if(!Number.isSafeInteger(lanes)||lanes<1||lanes>CONTINUATION_MAX_LANES||bytes>limit)throw Error('Continuation region exceeds GPU scratch capacity');
  return {columns,rows,lanes,bytes};
}

/** The incumbent module stays byte-for-byte unchanged; only this entry resumes. */
export function continuationEntry(source:string) {
  const call='let s = iterateAny(pixel, distanceMode);';
  const known='let previous = field[fieldIndex(col, row)];';
  if(source.split(call).length!==2||source.split(known).length!==2)throw Error('Continuation shader entry no longer matches');
  return source.replace(call,'let s = iterateWideContinued(pixel, stateIndex);\n            if (s.z2 < 0.0) { return; }\n            if (continuation.resume != 0u) { atomicAnd(&continuation.pendingBits[stateIndex / 32u], ~(1u << (stateIndex % 32u))); }')
    .replace(known,known+'\n    let stateIndex = gid.y * continuation.columns + gid.x;\n    if (continuation.resume != 0u && (atomicLoad(&continuation.pendingBits[stateIndex / 32u]) & (1u << (stateIndex % 32u))) == 0u) { return; }')
    .replace('if (skipKnown) {',
      'if (continuation.resume == 0u && skipKnown) {');
}
