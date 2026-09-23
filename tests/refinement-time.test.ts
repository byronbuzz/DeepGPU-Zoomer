import {describe,expect,it} from 'vitest';
import {RefinementTimer} from '../src/refinement-time';

describe('refinement time',()=>{
  it('starts at the held-navigation release and freezes at completed publication',()=>{
    const timer=new RefinementTimer(0);
    timer.heldCameraChange();expect(timer.text(1200)).toBe('Time taken: 00:00.00');
    timer.complete(1250);timer.stopHeld(1400,false);
    expect(timer.text(3240)).toBe('Time taken: 00:01.84');
    timer.complete(3250);expect(timer.text(9000)).toBe('Time taken: 00:01.85');
  });
  it('times wheels from each actual camera change, including completion during debounce',()=>{
    const timer=new RefinementTimer(0);
    timer.wheelCameraChange(1000);timer.complete(1080);
    expect(timer.text(1250)).toBe('Time taken: 00:00.08');
    timer.wheelCameraChange(1300);
    expect(timer.text(1450)).toBe('Time taken: 00:00.15');
    timer.complete(1510);expect(timer.text(5000)).toBe('Time taken: 00:00.21');
  });
  it('retains completed time through hover and appearance work, and formats hours',()=>{
    const timer=new RefinementTimer(0);timer.complete(3_661_230);
    expect(timer.text(8_000_000)).toBe('Time taken: 01:01:01.23');
  });
  it('freezes an unfinished demand on Stop until an explicit new demand',()=>{
    const timer=new RefinementTimer(100);
    timer.halt(850);expect(timer.text(5000)).toBe('Time taken: 00:00.75');
    timer.demand(5100);expect(timer.text(5350)).toBe('Time taken: 00:00.25');
    timer.halt(5400);expect(timer.text(9000)).toBe('Time taken: 00:00.30');
  });
});
