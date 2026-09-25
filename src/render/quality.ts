import Decimal from 'decimal.js';
import type { FrameView } from './reprojection';

/** Four distinct quarter-pixel centres; never aliases the ordinary centre. */
export function oversampledView<T extends FrameView>(view:T):T {
  const D=Decimal.clone({precision:Math.max(Decimal.precision,view.unitsPerPixel.sd()+4)});
  return {...view,width:view.width*2,height:view.height*2,
    unitsPerPixel:new D(view.unitsPerPixel).div(2)};
}
