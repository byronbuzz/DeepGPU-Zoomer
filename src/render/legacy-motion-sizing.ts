/** Learn from normal moving work; never issue calibration GPU work. */
type Bin={last:number;count:number;budget:number;visits:number;ms:number;squareMs:number};
export class MotionSizing {
  private bins=new Map<number,Bin>();
  private serial=0;
  observe(budget:number,visits:number,ms:number){
    if(!(budget>=64&&Number.isFinite(budget)&&visits>=64&&ms>0&&Number.isFinite(visits)&&Number.isFinite(ms)))return;
    const key=Math.round(Math.log2(budget));
    this.serial++;
    const found=this.bins.get(key),old=found&&this.serial-found.last<=64?found:undefined;
    const mix=(a:number,b:number)=>.75*a+.25*b;
    this.bins.set(key,old?{last:this.serial,count:old.count+1,budget:mix(old.budget,budget),visits:mix(old.visits,visits),ms:mix(old.ms,ms),squareMs:mix(old.squareMs,ms*ms)}
      :{last:this.serial,count:1,budget,visits,ms,squareMs:ms*ms});
  }
  choose(incumbent:number,targetMs:number,preference:number){
    const fallback=(reason:string)=>({budget:incumbent,reason,changed:false,trainedBins:ready.length});
    const ready=[...this.bins.values()].filter(b=>this.serial-b.last<=64&&b.count>=3&&Math.sqrt(Math.max(0,b.squareMs-b.ms*b.ms))/b.ms<=.35);
    if(!(incumbent>=64&&targetMs>0))return fallback('invalid-budget');
    // Match like with like: requested budget identifies the control; actual
    // visits and time determine its measured throughput and latency.
    const anchor=ready.filter(b=>b.budget>=incumbent*.8&&b.budget<=incumbent*1.25)
      .sort((a,b)=>Math.abs(Math.log(a.budget/incumbent))-Math.abs(Math.log(b.budget/incumbent)))[0];
    if(!anchor)return fallback('learning-anchor');
    const p=.3+.5*Math.max(0,Math.min(100,preference))/100;
    const latencyWeight=(1-p)/p;
    const score=(b:Bin)=>Math.log(b.visits/b.ms)-latencyWeight*Math.log(Math.max(1,b.ms/targetMs));
    const candidates=ready.filter(b=>b.budget>=incumbent*.5&&b.budget<=incumbent*2);
    if(candidates.length<2)return fallback('insufficient-size-variety');
    const best=candidates.reduce((a,b)=>score(b)>score(a)?b:a,anchor);
    if(score(best)-score(anchor)<Math.log(1.08))return fallback('no-clear-benefit');
    const budget=Math.max(64,Math.min(incumbent*2,Math.max(incumbent*.5,Math.round(best.budget/64)*64)));
    return {budget,reason:'measured-tradeoff',changed:Math.abs(budget-incumbent)>=64,trainedBins:ready.length,
      predictedMs:best.ms,predictedVisits:best.visits,anchorMs:anchor.ms,anchorVisits:anchor.visits,anchorBudget:anchor.budget,scoreGain:Math.exp(score(best)-score(anchor))-1};
  }
}
