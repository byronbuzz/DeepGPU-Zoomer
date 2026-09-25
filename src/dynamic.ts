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
  capTarget: number;
  maximum: number;
  referencePreparing: boolean;
}): number | null {
  if (!input.zoomDirection) return null;
  const depthTarget=dynamicDepthTarget(input.base,input.depthDelta,input.depthGain,input.maximum);
  const uplift=input.zoomDirection>0?Math.max(0,input.capTarget-input.base):0;
  const desired=Math.min(input.maximum,Math.round(depthTarget+uplift));
  const difference = desired - input.current;
  if (Math.abs(difference) < 16) return null;
  const step=Math.max(128,Math.ceil(input.current*.15));
  // Ignore stale cap feedback on the outward path. Bound removal of any old
  // uplift so reversal does not collapse the effective limit in one event.
  if(difference<0)return input.zoomDirection<0?Math.max(desired,input.current-step):null;
  // Preserve useful reference preparation. A later actual zoom event can retry;
  // completion or release alone must never make another cap decision.
  if (input.zoomDirection < 0 || input.referencePreparing || input.time - input.lastUpdate < 500) return null;
  return Math.min(desired, input.current + step);
}
