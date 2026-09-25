import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { createStreamingPng } from '../../src/export/png';
import { canReuseExportPixels, encodeCapturedExport } from '../../src/export/render';
import { checkedExportDimensions } from '../../src/export/layout';

// Independent bit-at-a-time CRC implementation, deliberately no writer helpers.
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
async function decode(blob: Blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    expect(end).toBeLessThanOrEqual(bytes.length);
    const type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, end - 4);
    expect(bytes.readUInt32BE(end - 4)).toBe(crc(bytes.subarray(offset + 4, end - 4)));
    chunks.push({ type, data }); offset = end;
  }
  expect(chunks[0].type).toBe('IHDR'); expect(chunks.at(-1)?.type).toBe('IEND');
  expect(chunks.slice(1, -1).every(c => c.type === 'IDAT')).toBe(true);
  const header = chunks[0].data, width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  expect([...header.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
  const idat = chunks.slice(1, -1), stream = Buffer.concat(idat.map(c => c.data));
  const decoded = inflateSync(stream, { info: true });
  expect(decoded.engine.bytesWritten).toBe(stream.length); // No second zlib stream/trailing data.
  const raw = decoded.buffer, pixels = Buffer.alloc(width * height * 4);
  expect(raw.length).toBe((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, pixels, idat };
}

describe('streaming PNG writer', () => {
  it('keeps captured output dimensions and bytes without hidden supersampling',async()=>{
    const pixels=new Uint8ClampedArray(3*65*4).fill(127);
    const decoded=await decode(await encodeCapturedExport({width:3,height:65,pixels}));
    expect([decoded.width,decoded.height]).toEqual([3,65]);expect([...decoded.pixels]).toEqual([...pixels]);
    expect(canReuseExportPixels({width:7680,height:4320})).toBe(false);
    await expect(encodeCapturedExport({width:3,height:65,pixels:new Uint8Array(4)})).rejects.toThrow();
  });
  it('encodes multiple irregular strips into one independent-decodable zlib stream with checked CRCs', async () => {
    const width = 257, height = 129, pixels = new Uint8Array(width * height * 4);
    let seed = 0x6d2b79f5;
    for (let i = 0; i < pixels.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[i] = seed & 255; }
    const progress: number[] = [], writer = createStreamingPng(width, height, { maxEncodedBytes: checkedExportDimensions(width, height).maxEncodedBytes, onProgress: rows => progress.push(rows) });
    let y = 0;
    for (const rows of [1, 32, 64, 32]) { await writer.appendRows(pixels.subarray(y * width * 4, (y + rows) * width * 4)); y += rows; }
    const blob = await writer.finish(), decoded = await decode(blob);
    expect(blob.type).toBe('image/png'); expect(decoded.width).toBe(width); expect(decoded.height).toBe(height);
    expect(Buffer.from(pixels).equals(decoded.pixels)).toBe(true);
    expect(decoded.idat.length).toBeGreaterThan(1); expect(decoded.idat.every(c => c.data.length <= 65536)).toBe(true);
    expect(progress).toEqual([1, 33, 97, 129]);
  });

  it('encodes the final single pixel without changing alpha', async () => {
    const writer = createStreamingPng(1, 1, { maxEncodedBytes: 1024 });
    await writer.appendRows(new Uint8ClampedArray([12, 34, 56, 78]));
    expect([...(await decode(await writer.finish())).pixels]).toEqual([12, 34, 56, 78]);
  });

  it('rejects incomplete, partial and extra rows without producing a PNG', async () => {
    const writer = createStreamingPng(2, 2, { maxEncodedBytes: 1024 });
    await expect(writer.appendRows(new Uint8Array(7))).rejects.toThrow(/complete/);
    await writer.appendRows(new Uint8Array(8));
    await expect(writer.finish()).rejects.toThrow(/incomplete/);
    const extra = createStreamingPng(1, 1, { maxEncodedBytes: 1024 });
    await expect(extra.appendRows(new Uint8Array(8))).rejects.toThrow(/remaining/); await extra.cancel();
  });

  it('enforces the compressed output cap during native encoding', async () => {
    const writer = createStreamingPng(32, 32, { maxEncodedBytes: 57 });
    await expect((async () => { await writer.appendRows(new Uint8Array(32 * 32 * 4)); return writer.finish(); })()).rejects.toThrow(/budget/);
    await writer.cancel();
  });

  it('rejects cancellation before construction and during an outstanding write', async () => {
    const before = new AbortController(); before.abort();
    expect(() => createStreamingPng(1, 1, { maxEncodedBytes: 1024, signal: before.signal })).toThrow();
    const controller = new AbortController(), writer = createStreamingPng(1024, 64, { maxEncodedBytes: 1024 * 1024, signal: controller.signal });
    const pending = writer.appendRows(new Uint8Array(1024 * 64 * 4)); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(writer.finish()).rejects.toMatchObject({ name: 'AbortError' });
    await writer.cancel();
  });
});
