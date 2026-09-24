import { afterEach, expect, it, vi } from 'vitest';
import { GpuTiming } from '../../src/gpu/timing';

function device(supported = true) {
  let allocated = 0;
  const buffers: Array<{ bytes: ArrayBuffer; succeed?: () => void; fail?: (e: Error) => void }> = [];
  vi.stubGlobal('GPUBufferUsage', { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
  return { buffers, get allocated() { return allocated; }, gpu: {
    features: new Set(supported ? ['timestamp-query'] : []),
    createQuerySet() { allocated++; return {}; },
    createBuffer() {
      const buffer = {
        bytes: new ArrayBuffer(16), succeed: undefined as (() => void) | undefined,
        fail: undefined as ((e: Error) => void) | undefined,
        mapAsync() { return new Promise<void>((resolve, reject) => { buffer.succeed = resolve; buffer.fail = reject; }); },
        getMappedRange() { return buffer.bytes; }, unmap() {},
      };
      buffers.push(buffer); return buffer;
    },
  } as unknown as GPUDevice };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => vi.unstubAllGlobals());

it('does not allocate or profile without the optional capability', () => {
  const f = device(false), timing = new GpuTiming(f.gpu);
  timing.setEnabled(true);
  expect(timing.begin('calculate')).toBeUndefined();
  expect(timing.snapshot().enabled).toBe(false);
  expect(f.allocated).toBe(0);
});

it('collects calculate timings for scheduling while the profiling display is off', async () => {
  const f = device(), timing = new GpuTiming(f.gpu);
  expect(timing.begin('shade')).toBeUndefined();
  const sample = timing.begin('calculate');
  expect(sample).toBeDefined();
  let measured = -1;
  timing.collect(sample, ms => { measured = ms; });
  const buffer = f.buffers.find(b => b.succeed)!;
  new BigUint64Array(buffer.bytes).set([100n, 1_000_100n]); buffer.succeed!();
  await flush();
  expect(measured).toBe(1);
  expect(timing.snapshot().phases).toEqual({});
});

it('keeps pending buffers reserved across reset and discards their old results', async () => {
  const f = device(), timing = new GpuTiming(f.gpu);
  timing.setEnabled(true);
  for (let i = 0; i < 100; i++) {
    const sample = timing.begin('calculate');
    if (!sample) break;
    timing.collect(sample);
  }
  expect(f.allocated).toBeGreaterThan(0);
  expect(f.allocated).toBeLessThan(100);
  const count = f.allocated;
  timing.setEnabled(false); timing.setEnabled(true);
  expect(timing.begin('shade')).toBeUndefined();
  expect(f.allocated).toBe(count);
  for (const buffer of f.buffers.filter(b => b.succeed)) {
    new BigUint64Array(buffer.bytes).set([100n, 1100n]); buffer.succeed!();
  }
  await flush();
  expect(timing.snapshot().phases).toEqual({});
  expect(timing.begin('shade')).toBeDefined();
  expect(f.allocated).toBe(count);
});

it('recovers rejected or reversed readbacks and accepts quantized zero duration', async () => {
  const f = device(), timing = new GpuTiming(f.gpu);
  timing.setEnabled(true);
  timing.collect(timing.begin('calculate'));
  const buffer = f.buffers.find(b => b.fail)!;
  buffer.fail!(new Error('device lost')); await flush();
  timing.collect(timing.begin('calculate'));
  new BigUint64Array(buffer.bytes).set([2000n, 1000n]); buffer.succeed!(); await flush();
  expect(timing.snapshot().invalid).toBe(2);
  expect(timing.snapshot().phases).toEqual({});
  timing.collect(timing.begin('shade'));
  new BigUint64Array(buffer.bytes).set([2000n, 2000n]); buffer.succeed!(); await flush();
  expect(timing.snapshot().phases.shade.meanMs).toBe(0);
  expect(f.allocated).toBe(1);
});
