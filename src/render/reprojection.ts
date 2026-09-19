/**
 * Mapping one rendered frame onto a different view.
 *
 * Pure, and separate from the renderer, because it is easy to get subtly wrong
 * in a way that only shows up as motion on screen. It has been wrong twice:
 * once by presenting frames that were half-rendered, and once by treating a
 * change in *resolution* as a change in *scale*.
 */

import Decimal from "decimal.js";

/** A frame that was rendered, and the view it was rendered for. */
export interface FrameView {
  centerX: Decimal;
  centerY: Decimal;
  /** Complex units per device pixel — depends on resolution, not just zoom. */
  unitsPerPixel: Decimal;
  width: number;
  height: number;
}

/** `uv' = uv * scale + offset`, in normalised texture coordinates. */
export interface Reprojection {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const IDENTITY: Reprojection = { scale: 1, offsetX: 0, offsetY: 0 };

/**
 * Past this much magnification there is more stretched pixel than picture, and
 * zooming out far enough leaves the old frame a speck in the middle.
 */
const MAX_MAGNIFY = 8;
const MAX_SHRINK = 1 / 64;

/** Beyond this many screens of travel there is nothing left to reuse. */
const MAX_PAN_SCREENS = 4;

/**
 * How to draw `last` under `next`, or null when it is not worth reusing.
 *
 * Everything is expressed against the *view*, never against pixels. The two
 * frames routinely differ in resolution — interaction renders at a quarter
 * scale — and `unitsPerPixel` changes with resolution even when the view has
 * not moved at all. Dividing one by the other therefore reported a 4x zoom at
 * the start of every gesture and a 4x zoom back at the end of it, which is
 * exactly what a bounce looks like. The span across the viewport is the
 * quantity that means the same thing at any resolution.
 */
export function reprojectionFor(
  last: FrameView,
  next: FrameView
): Reprojection | null {
  if (last.width <= 0 || last.height <= 0 || next.width <= 0 || next.height <= 0) {
    return null;
  }

  // A different aspect ratio would stretch the picture rather than move it.
  const wasAspect = last.width / last.height;
  const nowAspect = next.width / next.height;
  if (Math.abs(wasAspect - nowAspect) > 0.01) return null;

  const lastSpanX = last.unitsPerPixel.times(last.width);
  const lastSpanY = last.unitsPerPixel.times(last.height);
  const nextSpanY = next.unitsPerPixel.times(next.height);
  if (lastSpanX.isZero() || lastSpanY.isZero()) return null;

  const scale = nextSpanY.div(lastSpanY).toNumber();
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if (scale > MAX_MAGNIFY || scale < MAX_SHRINK) return null;

  // Centre travel as a fraction of the old frame. Screen y runs downwards and
  // the imaginary axis upwards, hence the negation.
  const dx = next.centerX.minus(last.centerX).div(lastSpanX).toNumber();
  const dy = last.centerY.minus(next.centerY).div(lastSpanY).toNumber();
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) > MAX_PAN_SCREENS || Math.abs(dy) > MAX_PAN_SCREENS) return null;

  return {
    scale,
    offsetX: 0.5 * (1 - scale) + dx,
    offsetY: 0.5 * (1 - scale) + dy,
  };
}
