/** Measures one numerical demand from its stationary boundary to publication. */
export class RefinementTimer {
  private startedAt:number;
  private completedAt:number|null=null;
  private heldChanged=false;
  constructor(now:number){this.startedAt=now;}
  demand(now:number){this.startedAt=now;this.completedAt=null;this.heldChanged=false;}
  heldCameraChange(){this.heldChanged=true;this.completedAt=null;}
  wheelCameraChange(now:number){this.demand(now);}
  stopHeld(now:number,complete:boolean){
    if(this.heldChanged){this.startedAt=now;this.completedAt=complete?now:null;this.heldChanged=false;}
  }
  complete(now:number){if(!this.heldChanged&&this.completedAt===null)this.completedAt=now;}
  halt(now:number){if(this.completedAt===null)this.completedAt=now;this.heldChanged=false;}
  text(now:number){
    if(this.heldChanged)return 'Time taken: 00:00.00';
    const centiseconds=Math.floor(Math.max(0,(this.completedAt??now)-this.startedAt)/10);
    const seconds=Math.floor(centiseconds/100),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);
    const pad=(n:number)=>String(n).padStart(2,'0');
    return `Time taken: ${hours?`${pad(hours)}:`:''}${pad(minutes%60)}:${pad(seconds%60)}.${pad(centiseconds%100)}`;
  }
}
