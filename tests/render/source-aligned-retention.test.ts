import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { boundedRetainedView, sampleGridRemap, sourceAlignedRetainedView } from '../../src/render/sample-grid';
import { reprojectionFor, type FrameView } from '../../src/render/reprojection';

// Independent high-precision geometry oracle; never change Decimal's shared config.
const D = Decimal.clone({ precision: 500 });
const view = (width: number, height: number, units = '1', x = '0', y = '0'): FrameView => ({
  width, height, unitsPerPixel: new D(units), centerX: new D(x), centerY: new D(y),
});
const edges = (v: FrameView) => ({
  left: new D(v.centerX).minus(new D(v.unitsPerPixel).times(v.width).div(2)),
  right: new D(v.centerX).plus(new D(v.unitsPerPixel).times(v.width).div(2)),
  top: new D(v.centerY).plus(new D(v.unitsPerPixel).times(v.height).div(2)),
  bottom: new D(v.centerY).minus(new D(v.unitsPerPixel).times(v.height).div(2)),
});
const identity = (v: FrameView) => [v.width, v.height, v.centerX.toString(), v.centerY.toString(), v.unitsPerPixel.toString()];

function exactCrop(source: FrameView, visible: FrameView, crop: FrameView | null) {
  expect(crop).not.toBeNull();
  const retained = crop!, s = edges(source), r = edges(retained), v = edges(visible);
  expect(retained.unitsPerPixel.eq(source.unitsPerPixel)).toBe(true);
  expect(r.left.lte(v.left) && r.right.gte(v.right) && r.top.gte(v.top) && r.bottom.lte(v.bottom)).toBe(true);
  expect(r.left.gte(s.left) && r.right.lte(s.right) && r.top.lte(s.top) && r.bottom.gte(s.bottom)).toBe(true);
  const offsetX = r.left.minus(s.left).div(source.unitsPerPixel);
  const offsetY = s.top.minus(r.top).div(source.unitsPerPixel);
  expect(offsetX.isInteger() && offsetY.isInteger()).toBe(true);
  // Every retained cell centre must be the centre of one original cell.
  for (const col of [0, Math.floor(retained.width / 2), retained.width - 1]) {
    const actual = r.left.plus(new D(col).plus('.5').times(retained.unitsPerPixel));
    const original = s.left.plus(offsetX.plus(col).plus('.5').times(source.unitsPerPixel));
    expect(actual.eq(original)).toBe(true);
  }
  for (const row of [0, Math.floor(retained.height / 2), retained.height - 1]) {
    const actual = r.top.minus(new D(row).plus('.5').times(retained.unitsPerPixel));
    const original = s.top.minus(offsetY.plus(row).plus('.5').times(source.unitsPerPixel));
    expect(actual.eq(original)).toBe(true);
  }
  return { crop: retained, offsetX: offsetX.toNumber(), offsetY: offsetY.toNumber() };
}

// Binary32 destination-centre -> source texture lookup, without GPU execution.
function sampledIndex(index: number, destinationSize: number, sourceSize: number, scale: number, offset: number) {
  const f = Math.fround;
  const uv = f((index + .5) / destinationSize);
  return Math.floor(f(f(uv * f(scale)) + f(offset)) * sourceSize);
}

