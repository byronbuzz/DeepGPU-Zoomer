import type { TuningSettings } from '../tuning';

/** The selected dimensions describe one workgroup, not hardware wave width. */
export function deliveryWorkgroup(shape: TuningSettings['workgroupShape']) {
  const [x, y] = shape.split('x').map(Number);
  return { x, y };
}
