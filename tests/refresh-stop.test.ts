import {describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {DEFAULT_COLORS} from '../src/logic/colorSettings';
import {WebGpuRenderer} from '../src/render/webgpu-renderer';

describe('Refresh calculation state',()=>{
  it('invalidates current field and cache while retaining the displayed history',()=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype);
    const history={},lastFrame={},coverageHistory={},coverageFrame={};
    const reset=vi.fn();
    Object.assign(renderer,{
      abort:vi.fn(),publicationEpoch:4,cachedRequest:'old',cachedStats:{},fieldKey:'old',sampleKey:'old',
      fieldComplete:true,fieldDescriptor:{},fieldUniforms:new ArrayBuffer(4),fieldStats:{},
      partialAppearanceUniforms:new ArrayBuffer(4),incomingFrame:{},appearanceHoldFrame:{},
      pending:{reset},partialRegions:2,exactCompletedSamples:10,exactTotalSamples:10,
      historyValid:true,history,lastFrame,coverageHistory,coverageFrame,
    });
    renderer.restartCalculation();
    expect(renderer.abort).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledWith(0,0);
    expect(renderer.publicationEpoch).toBe(5);
    expect(renderer.cachedRequest).toBe('');
    expect(renderer.fieldKey).toBe('');
    expect(renderer.sampleKey).toBe('');
    expect(renderer.fieldComplete).toBe(false);
    expect(renderer.historyValid).toBe(true);
    expect(renderer.history).toBe(history);
    expect(renderer.lastFrame).toBe(lastFrame);
    expect(renderer.coverageHistory).toBe(coverageHistory);
    expect(renderer.coverageFrame).toBe(coverageFrame);
  });
  it('limits stale-colour fallback to the same numerical family and constant',()=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype);
    const frame={family:'julia',juliaX:new Decimal('-.8'),juliaY:new Decimal('.156'),maxIterations:3000,useApprox:true,colors:DEFAULT_COLORS};
    const request={...frame,colors:{...DEFAULT_COLORS,cycle:80}};
    expect(renderer.stalePresentationCompatible(frame,request)).toBe(true);
    expect(renderer.stalePresentationCompatible(frame,{...request,family:'mandelbrot'})).toBe(false);
    expect(renderer.stalePresentationCompatible(frame,{...request,juliaX:new Decimal('-.7')})).toBe(false);
    expect(renderer.stalePresentationCompatible(frame,{...request,maxIterations:3001})).toBe(false);
  });
});
