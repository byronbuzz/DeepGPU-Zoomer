/** Fixed zoom policy over the renderer's existing GPU-cost allowance.
 * Basic timing feedback and occupancy minimums remain in the renderer.
 * There is no competing-size history, exploration, or slider preference.
 */
export function motionBatchBudget(incumbent:number,inward:boolean):number {
  return incumbent*(inward?1.5:2);
}
