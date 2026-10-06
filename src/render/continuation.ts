/** WGSL WideContinuation: six 48-byte Wide values plus exact-cycle state. */
export const CONTINUATION_STATE_BYTES = 352;
export const CONTINUATION_MAX_LANES = 4096;
export const CONTINUATION_HEADER_BYTES = 16 + CONTINUATION_MAX_LANES / 8;
/** Mandatory safeguard for cold, expensive work.
 * This bounds recurrence/skip loop operations per lane, not elapsed GPU time.
 * Cheap, measured work can still use the ordinary bulk dispatch path.
 */
export const COLD_CONTINUATION_OPERATIONS = 4096;
/** Million-iteration requests never establish safety from an average cheap probe. */
export const MANDATORY_CONTINUATION_ITERATIONS = 1_000_000;
export const CONTINUATION_DISPATCH_OPERATIONS = CONTINUATION_MAX_LANES*256;

export function continuationOperations(maxIterations:number, msPerVisit:number, targetMs:number):number {
  const cold=!Number.isFinite(msPerVisit)||msPerVisit<=0;
  return maxIterations>COLD_CONTINUATION_OPERATIONS&&(maxIterations>=MANDATORY_CONTINUATION_ITERATIONS||cold||msPerVisit>targetMs)?COLD_CONTINUATION_OPERATIONS:0;
}

/** A measured allowance must not be raised by the old unmeasured batch floor. */
export function measuredContinuationBudget(msPerVisit:number,targetMs:number):number | undefined {
  return Number.isFinite(msPerVisit)&&msPerVisit>0&&Number.isFinite(targetMs)&&targetMs>0
    ? Math.max(1,targetMs/msPerVisit) : undefined;
}

/** Resume saved work in independently bounded slices. */
export function resumedContinuationOperations(admitted:number,lanes:number,stationary=false):number {
  // Settled work can amortize its counter fence across a larger bounded slice.
  // Keep the per-pixel bound and the motion dispatch allowance unchanged.
  const perLane=Math.floor(CONTINUATION_DISPATCH_OPERATIONS*(stationary?2:1)/Math.max(1,lanes));
  return Math.max(1,Math.min(admitted,COLD_CONTINUATION_OPERATIONS,perLane));
}

export function continuationLaneLimit(storageBytes:number):number {
  return Math.max(0,Math.min(CONTINUATION_MAX_LANES,
    Math.floor((storageBytes-CONTINUATION_HEADER_BYTES)/CONTINUATION_STATE_BYTES)));
}

export function continuationRegion(width:number,height:number,stride:number,limit:number,grid=1) {
  const columns=Math.ceil(width/stride)*grid,rows=Math.ceil(height/stride)*grid;
  const lanes=columns*rows,bytes=CONTINUATION_HEADER_BYTES+lanes*CONTINUATION_STATE_BYTES;
  if(!Number.isSafeInteger(lanes)||lanes<1||lanes>CONTINUATION_MAX_LANES||bytes>limit)throw Error('Continuation region exceeds GPU scratch capacity');
  return {columns,rows,lanes,bytes};
}

