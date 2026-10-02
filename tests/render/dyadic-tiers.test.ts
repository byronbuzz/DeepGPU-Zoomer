import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { planNumericalView } from '../../src/render/numerical-grid';
import { createSampleGridAnchor, planRetainedView, sampleGridRemap } from '../../src/render/sample-grid';
import type { FrameView } from '../../src/render/reprojection';

const D = Decimal.clone({precision: 2600});
const frame = (spacing: Decimal, width = 1, height = 1): FrameView => ({
  centerX: new D('-.7454430899'), centerY: new D('.1199345507'),
  unitsPerPixel: spacing, width, height,
});

describe('dyadic tier boundaries', () => {
  it('handles decimal rollover and ratios beyond Number range using exact tier inequalities', () => {
    for (const [base, visible] of [
      ['1e-2400', '1e-209'], ['1e-209', '1e-2400'],
      ['9.999999999999999999999999999999e-209', '1e-208'],
      ['1e-208', '9.999999999999999999999999999999e-209'],
    ]) {
      const source = frame(new D(base), 64, 48), view = {...source, unitsPerPixel: new D(visible)};
      const anchor = createSampleGridAnchor(source);
      const planned = planNumericalView(view, anchor, {maxDimension: 8192, maxSamples: 1e8})!;
      const retained = planRetainedView(view, anchor, {overscan: 1});
      for (const grid of [planned, retained]) {
        expect(grid).not.toBeNull();
        expect(grid.unitsPerPixel.lte(view.unitsPerPixel)).toBe(true);
        expect(grid.unitsPerPixel.times(2).gt(view.unitsPerPixel)).toBe(true);
      }
    }
  });

  it('corrects approximate logarithms on either side of exact tiers, even below Number range', () => {
    for (const depth of [0, 209, 2400]) {
      const base = new D(`1e-${depth}`), source = frame(base, 64, 48);
      const anchor = createSampleGridAnchor(source);
      for (const level of [-31, -1, 0, 1, 30]) {
        const boundary = base.times(new D(2).pow(level));
        for (const side of [-1, 0, 1]) {
          const spacing = boundary.times(new D(1).plus(new D('1e-100').times(side)));
          const view = {...source, unitsPerPixel: spacing};
          const expected = side < 0 ? boundary.div(2) : boundary;
          for (const outward of [false, true]) {
            const planned = planNumericalView(view, anchor, {maxDimension: 8192, maxSamples: 1e8}, outward)!;
            expect(planned).not.toBeNull();
            expect(planned.unitsPerPixel.eq(expected.times(outward ? 2 : 1))).toBe(true);
          }
          const retained = planRetainedView(view, anchor, {overscan: 1});
          expect(retained.unitsPerPixel.eq(expected)).toBe(true);
        }
      }
    }
  });

  it('admits exact dyadic remaps only, preserving signed shader limits', () => {
    for (const depth of [0, 209, 2400]) {
      const base = new D(`1e-${depth}`), source = frame(base);
      for (const level of [-30, -1, 0, 1, 30]) {
        const spacing = base.times(new D(2).pow(level));
        expect(sampleGridRemap(source, frame(spacing))).toEqual({
          offsetX: 0, offsetY: 0, step: 2 ** Math.max(0, level), denominator: 2 ** Math.max(0, -level),
        });
        for (const side of [-1, 1]) {
          const near = spacing.times(new D(1).plus(new D('1e-100').times(side)));
          expect(sampleGridRemap(source, frame(near))).toBeNull();
        }
      }
      for (const level of [-31, 31]) expect(sampleGridRemap(source, frame(base.times(new D(2).pow(level))))).toBeNull();
    }
  });
});
