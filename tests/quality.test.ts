import {describe,it,expect} from 'vitest';
import Decimal from 'decimal.js';
import {oversampledView} from '../src/render/quality';
import {createSampleGridAnchor,sampleGridRemap} from '../src/render/sample-grid';

describe('stationary quality coordinates',()=>{
  it('preserves centre, vertical span and rotation at the four distinct subpixel centres',()=>{
    const view={centerX:new Decimal(-.5),centerY:new Decimal(0),unitsPerPixel:new Decimal('.01'),width:30,height:20,angle:.4};
    const quality=oversampledView(view);
    expect([quality.width,quality.height]).toEqual([60,40]);
    expect(quality.centerX).toBe(view.centerX);expect(quality.centerY).toBe(view.centerY);expect(quality.angle).toBe(view.angle);
    expect(quality.unitsPerPixel.times(quality.height).eq(view.unitsPerPixel.times(view.height))).toBe(true);
    const a=createSampleGridAnchor({...view,angle:0}),b=createSampleGridAnchor({...quality,angle:0});
    expect(b.originX.minus(a.originX).eq(view.unitsPerPixel.div(-4))).toBe(true);
    expect(b.originY.minus(a.originY).eq(view.unitsPerPixel.div(4))).toBe(true);
  });
  it('does not map a centre sample onto the quarter-pixel lattice',()=>{
    const view={centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal('1e-350'),width:12,height:8};
    const fine=oversampledView(view);
    expect(sampleGridRemap(view,fine)).toBeNull();
  });
});
