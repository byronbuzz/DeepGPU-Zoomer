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
  const desired = Math.min(input.maximum, Math.round(Math.max(input.base,
    input.base + input.depthGain * Math.max(0, input.depthDelta), input.capTarget)));
  const difference = desired - input.current;
  if (Math.abs(difference) < 16) return null;
  // A lower cap belongs to this zoom-out geometry, with no delayed application.
  if (difference < 0) return input.zoomDirection < 0 ? desired : null;
  // Preserve useful reference preparation. A later actual zoom event can retry;
  // completion or release alone must never make another cap decision.
  if (input.zoomDirection < 0 || input.referencePreparing || input.time - input.lastUpdate < 500) return null;
  return Math.min(desired, input.current + Math.max(128, Math.ceil(input.current * .15)));
}
