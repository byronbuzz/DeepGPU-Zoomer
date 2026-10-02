/** One prediction captured before submission; it belongs to its creating model. */
export interface SizeCostPrediction {
  readonly visits:number;
  readonly incumbentPredictedMs:number|undefined;
  readonly predictedMs:number|undefined;
}

export interface SizeCostStats {
  readonly observations:number;
  readonly pairedCount:number;
  readonly incumbentMeanAbsoluteMs:number|undefined;
  readonly predictedMeanAbsoluteMs:number|undefined;
}

/** Observation only. The owner replaces this model when its cost context changes. */
export class SizeCostPredictor {
  private readonly costs=new Float64Array(32);
  private readonly counts=new Uint8Array(32);
  private readonly pending=new WeakSet<SizeCostPrediction>();
  private observations=0;
  private pairedCount=0;
  private incumbentError=0;
  private predictedError=0;

  private bin(visits:number):number|undefined {
    // Thirty-two slots cover every positive u32-sized sample count.
    if(!Number.isInteger(visits)||visits<1||visits>0xffff_ffff)return;
    return Math.floor(Math.log2(visits));
  }

  predict(visits:number):number|undefined {
    const bin=this.bin(visits);
    if(bin===undefined||this.counts[bin]<2)return;
    const ms=this.costs[bin]*visits;
    return Number.isFinite(ms)&&ms>0?ms:undefined;
  }

  capture(visits:number,incumbentPredictedMs:number|undefined):SizeCostPrediction|undefined {
    if(this.bin(visits)===undefined)return;
    const ticket=Object.freeze({visits,predictedMs:this.predict(visits),
      incumbentPredictedMs:incumbentPredictedMs!==undefined&&Number.isFinite(incumbentPredictedMs)&&incumbentPredictedMs>0
        ?incumbentPredictedMs:undefined});
    this.pending.add(ticket);return ticket;
  }

  observe(ticket:SizeCostPrediction|undefined,gpuMs:number):SizeCostStats {
    // Reject foreign and repeated completions. Invalid timing also consumes its
    // ticket, so a later retry cannot reinterpret one submission as two samples.
    if(!ticket||!this.pending.delete(ticket))return this.stats;
    const cost=gpuMs/ticket.visits;
    if(!Number.isFinite(gpuMs)||gpuMs<=0||!Number.isFinite(cost)||cost<=0)return this.stats;
    if(ticket.incumbentPredictedMs!==undefined&&ticket.predictedMs!==undefined){
      this.pairedCount++;
      this.incumbentError+=(Math.abs(ticket.incumbentPredictedMs-gpuMs)-this.incumbentError)/this.pairedCount;
      this.predictedError+=(Math.abs(ticket.predictedMs-gpuMs)-this.predictedError)/this.pairedCount;
    }
    const bin=this.bin(ticket.visits)!;
    this.costs[bin]=this.counts[bin]?this.costs[bin]*.75+cost*.25:cost;
    this.counts[bin]=Math.min(2,this.counts[bin]+1);
    this.observations++;
    return this.stats;
  }

  get stats():SizeCostStats {
    return {observations:this.observations,pairedCount:this.pairedCount,
      incumbentMeanAbsoluteMs:this.pairedCount?this.incumbentError:undefined,
      predictedMeanAbsoluteMs:this.pairedCount?this.predictedError:undefined};
  }
}
