import { describe, expect, it } from 'vitest';
import { dynamicLimitForZoom } from '../src/dynamic';

const event = {zoomDirection:1,time:1000,lastUpdate:0,base:5000,current:5000,
  depthDelta:2,depthGain:1000,capTarget:0,maximum:10_000_000,referencePreparing:false};

describe('Dynamic decisions belong to actual zoom events', () => {
  it('does not decide after release, even with a pending depth increase', () => {
    expect(dynamicLimitForZoom({...event,zoomDirection:0,time:10_000})).toBeNull();
    expect(dynamicLimitForZoom({...event,zoomDirection:0,current:7000,depthDelta:0})).toBeNull();
  });

  it('coalesces increases and waits for useful reference preparation', () => {
    expect(dynamicLimitForZoom(event)).toBe(5750);
    expect(dynamicLimitForZoom({...event,lastUpdate:800})).toBeNull();
    expect(dynamicLimitForZoom({...event,referencePreparing:true})).toBeNull();
    expect(dynamicLimitForZoom({...event,referencePreparing:false,time:1500})).toBe(5750);
  });

  it('adopts a lower cap at the zoom-out event without a coalescing delay', () => {
    const decrease={...event,current:7000,depthDelta:.5,lastUpdate:999,referencePreparing:true};
    expect(dynamicLimitForZoom({...decrease,zoomDirection:-1})).toBe(5500);
    expect(dynamicLimitForZoom({...decrease,zoomDirection:1})).toBeNull();
    expect(dynamicLimitForZoom({...event,zoomDirection:-1})).toBeNull();
  });

  it('retains the available cap signal, typed base, deadband and global ceiling', () => {
    expect(dynamicLimitForZoom({...event,depthDelta:0,capTarget:6000})).toBe(5750);
    expect(dynamicLimitForZoom({...event,current:6000,zoomDirection:-1,depthDelta:-10})).toBe(5000);
    expect(dynamicLimitForZoom({...event,depthDelta:.01})).toBeNull();
    expect(dynamicLimitForZoom({...event,current:9_999_990,depthDelta:20_000})).toBeNull();
    expect(dynamicLimitForZoom({...event,current:9_000_000,depthDelta:20_000})).toBe(10_000_000);
  });
});
