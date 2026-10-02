// Existing initial sample budget, shared here as the inward occupancy floor.
export const MIN_BATCH_SAMPLES = 16_384;

/** Split an already selected region; keep the shader's 16x8-sample reuse blocks. */
export function ordinaryStripeRows(width:number,remainingRows:number,stride:number,msPerVisit:number,allowanceMs=12,minimumSamples=MIN_BATCH_SAMPLES,workgroupRows=4){
  if(!Number.isFinite(msPerVisit)||msPerVisit<=0)return remainingRows;
  const blockRows=2*workgroupRows;
  const alignment=blockRows*stride;
  const columns=Math.ceil(width/stride);
  const sampleRows=Math.floor(allowanceMs/(columns*msPerVisit));
  const minimumRows=Math.ceil(minimumSamples/(columns*blockRows))*alignment;
  // Preserve useful occupancy; this minimum (or the tail) may exceed the allowance.
  const rows=Math.min(remainingRows,Math.max(minimumRows,Math.floor(sampleRows/blockRows)*alignment));
  // Avoid a separate underfilled final pass; only the final stripe may be unaligned.
  const tail=remainingRows-rows;
  return tail>0&&tail<minimumRows?remainingRows:rows;
}

/** Local prediction only: expensive stripes react immediately, cheap reuse grows gradually. */
export function learnOrdinaryStripeCost(previous:number,ms:number,visits:number){
  if(!Number.isFinite(ms)||ms<0||!Number.isFinite(visits)||visits<=0)return previous;
  // A quantized zero permits only bounded local growth; it is not free-work feedback.
  return Math.max(ms/visits,previous/2);
}
