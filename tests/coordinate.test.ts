import { afterEach, describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { assertCoordinatePreparation, coordinateToFixed, MAX_FIXED_COORDINATE_LENGTH, MIN_COORDINATE_EXPONENT, parseCoordinateInput } from '../src/coordinate';
import { Camera, decodeView, encodeView, HOME, validateView } from '../src/state';
import { scaleDecimal } from '../src/arithmetic/types';

afterEach(() => vi.restoreAllMocks());

describe('bounded coordinate preparation', () => {
  it('rejects every center and Julia constant with extreme exponents before fixed expansion', () => {
    const fixed = vi.spyOn(Decimal.prototype, 'toFixed');
    for (const key of ['x', 'y', 'jx', 'jy'] as const) {
      for (const value of ['1e-10000', '-1e-100000', '1e-1000000000', '-1e-9000000000000001', `1e-${'9'.repeat(1000)}`]) {
        expect(() => validateView({ ...HOME, [key]: value })).toThrow(/coordinate precision profiles/);
      }
    }
    expect(fixed).not.toHaveBeenCalled();
  });

  it('guards direct Decimal inputs without invoking their dangerous expansion', () => {
    const fixed = vi.spyOn(Decimal.prototype, 'toFixed');
    for (const text of ['1e-1000000000', '-1e-1000000000', '1e1000000000', 'Infinity', 'NaN']) {
      expect(() => coordinateToFixed(new Decimal(text))).toThrow();
    }
    expect(fixed).not.toHaveBeenCalled();
  });

  it('uses the renderer precision floor and preserves both signs near its last binary quantum', () => {
    expect(MIN_COORDINATE_EXPONENT).toBe(-2457);
    for (const sign of ['', '-']) {
      const text = `${sign}9e-2457`;
      const value = parseCoordinateInput(text, 'x');
      const fixed = coordinateToFixed(value);
      expect(new Decimal(fixed).eq(text)).toBe(true);
      expect(scaleDecimal(fixed, 8160n)).toBe(sign ? -2n : 2n);
      expect(fixed.length).toBeLessThanOrEqual(MAX_FIXED_COORDINATE_LENGTH);
      expect(() => parseCoordinateInput(`${sign}9e-2458`, 'x')).toThrow(/coordinate precision profiles/);
    }
  });

  it('normalizes significand position when checking compact exponents, and accepts real zero', () => {
    expect(parseCoordinateInput('00090e-2458', 'x').eq('9e-2457')).toBe(true);
    expect(() => parseCoordinateInput('.09e-2456', 'x')).toThrow(/coordinate precision profiles/);
    for (const zero of ['0e-1000000000', '-0e-999999999999999999999999999', '0.000e+1000000000']) {
      expect(parseCoordinateInput(zero, 'x').isZero()).toBe(true);
    }
    expect(parseCoordinateInput('-0e-1000000000', 'x').isNegative()).toBe(true);
  });

  it('preserves supported deep views, all input digits and Julia constants without rounding', () => {
    const view = { ...HOME, family: 'julia' as const, x: '-1.234567890123456789e-2000', y: '1e-2400', span: '1e-2400', jx: '-9e-2457', jy: '1e-1000' };
    expect(decodeView(encodeView(view))).toEqual(view);
    const camera = new Camera(); camera.load(view);
    expect(camera.x.eq(view.x)).toBe(true);
    expect(camera.y.eq(view.y)).toBe(true);
    for (const key of ['x', 'y', 'jx', 'jy'] as const) expect(new Decimal(coordinateToFixed(new Decimal(view[key]))).eq(view[key])).toBe(true);
    const long = `1.${'2'.repeat(11980)}e-2400`;
    const fixed = coordinateToFixed(parseCoordinateInput(long, 'x'));
    expect(new Decimal(fixed).eq(long)).toBe(true);
    expect(fixed.length).toBeLessThanOrEqual(MAX_FIXED_COORDINATE_LENGTH);
  });

  it('retains the existing saved span and magnitude constraints', () => {
    expect(() => validateView({ ...HOME, span: '1e-2401' })).toThrow(/precision profiles/);
    expect(() => validateView({ ...HOME, x: '16.1' })).toThrow(/within/);
    expect(() => validateView({ ...HOME, jy: '-16.1' })).toThrow(/within/);
    expect(() => assertCoordinatePreparation(new Decimal(`1.${'1'.repeat(12000)}`))).toThrow(/precision profiles/);
  });
});
