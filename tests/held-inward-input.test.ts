import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const expression=source.match(/function request\(\):RenderRequest\{[\s\S]*?(const heldZoom=[\s\S]*?)  const margin=/)![1];
// Exercise the actual request eligibility expression without starting a GPU.
const evaluate=new Function('state',`const {direction,keys,dragging,rotating,rotationSliderHeld,selecting,rotationKeys,
  wheelDirection,performance,lastInteraction}=state; ${expression} return {zoom,heldInwardZoom};`);
const requestInput=(overrides:Record<string,unknown>={})=>evaluate({direction:0,keys:new Set(),dragging:false,
  rotating:false,rotationSliderHeld:false,selecting:false,rotationKeys:new Set(),wheelDirection:0,
  performance:{now:()=>1000},lastInteraction:950,...overrides});

describe('held inward prediction eligibility',()=>{
  it('uses primary-button and plus/equal held input and exports the signal in requests',()=>{
    for(const input of [{direction:1},{keys:new Set(['+'])},{keys:new Set(['='])}])
      expect(requestInput(input)).toEqual({zoom:1,heldInwardZoom:true});
    expect(source).toContain('zoom,heldInwardZoom,zoomRate:speed');
  });

  it('retains wheel navigation while declining a continuing-motion forecast',()=>{
    expect(requestInput({wheelDirection:1})).toEqual({zoom:1,heldInwardZoom:false});
    expect(requestInput({wheelDirection:-1})).toEqual({zoom:-1,heldInwardZoom:false});
    expect(requestInput({wheelDirection:1,lastInteraction:0})).toEqual({zoom:0,heldInwardZoom:false});
    expect(requestInput()).toEqual({zoom:0,heldInwardZoom:false});
  });

  it('declines held outward input and simultaneous pan, rotation or selection',()=>{
    expect(requestInput({direction:-1})).toEqual({zoom:-1,heldInwardZoom:false});
    expect(requestInput({keys:new Set(['-'])})).toEqual({zoom:-1,heldInwardZoom:false});
    for(const modifier of ['dragging','rotating','rotationSliderHeld','selecting'])
      expect(requestInput({direction:1,[modifier]:true}).heldInwardZoom).toBe(false);
    expect(requestInput({direction:1,rotationKeys:new Set(['ArrowLeft'])}).heldInwardZoom).toBe(false);
    for(const arrow of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'])
      expect(requestInput({keys:new Set(['+',arrow])}).heldInwardZoom).toBe(false);
  });
});
