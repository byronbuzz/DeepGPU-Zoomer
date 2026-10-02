import {describe,expect,it} from 'vitest';
import Decimal from 'decimal.js';
import {Method,methodForScale} from '../../src/render/webgpu-renderer';
import {DEFAULT_TUNING} from '../../src/tuning';

describe('owner-fixed Direct crossover',()=>{
  it('preserves the 14.75 pixel-spacing threshold and its boundary direction',()=>{
    expect(DEFAULT_TUNING.directExponent).toBe(14.75);
    const boundary=new Decimal(10**-14.75);
    expect(methodForScale(boundary.times('1.000000000001'))).toBe(Method.Direct);
    expect(methodForScale(boundary)).not.toBe(Method.Direct);
    expect(methodForScale(boundary.times('0.999999999999'))).not.toBe(Method.Direct);
  });
  it('keeps the crossover tied to pixel spacing across viewport heights',()=>{
    const boundary=new Decimal(10**-14.75);
    for(const height of [480,900,1440,2880]){
      const span=boundary.times(height);
      expect(methodForScale(span.times('1.000000000001').div(height))).toBe(Method.Direct);
      expect(methodForScale(span.times('0.999999999999').div(height))).not.toBe(Method.Direct);
    }
  });
});
