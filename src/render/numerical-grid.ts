import Decimal from 'decimal.js';
import type { FrameView } from './reprojection';
import { estimateBinaryRatio, type SampleGridAnchor } from './sample-grid';

/** Use an existing completed-batch wall time; no extra GPU queries. Follow a
 * slow batch immediately, but shed a transient peak over subsequent batches. */
export function learnOutwardDelay(previous: number, elapsed: number): number {
  if (!Number.isFinite(elapsed) || elapsed <= 0) return previous;
  return Math.min(250, Math.max(elapsed, previous * .8));
}

export function outwardHorizonMs(delay: number): number {
  // Until measured, retain the conservative starting guard. Cheap batches
  // need less lead once the grid has passed its minimum residency interval.
  if (!Number.isFinite(delay) || delay <= 0) return 64;
  return Math.max(32, Math.min(160, delay + 16));
}

/** Symmetric bounds also cover zoom about an off-centre pointer. Allocation
 * always covers at least two target-residency intervals, even when cheap
 * batches allow a shorter guard. This leaves more reusable life in fast grids.
 * Allocation otherwise gets another residency interval beyond the guard. Caps
 * bound speculative area and leave headroom between trigger and allocation. */
export function outwardPadding(width: number, height: number, rate: number,
  focus: {x:number;y:number}, horizonMs: number, allocation = false): {x:number;y:number} {
  if (!Number.isFinite(rate) || rate <= 0) return {x:0,y:0};
  const horizon = allocation ? Math.max(64, horizonMs) + 64 : horizonMs;
  const growth = Math.expm1(Math.min(1, rate * horizon / 1000));
  const pad = (dimension:number, position:number) => {
    const f = Number.isFinite(position) ? position : .5;
    return Math.ceil(dimension * Math.min(allocation ? .25 : .125,
      growth * Math.max(Math.abs(f), Math.abs(1-f))) / 2) * 2;
  };
  return {x:pad(width,focus.x),y:pad(height,focus.y)};
}

export function containsNumericalView(field: FrameView, visible: FrameView,
  padding = {x:0,y:0}): boolean {
  return visible.centerX.minus(field.centerX).abs()
    .plus(visible.unitsPerPixel.times(visible.width/2+padding.x)).lte(field.unitsPerPixel.times(field.width/2)) &&
    visible.centerY.minus(field.centerY).abs()
    .plus(visible.unitsPerPixel.times(visible.height/2+padding.y)).lte(field.unitsPerPixel.times(field.height/2));
}

/** Plan a centre-aligned numerical lattice with nested sample centres.
 * The default preserves visible resolution. Outward motion may explicitly
 * request a preview with at most two display pixels between samples. */
export function planNumericalView(
  view: FrameView,
  anchor: SampleGridAnchor,
  limits: { maxDimension: number; maxSamples: number },
  outwardPreview = false,
): FrameView | null {
  const values = [view.centerX, view.centerY, view.unitsPerPixel,
    anchor.originX, anchor.originY, anchor.unitsPerPixel];
  if (view.angle || !values.every(value => value.isFinite()) ||
      view.unitsPerPixel.lte(0) || anchor.unitsPerPixel.lte(0) ||
      ![view.width, view.height, limits.maxDimension, limits.maxSamples]
        .every(value => Number.isSafeInteger(value) && value > 0)) return null;
  const level = Math.floor(estimateBinaryRatio(view.unitsPerPixel, anchor.unitsPerPixel))+(outwardPreview?1:0);
  if (!Number.isSafeInteger(level)) return null;
  // Exact finite-decimal sums must survive cancellation at arbitrarily deep views.
  const nonzero = values.filter(value => !value.isZero());
  const top = Math.max(0, ...nonzero.map(value => value.e));
  const bottom = Math.min(0, ...nonzero.map(value => value.e - value.sd() + 1));
  const D = Decimal.clone({ precision: Math.max(Decimal.precision, top - bottom + 32 + Math.abs(level)) });
  const visibleSpacing = new D(view.unitsPerPixel);
  const maximumSpacing = visibleSpacing.times(outwardPreview?2:1);
  let spacing = new D(anchor.unitsPerPixel).times(new D(2).pow(level));
  // Correct logarithmic rounding immediately beside a dyadic boundary.
  while (spacing.gt(maximumSpacing)) spacing = spacing.div(2);
  while (spacing.times(2).lte(maximumSpacing)) spacing = spacing.times(2);
  const expansion = visibleSpacing.div(spacing);
  // Two extra samples cover centre snapping and arithmetic at the footprint edge.
  // Block-rounded dimensions avoid allocating new textures on every zoom step.
  const width = expansion.times(view.width).plus(2).div(64).ceil().times(64).toNumber();
  const height = expansion.times(view.height).plus(2).div(64).ceil().times(64).toNumber();
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width > limits.maxDimension || height > limits.maxDimension ||
      width > Math.floor(limits.maxSamples / height)) return null;
  const halfX = new D(width - 1).div(2), halfY = new D(height - 1).div(2);
  const originX = new D(anchor.originX), originY = new D(anchor.originY);
  const column = new D(view.centerX).minus(originX).div(spacing).minus(halfX).toNearest(1);
  const row = originY.minus(view.centerY).div(spacing).minus(halfY).toNearest(1);
  return {
    centerX: originX.plus(column.plus(halfX).times(spacing)),
    centerY: originY.minus(row.plus(halfY).times(spacing)),
    unitsPerPixel: spacing, width, height,
  };
}
