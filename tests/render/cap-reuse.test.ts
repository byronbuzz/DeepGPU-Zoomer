import Decimal from 'decimal.js';
import {describe, expect, it} from 'vitest';
import {upwardCapRemap, type AdmittedSamples} from '../../src/render/cap-reuse';

const admitted=():AdmittedSamples=>({
  view:{centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal(1),width:65,height:49},
  maxIterations:5000,ordinary:true,policy:'same-numerical-policy',reference:{},approximation:{},
});

describe('admitted scalar cap provenance',()=>{
  it('permits a higher cap from an admitted partial field without claiming completion',()=>{
    const old=admitted(),next={...old,maxIterations:6000};
    expect(upwardCapRemap(old,next,true)).toEqual({offsetX:0,offsetY:0,step:1,denominator:1});
    expect(upwardCapRemap(null,next,true)).toBeNull();
  });
  it('requires an automatic upward change and supported policies on both fields',()=>{
    const old=admitted(),next={...old,maxIterations:6000};
    expect(upwardCapRemap(old,next,false)).toBeNull();
    expect(upwardCapRemap(old,{...next,maxIterations:5000},true)).toBeNull();
    expect(upwardCapRemap(old,{...next,maxIterations:4000},true)).toBeNull();
    expect(upwardCapRemap({...old,ordinary:false},next,true)).toBeNull();
    expect(upwardCapRemap(old,{...next,ordinary:false},true)).toBeNull();
  });
  it('rejects changed numerical policy, reference and approximation identity',()=>{
    const old=admitted(),next={...old,maxIterations:6000};
    for(const changed of [{policy:'other-method-or-precision'},{reference:{}},{approximation:{}}])
      expect(upwardCapRemap(old,{...next,...changed},true)).toBeNull();
  });
  it('reuses only exact sample coordinates through aligned dyadic maps',()=>{
    const old=admitted(),next={...old,maxIterations:6000};
    expect(upwardCapRemap(old,{...next,view:{...old.view,unitsPerPixel:new Decimal('.5')}},true))
      .toEqual({offsetX:32,offsetY:24,step:1,denominator:2});
    expect(upwardCapRemap(old,{...next,view:{...old.view,unitsPerPixel:new Decimal('.9')}},true)).toBeNull();
    expect(upwardCapRemap(old,{...next,view:{...old.view,centerX:new Decimal('.1')}},true)).toBeNull();
    expect(upwardCapRemap(old,{...next,view:{...old.view,angle:1}},true)).toBeNull();
  });
});