describe('source-aligned retained image geometry', () => {
  it.each([
    ['odd source and visible dimensions', view(73, 51, '.25'), view(11, 9, '.18', '.0375', '-.0875')],
    ['subpixel pan on an even source', view(80, 64, '.125', '2', '-3'), view(13, 11, '.09', '2.04125', '-3.06625')],
    ['source-sized identity', view(65, 49, '.2', '1.23', '-4.56'), view(65, 49, '.2', '1.23', '-4.56')],
  ])('preserves source centres and pixel edges: %s', (_name, source, visible) => {
    exactCrop(source as FrameView, visible as FrameView, sourceAlignedRetainedView(source as FrameView, visible as FrameView));
  });

  it('keeps source texels through subpixel camera motion, changing crop only at pixel boundaries', () => {
    const source = view(101, 81);
    const first = sourceAlignedRetainedView(source, view(9, 7, '.8', '.10', '-.10'))!;
    const sameCells = sourceAlignedRetainedView(source, view(9, 7, '.8', '.15', '-.15'))!;
    expect(identity(sameCells)).toEqual(identity(first));
    exactCrop(source, view(9, 7, '.8', '.61', '-.61'), sourceAlignedRetainedView(source, view(9, 7, '.8', '.61', '-.61')));
  });

  it('preserves e-172 offsets without mutating global Decimal settings or inputs', () => {
    const config = () => ({ precision: Decimal.precision, rounding: Decimal.rounding, toExpNeg: Decimal.toExpNeg,
      toExpPos: Decimal.toExpPos, minE: Decimal.minE, maxE: Decimal.maxE, modulo: Decimal.modulo });
    const before = config();
    const source = view(3201, 1801, '5e-175',
      '-0.74911227237781602683235476769425135993292709933303286396548077460183712372790493076909805419210414911133741966654713739086278717365135612119885064120345132514100424008994124778134832781471453331618582650952777625478296540443978634900178890507172809921359325',
      '0.049338112885240039721186514477687542018655024279402623319475316862798197748795400419120079408763864070129838342666503961410068023623045143215589753097870109493903830877985838877693572929668682530877103427774004747149323287494667219810754384891027228351539135');
    const visible: FrameView = { ...source, width: 1601, height: 901,
      centerX: new D(source.centerX).plus('1.875e-175'), centerY: new D(source.centerY).minus('3.125e-175'),
      unitsPerPixel: new D('6e-175') };
    const originals = [identity(source), identity(visible)];
    const result = exactCrop(source, visible, sourceAlignedRetainedView(source, visible));
    expect(sampleGridRemap(source, result.crop)).toEqual({ offsetX: result.offsetX, offsetY: result.offsetY, step: 1, denominator: 1 });
    expect([identity(source), identity(visible)]).toEqual(originals);
    expect(config()).toEqual(before);
  });

  it('accepts a crop exactly at the history capacity', () => {
    const source = view(4096, 2048), visible = view(2560, 1440);
    const result = exactCrop(source, visible, sourceAlignedRetainedView(source, visible));
    expect([result.crop.width, result.crop.height]).toEqual([2560, 1440]);
  });

  it.each([
    ['history width cap', view(4096, 2048), view(2561, 900), Infinity],
    ['history height cap', view(4096, 2048), view(1600, 1441), Infinity],
    ['device dimension cap', view(1024, 1024), view(513, 300), 512],
    ['visible footprint outside source', view(65, 49), view(2, 2, '1', '32', '0'), Infinity],
    ['rotated source', { ...view(65, 49), angle: .1 }, view(9, 7), Infinity],
    ['rotated visible camera', view(65, 49), { ...view(9, 7), angle: .1 }, Infinity],
    ['nonpositive source scale', view(65, 49, '0'), view(9, 7), Infinity],
    ['nonpositive visible scale', view(65, 49), view(9, 7, '-1'), Infinity],
  ])('declines lossless retention instead of coarsening: %s', (_name, source, visible, limit) => {
    expect(sourceAlignedRetainedView(source as FrameView, visible as FrameView, limit as number)).toBeNull();
  });

  it('allows a visible footprint that exactly touches the original texture edge', () => {
    const source = view(65, 49), visible = view(5, 7, '1', '30', '-21');
    const result = exactCrop(source, visible, sourceAlignedRetainedView(source, visible));
    expect(result.offsetX + result.crop.width).toBe(source.width);
    expect(result.offsetY + result.crop.height).toBe(source.height);
  });

  it('preserves the audit texel that the recorded retention transform omitted', () => {
    // Actual 609.8ms capture: adjacent retained columns read raw 1298,1300,1301.
    const oldScale = 0.48722410202026367, oldOffset = 0.25654420256614685;
    expect([468, 469, 470].map(x => sampledIndex(x, 1528, 3200, oldScale, oldOffset))).toEqual([1298, 1300, 1301]);
    const source = view(3200, 1792), visible = view(1600, 900, '.973037337');
    const { crop, offsetX, offsetY } = exactCrop(source, visible, sourceAlignedRetainedView(source, visible));
    const m = reprojectionFor(source, crop)!;
    expect(sampledIndex(1299 - offsetX, crop.width, source.width, m.scaleX, m.offsetX)).toBe(1299);
    expect(sampledIndex(896 - offsetY, crop.height, source.height, m.scaleY, m.offsetY)).toBe(896);
    // Check the whole two axes, not just the deliberately chosen audit point.
    for (let x = 0; x < crop.width; x++) expect(sampledIndex(x, crop.width, source.width, m.scaleX, m.offsetX)).toBe(x + offsetX);
    for (let y = 0; y < crop.height; y++) expect(sampledIndex(y, crop.height, source.height, m.scaleY, m.offsetY)).toBe(y + offsetY);
  });

  it('uses identical exact crop geometry for partial and completed snapshots instead of the full-field 2x tier', () => {
    const source = view(3200, 1800, '5e-173'), visible = view(1600, 900, '6e-173');
    const partial = exactCrop(source, visible, sourceAlignedRetainedView(source, visible));
    const completed = exactCrop(source, visible, sourceAlignedRetainedView({ ...source }, { ...visible }));
    expect(identity(completed.crop)).toEqual(identity(partial.crop));
    expect([completed.crop.width, completed.crop.height, completed.offsetX, completed.offsetY]).toEqual([1920, 1080, 640, 360]);
    expect(boundedRetainedView(source).unitsPerPixel.eq(source.unitsPerPixel.times(2))).toBe(true);
    expect(sampleGridRemap(source, completed.crop)).toEqual({ offsetX: 640, offsetY: 360, step: 1, denominator: 1 });
  });
});
