import Decimal from "decimal.js";
import type { FrameView } from "./reprojection";

export interface SampleGridAnchor {
  /** Complex coordinate of the anchor field's top-left sample, not its edge. */
  originX: Decimal;
  originY: Decimal;
  unitsPerPixel: Decimal;
}

export interface SampleGridRemap {
  /** Source index = (offset + destination index * step) / denominator. */
  offsetX: number;
  offsetY: number;
  step: number;
  denominator: number;
}

// Coordinate planning needs exact sums of the finite decimal inputs, including
// cancellation at depth. Use a local constructor, without changing app precision.
function coordinateDecimal(values: Decimal[], extra = 0): typeof Decimal {
  const nonzero = values.filter(value => !value.isZero());
  const top = Math.max(0, ...nonzero.map(value => value.e));
  const bottom = Math.min(0, ...nonzero.map(value => value.e - value.sd() + 1));
  return Decimal.clone({ precision: Math.max(Decimal.precision, top - bottom + 32 + extra) });
}

export function createSampleGridAnchor(view: FrameView): SampleGridAnchor {
  const D = coordinateDecimal([view.centerX, view.centerY, view.unitsPerPixel]);
  const h = new D(view.unitsPerPixel);
  return {
    originX: new D(view.centerX).minus(h.times(view.width - 1).div(2)),
    originY: new D(view.centerY).plus(h.times(view.height - 1).div(2)),
    unitsPerPixel: h,
  };
}

/** Stable presentation coordinates prevent repeated nearest resampling from
 * accumulating subpixel drift. This never chooses numerical sample geometry. */
export function planRetainedView(
  view: FrameView,
  anchor: SampleGridAnchor,
  options: { overscan?: number } = {},
): FrameView {
  // Keep rotated visual snapshots in their source geometry. This axis-aligned
  // anchor never determines a rotated numerical sample grid.
  if(view.angle)return {...view};
  const overscan = options.overscan ?? 1.25;
  if (!Number.isFinite(overscan) || overscan < 1 || view.width <= 0 || view.height <= 0 ||
      view.unitsPerPixel.lte(0) || anchor.unitsPerPixel.lte(0)) {
    throw new Error("Invalid sample grid geometry");
  }
  const ratio = view.unitsPerPixel.div(anchor.unitsPerPixel);
  let level = ratio.log(2).floor().toNumber();
  const D = coordinateDecimal([view.centerX, view.centerY, view.unitsPerPixel,
    anchor.originX, anchor.originY, anchor.unitsPerPixel], Math.abs(level));
  const base = new D(anchor.unitsPerPixel);
  let spacing = base.times(new D(2).pow(level));
  // A logarithm rounded at an exact power of two must not choose the wrong tier.
  while (spacing.gt(view.unitsPerPixel)) { spacing = spacing.div(2); level--; }
  while (spacing.times(2).lte(view.unitsPerPixel)) { spacing = spacing.times(2); level++; }
  const expansion = new D(view.unitsPerPixel).div(spacing).toNumber() * overscan;
  // One sample of spare coverage at either edge covers snapping the centre.
  const width = Math.ceil((view.width * expansion + 2) / 8) * 8;
  const height = Math.ceil((view.height * expansion + 2) / 8) * 8;
  const halfX = new D(width - 1).div(2), halfY = new D(height - 1).div(2);
  // Nest pixel edges, not sample centres. Subdividing centre-aligned pixels
  // puts an old colour boundary through a new pixel centre, shifting that
  // boundary by half a pixel when the proxy is presented again.
  const originX=new D(anchor.originX).minus(base.div(2)).plus(spacing.div(2));
  const originY=new D(anchor.originY).plus(base.div(2)).minus(spacing.div(2));
  const column = new D(view.centerX).minus(originX).div(spacing).minus(halfX).toNearest(1);
  const row = originY.minus(view.centerY).div(spacing).minus(halfY).toNearest(1);
  const firstX = originX.plus(column.times(spacing));
  const firstY = originY.minus(row.times(spacing));
  return {
    centerX: firstX.plus(halfX.times(spacing)),
    centerY: firstY.minus(halfY.times(spacing)),
    unitsPerPixel: spacing, width, height,
  };
}

/** Exact source indices only: fractional, off-grid, or unsafe i32 maps cannot reuse. */
export function sampleGridRemap(previous: FrameView, next: FrameView): SampleGridRemap | null {
  if(previous.angle||next.angle)return null;
  if (previous.unitsPerPixel.lte(0) || next.unitsPerPixel.lte(0)) return null;
  const D = coordinateDecimal([previous.centerX, previous.centerY, previous.unitsPerPixel,
    next.centerX, next.centerY, next.unitsPerPixel]);
  const ratio = new D(next.unitsPerPixel).div(previous.unitsPerPixel);
  const level = ratio.log(2).toNearest(1).toNumber();
  // Positive signed i32 numerators are passed to the remap shader.
  if (!Number.isSafeInteger(level) || Math.abs(level) > 30 || !new D(2).pow(level).eq(ratio)) return null;
  const denominator = 2 ** Math.max(0, -level);
  const step = 2 ** Math.max(0, level);
  const old = createSampleGridAnchor(previous), target = createSampleGridAnchor(next);
  const x = new D(target.originX).minus(old.originX).div(previous.unitsPerPixel).times(denominator);
  const y = new D(old.originY).minus(target.originY).div(previous.unitsPerPixel).times(denominator);
  if (!x.isInteger() || !y.isInteger()) return null;
  const offsetX = x.toNumber(), offsetY = y.toNumber();
  const values = [offsetX, offsetY, offsetX + (next.width - 1) * step,
    offsetY + (next.height - 1) * step];
  if (!values.every(value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647)) return null;
  return { offsetX, offsetY, step, denominator };
}
