/**
 * Mapping one rendered frame onto a different view.
 *
 * Pure, and separate from the renderer, because it is easy to get subtly wrong
 * in a way that only shows up as motion on screen. It has been wrong twice:
 * once by presenting frames that were half-rendered, and once by treating a
 * change in *resolution* as a change in *scale*.
 */

import Decimal from "decimal.js";
import { rotationBasis } from "../rotation";

/** A frame that was rendered, and the view it was rendered for. */
export interface FrameView {
  centerX: Decimal;
  centerY: Decimal;
  /** Complex units per device pixel — depends on resolution, not just zoom. */
  unitsPerPixel: Decimal;
  width: number;
  height: number;
  angle?: number;
}

/** Destination-to-source affine map in normalised texture coordinates. */
export interface Reprojection {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  /** Off-diagonal terms of the destination-UV to source-UV affine map. */
  crossX?: number;
  crossY?: number;
}

export function mapUv(m: Reprojection, x: number, y: number) {
  return { x: m.scaleX*x+(m.crossX??0)*y+m.offsetX,
    y: (m.crossY??0)*x+m.scaleY*y+m.offsetY };
}

export const IDENTITY: Reprojection = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };

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
  next: FrameView,
  /** A broader completed source may still fill holes after heavy magnification. */
  coarseFallback = false,
  /** Presentation only: keep a finite held-colour map after numerical reuse expires. */
  presentationOnly = false,
): Reprojection | null {
  if (last.width <= 0 || last.height <= 0 || next.width <= 0 || next.height <= 0) {
    return null;
  }

  const lastSpanX = last.unitsPerPixel.times(last.width);
  const lastSpanY = last.unitsPerPixel.times(last.height);
  const nextSpanY = next.unitsPerPixel.times(next.height);
  if (lastSpanX.isZero() || lastSpanY.isZero()) return null;

  const scaleY = nextSpanY.div(lastSpanY).toNumber();
  const scaleX = next.unitsPerPixel.times(next.width).div(lastSpanX).toNumber();
  if (![scaleX, scaleY].every(scale => Number.isFinite(scale) && scale > 0 &&
      (presentationOnly || coarseFallback || scale >= MAX_SHRINK) &&
      (presentationOnly || scale <= MAX_MAGNIFY))) return null;

  if ((last.angle??0)===(next.angle??0)) {
    // Same orientation, including the legacy zero-angle identity path.
    const {c,s}=rotationBasis(last.angle??0);
    const dxWorld=next.centerX.minus(last.centerX),dyWorld=next.centerY.minus(last.centerY);
    const dx=(last.angle??0)===0?dxWorld.div(lastSpanX).toNumber():dxWorld.times(c).plus(dyWorld.times(s)).div(lastSpanX).toNumber();
    const dy=(last.angle??0)===0?last.centerY.minus(next.centerY).div(lastSpanY).toNumber():dxWorld.times(s).minus(dyWorld.times(c)).div(lastSpanY).toNumber();
    if (!Number.isFinite(dx)||!Number.isFinite(dy)||
        !presentationOnly&&(Math.abs(dx)>MAX_PAN_SCREENS||Math.abs(dy)>MAX_PAN_SCREENS))return null;
    return {scaleX,scaleY,offsetX:0.5*(1-scaleX)+dx,offsetY:0.5*(1-scaleY)+dy};
  }

  // Centre travel as a fraction of the old frame. Screen y runs downwards and
  // the imaginary axis upwards, hence the negation.
  const old=rotationBasis(last.angle??0),relative=rotationBasis((next.angle??0)-(last.angle??0));
  const worldX=next.centerX.minus(last.centerX),worldY=next.centerY.minus(last.centerY);
  const dx=worldX.times(old.c).plus(worldY.times(old.s)).div(lastSpanX).toNumber();
  const dy=worldX.times(old.s).minus(worldY.times(old.c)).div(lastSpanY).toNumber();
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (!presentationOnly&&(Math.abs(dx) > MAX_PAN_SCREENS || Math.abs(dy) > MAX_PAN_SCREENS)) return null;

  // Cross terms use complex units per pixel and the opposite source axis.
  const crossX=next.unitsPerPixel.times(next.height).div(lastSpanX).toNumber()*relative.s;
  const crossY=-next.unitsPerPixel.times(next.width).div(lastSpanY).toNumber()*relative.s;
  const diagonalY=scaleY*relative.c;
  const diagonalX=scaleX*relative.c;
  return {
    scaleY:diagonalY,scaleX:diagonalX,crossX,crossY,
    offsetX:0.5*(1-diagonalX-crossX)+dx,
    offsetY:0.5*(1-diagonalY-crossY)+dy,
  };
}
