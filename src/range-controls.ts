import { DEFAULT_COLORS, cycleToSlider } from './logic/colorSettings';
import { HOME, iterationToSlider } from './state';
import { DEFAULT_TUNING, HARD_PIXEL_BUDGETS } from './tuning';

/** Values in each range's own coordinate system, sourced from app defaults. */
export const RANGE_DEFAULTS: Record<string, number> = {
  speed: 0.7,
  'iteration-slider': iterationToSlider(HOME.iterations),
  rotation: HOME.angle ?? 0,
  cycle: cycleToSlider(DEFAULT_COLORS.cycle),
  'color-offset': DEFAULT_COLORS.offset,
  'hue-rotation': DEFAULT_COLORS.hueRotation,
  'slope-depth': DEFAULT_COLORS.slopeDepth,
  'light-angle': DEFAULT_COLORS.lightAngle,
  'light-elevation': DEFAULT_COLORS.lightElevation,
  'ambient-light': DEFAULT_COLORS.ambientLight,
  'specular-strength': DEFAULT_COLORS.specularStrength,
  'panel-opacity': 0.8,
  'tuning-batch-target': DEFAULT_TUNING.batchTargetMs,
  'tuning-batch-multiplier': DEFAULT_TUNING.batchMultiplier,
  'tuning-hard-budget': HARD_PIXEL_BUDGETS.indexOf(DEFAULT_TUNING.hardPixelBudget as typeof HARD_PIXEL_BUDGETS[number]),
  'tuning-overscan-base': DEFAULT_TUNING.overscanBase,
  'tuning-overscan-max': DEFAULT_TUNING.overscanMax,
  'tuning-depth-gain': DEFAULT_TUNING.dynamicDepthGain,
  'tuning-cap-gain': DEFAULT_TUNING.dynamicCapGain,
};

export function wheelRangeValue(value: number, min: number, max: number, step: string, deltaY: number) {
  if (!deltaY || !Number.isFinite(deltaY) || max <= min) return value;
  const direction = deltaY < 0 ? 1 : -1;
  if (step === 'any') return Math.max(min, Math.min(max, value + direction * (max - min) / 100));
  const numericStep = Number(step || 1);
  if (!Number.isFinite(numericStep) || numericStep <= 0) return value;
  const decimals = (number: number) => (String(number).split('.')[1] ?? '').length;
  const scale = 10 ** Math.min(12, Math.max(decimals(min), decimals(numericStep)));
  const base = Math.round(min * scale), unit = Math.round(numericStep * scale);
  const index = Math.round((Math.round(value * scale) - base) / unit) + direction;
  return Math.max(min, Math.min(max, (base + index * unit) / scale));
}

/** Attach to the existing inputs after their app handlers have been installed. */
export function setupRangeControls() {
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(input => {
    const dispatch = (factoryReset = false) => {
      input.dispatchEvent(factoryReset ? new CustomEvent('input', { bubbles: true, detail: { factoryReset: true } }) : new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    let suppressClick = false;
    input.addEventListener('pointerdown', event => {
      if (!event.ctrlKey || event.button !== 0 || input.disabled || !input.getClientRects().length) return;
      const factory = RANGE_DEFAULTS[input.id];
      if (factory === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = true;
      input.focus();
      input.value = String(factory);
      dispatch(true);
      const finish = () => {
        document.removeEventListener('pointerup', finish, true);
        document.removeEventListener('pointercancel', finish, true);
        setTimeout(() => { suppressClick = false; }, 0);
      };
      document.addEventListener('pointerup', finish, true);
      document.addEventListener('pointercancel', finish, true);
    }, true);
    input.addEventListener('click', event => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = false;
    }, true);
    input.addEventListener('wheel', event => {
      if (input.disabled || !input.getClientRects().length) return;
      event.preventDefault();
      event.stopPropagation();
      const next = wheelRangeValue(Number(input.value), Number(input.min || 0), Number(input.max || 100), input.step, event.deltaY);
      if (next === Number(input.value)) return;
      input.value = String(next);
      dispatch();
    }, { passive: false });
  });
}
