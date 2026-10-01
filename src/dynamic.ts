/** Evaluate signed depth from the anchor, without accumulating rounded steps. */
export function dynamicDepthTarget(base:number,depthDelta:number,depthGain:number,maximum:number){
  return Math.max(1,Math.min(maximum,base+depthGain*depthDelta));
}

/** A decision for this real zoom event only; no pending decision survives it. */
export function dynamicLimitForZoom(input: {
  zoomDirection: number;
  time: number;
  lastUpdate: number;
  base: number;
  current: number;
  depthDelta: number;
  depthGain: number;

  maximum: number;
  referencePreparing: boolean;
  /** Direct retains its timed cadence; deep changes are gated by preparation. */
  updateIntervalMs?: number;
}): number | null {
  if (!input.zoomDirection) return null;
  if (input.time - input.lastUpdate < (input.updateIntervalMs??500)) return null;
  const depthTarget=dynamicDepthTarget(input.base,input.depthDelta,input.depthGain,input.maximum);

  const desired=Math.min(input.maximum,Math.round(depthTarget));
  const difference = desired - input.current;
  if (Math.abs(difference) < 16) return null;
  const step=Math.max(128,Math.ceil(input.current*.15));
  // Bound depth-driven decreases on outward zoom events.
  if(difference<0)return input.zoomDirection<0?Math.max(desired,input.current-step):null;
  // Preserve useful reference preparation. A later actual zoom event can retry;
  // completion or release alone must never change the iteration limit.
  if (input.zoomDirection < 0 || input.referencePreparing) return null;
  return Math.min(desired, input.current + step);
}
