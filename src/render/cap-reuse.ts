import type { FrameView } from './reprojection';
import { sampleGridRemap } from './sample-grid';

/** Provenance of the admitted scalar buffer, including an unfinished field. */
export interface AdmittedSamples {
  view: FrameView;
  policy: string;
  maxIterations: number;
  ordinary: boolean;
  reference: unknown;
  approximation: unknown;
}

/** Cap changes may reuse identical sample coordinates. Manual changes require
 * stationary, unchanged geometry; automatic navigation keeps its exact remap.
 * Decreases
 * additionally filter the remapped entries; only earlier escapes and analytic
 * interiors are retained. Numerical periodicity remains provisional and is
 * retried on a cap change; upgrades use the per-sample cap/provisional stamps. */
export function automaticCapRemap(previous: AdmittedSamples | null, next: AdmittedSamples, automatic: boolean, stationary = false) {
  if(!previous||!previous.ordinary||!next.ordinary||
    next.maxIterations===previous.maxIterations||previous.policy!==next.policy||
    previous.reference!==next.reference||previous.approximation!==next.approximation)return null;
  const a=previous.view,b=next.view;
  if(!automatic&&!(stationary&&a.width===b.width&&a.height===b.height&&
    a.centerX.eq(b.centerX)&&a.centerY.eq(b.centerY)&&a.unitsPerPixel.eq(b.unitsPerPixel)&&
    (a.angle??0)===(b.angle??0)))return null;
  return sampleGridRemap(previous.view,next.view);
}
