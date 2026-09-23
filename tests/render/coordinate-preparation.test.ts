import Decimal from 'decimal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLORS } from '../../src/logic/colorSettings';
import { WebGpuRenderer, type RenderRequest } from '../../src/render/webgpu-renderer';
import { scaleDecimal } from '../../src/arithmetic/types';
import { coordinateToFixed, MAX_FIXED_COORDINATE_LENGTH } from '../../src/coordinate';

const request = (): RenderRequest => ({
  centerX: new Decimal('-.6'), centerY: new Decimal(0),
  juliaX: new Decimal('-.8'), juliaY: new Decimal('.156'), family: 'julia',
  unitsPerPixel: new Decimal('1e-2000'), width: 8, height: 8,
  maxIterations: 1, colors: { ...DEFAULT_COLORS },
});

afterEach(() => vi.restoreAllMocks());

describe('renderer coordinate preparation boundaries (CPU only)', () => {
  it('rejects extreme centers and Julia constants at both public entries before fixed conversion or GPU preparation', async () => {
    const fixed = vi.spyOn(Decimal.prototype, 'toFixed');
    const limits = vi.fn(() => { throw Error('GPU preparation must not start'); });
    for (const key of ['centerX', 'centerY', 'juliaX', 'juliaY'] as const) {
      for (const text of ['1e-1000000000', '-1e-1000000000']) {
        const renderer: any = Object.create(WebGpuRenderer.prototype);
        renderer.ctx = { device: { get limits() { return limits(); } } };
        const originalView = request(); renderer.currentView = originalView;
        const invalid = { ...request(), [key]: new Decimal(text) };
        expect(() => renderer.reproject(invalid)).toThrow(/coordinate precision profiles/);
        expect(renderer.currentView).toBe(originalView);
        await expect(renderer.render(invalid)).rejects.toThrow(/coordinate precision profiles/);
      }
    }
    expect(fixed).not.toHaveBeenCalled();
    expect(limits).not.toHaveBeenCalled();
  });

  it('preserves deep signed coordinates in the actual reference-demand serializer', () => {
    const renderer: any = Object.create(WebGpuRenderer.prototype);
    const deep = { ...request(), centerX: new Decimal('-1.234567890123456789e-2000'), centerY: new Decimal('1e-2400'), juliaX: new Decimal('-9e-2457'), juliaY: new Decimal('9e-2457') };
    const demand = renderer.referenceDemand(deep, 256);
    for (const key of ['centerX', 'centerY', 'juliaX', 'juliaY'] as const) {
      expect(new Decimal(demand.input[key]).eq(deep[key]!)).toBe(true);
      expect(demand.input[key].length).toBeLessThanOrEqual(MAX_FIXED_COORDINATE_LENGTH);
    }
    expect(scaleDecimal(demand.input.juliaX, 8160n)).toBe(-2n);
    expect(scaleDecimal(demand.input.juliaY, 8160n)).toBe(2n);
    const fixed = vi.spyOn(Decimal.prototype, 'toFixed');
    expect(renderer.referenceDemandCompatible(demand, deep)).toBe(true);
    expect(renderer.referenceDemandCompatible(demand, { ...deep, juliaX: deep.juliaX.neg() })).toBe(false);
    expect(fixed).not.toHaveBeenCalled();
  });

  it('guards the offending value even if reference serialization is called directly', () => {
    const renderer: any = Object.create(WebGpuRenderer.prototype);
    for (const key of ['centerX', 'centerY', 'juliaX', 'juliaY'] as const) {
      const invalidValue = new Decimal('1e-1000000000');
      const fixed = vi.spyOn(invalidValue, 'toFixed');
      expect(() => renderer.referenceDemand({ ...request(), [key]: invalidValue }, 256)).toThrow(/coordinate precision profiles/);
      expect(fixed).not.toHaveBeenCalled();
    }
  });

  it('bounds preparation without changing the existing final-quantum rounding', () => {
    // The admitted final decimal decade straddles the binary rounding boundary.
    // Transport retains exact decimal values; scaleDecimal owns the old rounding.
    for (const text of ['1e-2457', '-1e-2457', '9e-2457', '-9e-2457']) {
      const fixed = coordinateToFixed(new Decimal(text));
      expect(new Decimal(fixed).eq(text)).toBe(true);
      expect(scaleDecimal(fixed, 8160n)).toBe(scaleDecimal(text, 8160n));
    }
    // Even the upper edge of the next decade cannot reach half a binary quantum.
    expect(scaleDecimal('9.999999999e-2458', 8160n)).toBe(0n);
    expect(() => coordinateToFixed(new Decimal('9.999999999e-2458'))).toThrow(/coordinate precision profiles/);
  });
});
