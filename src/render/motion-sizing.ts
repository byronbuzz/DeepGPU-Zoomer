/** Fixed zoom policy over the renderer's existing GPU-cost allowance.
 * Basic timing feedback and occupancy minimums remain in the renderer.
 * There is no competing-size history, exploration, or slider preference.
 */
export class MotionSizing {
  constructor(_adaptive=true,private inward=false){}
  observe(_budget:number,_visits:number,_ms:number,_serviceMs:number,_stride=1){}
  choose(incumbent:number,_targetMs:number,_preference:number){
    const budget=incumbent*(this.inward?1.5:2);
    return {budget,changed:budget!==incumbent,reason:'fixed-directional-incumbent',trainedBins:0};
  }
}
