import type {FrameView} from './reprojection';
import type {Region} from './regions';
import {sampleGridRemap} from './sample-grid';
export interface ContinuationIdentity {
  epoch:number;policy:string;reference:object|null;orbit:object|null;table:object|null;index:object|null;
}
export interface PendingContinuation {
  scratch:GPUBuffer;capacity:number;region:Region;view:FrameView;identity:ContinuationIdentity;unfinished:number;operations:number;
}
type Rectangle={x:number;y:number;width:number;height:number};
/** Exact same-scale translations only; saved lanes retain their original layout. */
export function translatedContinuationRegion(pending:PendingContinuation,next:FrameView,visible?:Rectangle):Region|null {
  if(pending.view.angle||next.angle||!pending.view.unitsPerPixel.eq(next.unitsPerPixel))return null;
  const mapping=sampleGridRemap(pending.view,next);
  if(!mapping||mapping.step!==1||mapping.denominator!==1||mapping.offsetX%pending.region.stride||mapping.offsetY%pending.region.stride)return null;
  const region={...pending.region,x:pending.region.x-mapping.offsetX,y:pending.region.y-mapping.offsetY};
  if(region.x<0||region.y<0||region.x+region.width>next.width||region.y+region.height>next.height)return null;
  if(visible&&(region.x>=visible.x+visible.width||region.y>=visible.y+visible.height||region.x+region.width<=visible.x||region.y+region.height<=visible.y))return null;
  return region;
}
/** One explicit owner. A claimed buffer belongs to the caller's local finally. */
export class PendingContinuationSlot<T extends PendingContinuation=PendingContinuation> {
  private value:T|undefined;
  get size(){return this.value?1:0;}
  park(value:T){if(this.value?.scratch!==value.scratch)this.clear();this.value=value;}
  clear(){const value=this.value;this.value=undefined;value?.scratch.destroy();}
  claim(identity:ContinuationIdentity,next:FrameView,visible?:Rectangle):T|undefined {
    const value=this.value;if(!value)return;
    const old=value.identity;
    if(old.epoch!==identity.epoch||old.policy!==identity.policy||old.reference!==identity.reference||old.orbit!==identity.orbit||old.table!==identity.table||old.index!==identity.index){this.clear();return;}
    const region=translatedContinuationRegion(value,next,visible);if(!region){this.clear();return;}
    this.value=undefined;return {...value,region,view:next};
  }
}
