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

/** This permits only an automatic upward-cap remap at identical sample coordinates.
 * The existing shader cap stamps decide which copied samples need more work. */
export function upwardCapRemap(previous: AdmittedSamples | null, next: AdmittedSamples, automatic: boolean) {
  if(!automatic||!previous||!previous.ordinary||!next.ordinary||
    next.maxIterations<=previous.maxIterations||previous.policy!==next.policy||
    previous.reference!==next.reference||previous.approximation!==next.approximation)return null;
  return sampleGridRemap(previous.view,next.view);
}
