import {describe,it,expect} from 'vitest';
import {MotionSizing} from '../src/render/motion-sizing';
import {DEFAULT_TUNING,modifiedTuningCount} from '../src/tuning';
describe('fixed directional zoom workload',()=>{
  it('applies the fixed direction allowance independently of preference and observation history',()=>{
    for(const inward of [false,true]){
      const sizing=new MotionSizing(true,inward);
      for(const incumbent of [64,147.25,4096,18273.495327,152355.69]){
        for(const preference of [0,50,100]){
          sizing.observe(64,56,200,230,8);
          sizing.observe(65536,65536,1,2,1);
          expect(sizing.choose(incumbent,16,preference)).toEqual({budget:incumbent*(inward?1.5:2),changed:true,reason:'fixed-directional-incumbent',trainedBins:0});
        }
      }
    }
  });
  it('does not mark retired stored workload preferences as modified tuning',()=>{
    for(const motionPreference of [0,50,100])expect(modifiedTuningCount({...DEFAULT_TUNING,motionPreference})).toBe(0);
  });
});
