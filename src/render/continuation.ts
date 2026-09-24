/** WGSL WideContinuation: three 48-byte Wide values, scalar state, vec2 alignment. */
export const CONTINUATION_STATE_BYTES = 192;
export const CONTINUATION_MAX_LANES = 4096;
export const CONTINUATION_HEADER_BYTES = 16 + CONTINUATION_MAX_LANES / 8;

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
