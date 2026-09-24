import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RefiningStatus } from '../src/refining-status';
import { RANGE_DEFAULTS, wheelRangeValue } from '../src/range-controls';
import { DEFAULT_COLORS, cycleFromSlider } from '../src/logic/colorSettings';
import { HOME, iterationFromSlider } from '../src/state';
import { DEFAULT_TUNING, HARD_PIXEL_BUDGETS } from '../src/tuning';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('stable refinement display', () => {
  it('holds at the 249ms boundary, releases at 250ms, and restarts a hold on new motion', () => {
    const status = new RefiningStatus();
    expect(status.text(0, 9)).toBe('Refining ·   9%');
    status.start();
    expect(status.text(200, 57)).toBe('Refining ·   9%');
    status.finish(200);
    expect(status.text(449, 87)).toBe('Refining ·   9%');
    expect(status.text(450, 87)).toBe('Refining ·  87%');
    status.start();
    expect(status.text(500, 100)).toBe('Refining ·  87%');
    status.finish(600);
    expect(status.text(850, 100)).toBe('Refining · 100%');
    status.reset();
    expect(status.text(851, 0)).toBe('Refining ·   0%');
  });
  it('restarts wheel pause from each actual event and pads 9, 10 and 100 to equal width', () => {
    const status = new RefiningStatus();
    status.text(0, 9);
    status.wheel(100);
    status.wheel(300);
    expect(status.text(549, 10)).toBe('Refining ·   9%');
    expect(status.text(550, 10)).toBe('Refining ·  10%');
    expect(status.text(800, 100)).toBe('Refining · 100%');
    expect([9, 10, 100].map(n => status.text(1000, n).length)).toEqual([15, 15, 15]);
  });
  it('does not alter the separate timer or approved stopped and colour-data state', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain("stopped?'Stopped':preparingColourData?colourPreparationLabel(progress)");
    expect(main).toContain('refinementTime.wheelCameraChange(performance.now())');
    expect(main).toContain('refinementTime.complete(performance.now())');
  });
});

describe('range defaults and hover wheel', () => {
  it('covers every existing range with its actual factory value', () => {
    const ids = [...html.matchAll(/<input\b[^>]*id="([^"]+)"[^>]*type="range"/g)].map(match => match[1]).sort();
    expect(Object.keys(RANGE_DEFAULTS).sort()).toEqual(ids);
    expect(iterationFromSlider(RANGE_DEFAULTS['iteration-slider'])).toBe(HOME.iterations);
    expect(cycleFromSlider(RANGE_DEFAULTS.cycle)).toBeCloseTo(DEFAULT_COLORS.cycle);
    expect(RANGE_DEFAULTS.rotation).toBe(0);
    expect(RANGE_DEFAULTS.speed).toBe(0.7);
    expect(RANGE_DEFAULTS['panel-opacity']).toBe(0.8);
    expect(RANGE_DEFAULTS['tuning-batch-target']).toBe(DEFAULT_TUNING.batchTargetMs);
    expect(RANGE_DEFAULTS['tuning-batch-multiplier']).toBe(DEFAULT_TUNING.batchMultiplier);
    expect(HARD_PIXEL_BUDGETS[RANGE_DEFAULTS['tuning-hard-budget']]).toBe(DEFAULT_TUNING.hardPixelBudget);
    expect(RANGE_DEFAULTS['tuning-overscan-base']).toBe(DEFAULT_TUNING.overscanBase);
    expect(RANGE_DEFAULTS['tuning-overscan-max']).toBe(DEFAULT_TUNING.overscanMax);
    expect(RANGE_DEFAULTS['tuning-depth-gain']).toBe(DEFAULT_TUNING.dynamicDepthGain);
    expect(RANGE_DEFAULTS['tuning-cap-gain']).toBe(DEFAULT_TUNING.dynamicCapGain);
    for (const [id, key] of [['color-offset','offset'],['hue-rotation','hueRotation'],['slope-depth','slopeDepth'],['light-angle','lightAngle'],['light-elevation','lightElevation'],['ambient-light','ambientLight'],['specular-strength','specularStrength']] as const)
      expect(RANGE_DEFAULTS[id]).toBe(DEFAULT_COLORS[key]);
  });
  it('moves one native step, clamps, and avoids fractional drift', () => {
    expect(wheelRangeValue(0.8,0.2,3,'0.1',-100)).toBe(0.9);
    expect(wheelRangeValue(0.9,0.2,3,'0.1',100)).toBe(0.8);
    expect(wheelRangeValue(0,0,1,'0.001',100)).toBe(0);
    expect(wheelRangeValue(1,0,1,'0.001',-100)).toBe(1);
    expect(wheelRangeValue(0.5,0,1,'any',-100)).toBe(0.51);
    expect(wheelRangeValue(0.5,0,1,'any',100)).toBe(0.49);
  });
});
