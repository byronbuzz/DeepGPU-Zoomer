import {describe,it,expect} from 'vitest';
import {motionBatchBudget} from '../src/render/motion-sizing';
import {DEFAULT_TUNING,modifiedTuningCount} from '../src/tuning';
describe('fixed directional zoom workload',()=>{
  it('applies the fixed allowance for the current direction without retained state',()=>{
    for(const incumbent of [64,147.25,4096,18273.495327,152355.69]){
      for(const inward of [false,true,true,false,true,false]){
        expect(motionBatchBudget(incumbent,inward)).toBe(incumbent*(inward?1.5:2));
      }
    }
  });
  it('does not mark retired stored workload preferences as modified tuning',()=>{
    for(const motionPreference of [0,50,100])expect(modifiedTuningCount({...DEFAULT_TUNING,motionPreference})).toBe(0);
  });
});
