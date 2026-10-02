import {describe,expect,it} from 'vitest';
import {SizeCostPredictor} from '../../src/render/size-cost-predictor';

function observe(model:SizeCostPredictor,visits:number,ms:number,incumbent?:number){
  return model.observe(model.capture(visits,incumbent),ms);
}

describe('observation-only size cost predictor',()=>{
  it('requires two positive observations in the requested size bin',()=>{
    const model=new SizeCostPredictor();
    expect(model.predict(1024)).toBeUndefined();
    observe(model,1024,8);
    expect(model.predict(1024)).toBeUndefined();
    observe(model,1024,8);
    expect(model.predict(1024)).toBe(8);
    expect(model.predict(2048)).toBeUndefined();
    expect(model.stats).toEqual({observations:2,pairedCount:0,
      incumbentMeanAbsoluteMs:undefined,predictedMeanAbsoluteMs:undefined});
  });

  it('smooths per-visit costs within a bin without mixing adjacent bins',()=>{
    const model=new SizeCostPredictor();
    observe(model,4,2);observe(model,6,9);
    expect(model.predict(4)).toBe(3);
    expect(model.predict(6)).toBe(4.5);
    observe(model,8,80);observe(model,8,80);
    expect(model.predict(8)).toBe(80);expect(model.predict(4)).toBe(3);
    observe(model,4,7);
    expect(model.predict(4)).toBe(4);
  });

  it('pairs against the pre-submission prediction despite intervening observations',()=>{
    const model=new SizeCostPredictor();observe(model,16,4);observe(model,16,4);
    const captured=model.capture(16,10)!;
    expect(captured.predictedMs).toBe(4);expect(Object.isFrozen(captured)).toBe(true);
    observe(model,16,100,undefined);
    expect(model.predict(16)).toBe(28);
    const stats=model.observe(captured,6);
    expect(stats).toMatchObject({observations:4,pairedCount:1,incumbentMeanAbsoluteMs:4,predictedMeanAbsoluteMs:2});
  });

  it('does not fabricate trained predictions for earlier in-flight captures',()=>{
    const model=new SizeCostPredictor();
    const tickets=Array.from({length:3},()=>model.capture(64,10));
    for(const ticket of tickets)model.observe(ticket,8);
    expect(model.predict(64)).toBe(8);
    expect(model.stats.pairedCount).toBe(0);
  });

  it('reports both error means over exactly the same captured pairs',()=>{
    const model=new SizeCostPredictor();observe(model,32,8);observe(model,32,8);
    observe(model,32,12,20); // Captured model 8: errors 8 and 4.
    observe(model,32,10,undefined); // Trains, but contributes to neither mean.
    observe(model,32,8,12); // Captured model 9.25: errors 4 and 1.25.
    expect(model.stats).toEqual({observations:5,pairedCount:2,
      incumbentMeanAbsoluteMs:6,predictedMeanAbsoluteMs:2.625});
  });

  it('improves the shadow prediction in a fixed-overhead alternating-size regime',()=>{
    const model=new SizeCostPredictor();let scalar=0;
    for(let i=0;i<40;i++){
      const visits=i%2?4096:64,ms=8+.002*visits;
      const ticket=model.capture(visits,scalar>0?scalar*visits:undefined);
      model.observe(ticket,ms);
      scalar=scalar>0?.75*scalar+.25*ms/visits:ms/visits;
    }
    expect(model.stats.pairedCount).toBe(36);
    expect(model.stats.predictedMeanAbsoluteMs).toBe(0);
    expect(model.stats.incumbentMeanAbsoluteMs).toBeGreaterThan(5);
  });

  it('rejects invalid counts and nonpositive or nonfinite timing without feedback',()=>{
    const model=new SizeCostPredictor();
    for(const visits of [0,-1,.5,NaN,Infinity,-Infinity,2**32]){
      expect(model.capture(visits,1)).toBeUndefined();expect(model.predict(visits)).toBeUndefined();
    }
    for(const ms of [0,-1,NaN,Infinity,-Infinity]){
      const ticket=model.capture(16,1);
      model.observe(ticket,ms);model.observe(ticket,1);
    }
    // This positive finite time would underflow to a zero per-visit cost.
    observe(model,2**31,Number.MIN_VALUE);
    expect(model.stats.observations).toBe(0);expect(model.stats.pairedCount).toBe(0);
    expect(model.predict(16)).toBeUndefined();
  });

  it('trains valid observations without pairing invalid incumbent predictions',()=>{
    const model=new SizeCostPredictor();
    for(const incumbent of [0,-1,NaN,Infinity,-Infinity,undefined])observe(model,16,8,incumbent);
    expect(model.stats.observations).toBe(6);expect(model.stats.pairedCount).toBe(0);
    expect(model.predict(16)).toBe(8);
  });

  it('ignores duplicate or foreign tickets and leaves an old context independently owned',()=>{
    const previous=new SizeCostPredictor(),current=new SizeCostPredictor();
    const ticket=previous.capture(16,10)!;
    current.observe(ticket,8);expect(current.stats.observations).toBe(0);
    previous.observe(ticket,8);previous.observe(ticket,80);
    expect(previous.stats.observations).toBe(1);expect(previous.predict(16)).toBeUndefined();
    const forged={visits:16,incumbentPredictedMs:10,predictedMs:5};
    previous.observe(forged,8);expect(previous.stats.observations).toBe(1);
  });

  it('supports every bounded bin and never emits an overflowing prediction',()=>{
    const model=new SizeCostPredictor();
    for(let power=0;power<32;power++){
      const visits=2**power;observe(model,visits,visits*2);observe(model,visits,visits*2);
    }
    expect(model.stats.observations).toBe(64);
    expect(model.predict(1)).toBe(2);expect(model.predict(0xffff_ffff)).toBe(0xffff_ffff*2);
    const large=new SizeCostPredictor();observe(large,2,Number.MAX_VALUE);observe(large,2,Number.MAX_VALUE);
    expect(large.predict(2)).toBe(Number.MAX_VALUE);expect(large.predict(3)).toBeUndefined();
  });

  it('returns independent diagnostic snapshots',()=>{
    const model=new SizeCostPredictor(),initial=model.stats;
    observe(model,16,8);
    expect(initial.observations).toBe(0);expect(model.stats.observations).toBe(1);
  });
});
