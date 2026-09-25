import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { checkedExportDimensions, EXPORT_MEMORY_LIMIT, frameForExport, planExport } from '../../src/export/layout';

const limits = { maxTextureDimension2D: 8192, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024 };
describe('PNG layout and budgets', () => {
  it('preserves vertical span for wider and taller output without changing scale precision', () => {
    const view = { width: 1600, height: 900, unitsPerPixel: new Decimal('4.4938757028245873087e-26') };
    const precision = Decimal.precision;
    expect(frameForExport(view, 3200, 1800).eq('2.24693785141229365435e-26')).toBe(true);
    expect(frameForExport(view, 3200, 900).eq(view.unitsPerPixel)).toBe(true);
    expect(frameForExport(view, 1600, 1800).eq('2.24693785141229365435e-26')).toBe(true);
    expect(Decimal.precision).toBe(precision);
  });

  it('supports 3x 4K with all samples, endpoints and AA under the declared estimate', () => {
    const plan = planExport(11520, 6480, { limits, sampleGrid: 3, endpointBytesPerSample: 16, halo: 6 });
    expect(plan.peakBytes).toBeLessThanOrEqual(EXPORT_MEMORY_LIMIT);
    expect(plan.maxEncodedBytes).toBeGreaterThan(11520 * 6480 * 4);
    expect(plan.workingBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(plan.stripRows).toBe(64);
    let nextY = 0, count = 0;
    for (const strip of plan.strips()) {
      expect(strip.y).toBe(nextY); let nextX = 0;
      for (const tile of strip.tiles) {
        expect(tile.core.x).toBe(nextX); expect(tile.core.y).toBe(strip.y); expect(tile.core.height).toBe(strip.height);
        expect(tile.padded.x).toBe(Math.max(0, tile.core.x - 6));
        expect(tile.padded.y).toBe(Math.max(0, tile.core.y - 6));
        expect(tile.padded.x + tile.padded.width).toBe(Math.min(11520, tile.core.x + tile.core.width + 6));
        expect(tile.padded.y + tile.padded.height).toBe(Math.min(6480, tile.core.y + tile.core.height + 6));
        expect(tile.padded.width * tile.padded.height * 9 * 16).toBeLessThanOrEqual(limits.maxStorageBufferBindingSize);
        expect(tile.padded.width).toBeLessThanOrEqual(limits.maxTextureDimension2D);
        nextX += tile.core.width; count++;
      }
      expect(nextX).toBe(11520); nextY += strip.height;
    }
    expect(nextY).toBe(6480); expect(count).toBe(plan.tileCount);
  });

  it('reduces tiles and strips to actual device limits without dropping sample quality', () => {
    const small = { maxTextureDimension2D: 32, maxStorageBufferBindingSize: 8192, maxBufferSize: 8192 };
    const plan = planExport(73, 69, { limits: small, sampleGrid: 2, endpointBytesPerSample: 16, halo: 1 });
    for (const strip of plan.strips()) for (const { padded } of strip.tiles) {
      expect(padded.width).toBeLessThanOrEqual(32); expect(padded.height).toBeLessThanOrEqual(32);
      expect(padded.width * padded.height * 4 * 16).toBeLessThanOrEqual(8192);
      expect(Math.ceil(padded.width * 4 / 256) * 256 * padded.height).toBeLessThanOrEqual(8192);
    }
  });

  it.each([[0, 1], [1.5, 2], [Infinity, 2], [Number.MAX_SAFE_INTEGER, 2], [11520, 7000], [1, 80_000_001]])('rejects unsafe dimensions %s x %s', (w, h) => {
    expect(() => checkedExportDimensions(w, h)).toThrow();
  });

  it('rejects a scanline too large for the bounded working area and an impossible halo', () => {
    expect(() => planExport(80_000_000, 1, { limits, sampleGrid: 1, endpointBytesPerSample: 0, halo: 1 })).toThrow(/32,768/);
    expect(() => planExport(64, 64, { limits: { ...limits, maxTextureDimension2D: 8 }, sampleGrid: 1, endpointBytesPerSample: 0, halo: 6 })).toThrow(/memory|GPU/);
    expect(() => frameForExport({ width: 10, height: 10, unitsPerPixel: new Decimal(0) }, 10, 10)).toThrow(/scale/);
  });

  it('bounds each axis for global f32 coordinates while covering a 32768-pixel scanline', () => {
    expect(() => checkedExportDimensions(1, 80_000_000)).toThrow(/32,768/);
    expect(() => checkedExportDimensions(32769, 1)).toThrow(/32,768/);
    const plan = planExport(32768, 1, { limits, sampleGrid: 3, endpointBytesPerSample: 16, halo: 6 });
    const strips = [...plan.strips()]; expect(strips).toHaveLength(1);
    let next = 0;
    for (const tile of strips[0].tiles) { expect(tile.core.x).toBe(next); next += tile.core.width; }
    expect(next).toBe(32768);
  });
});
