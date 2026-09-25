import { checkedExportDimensions, PNG_IDAT_BYTES } from './layout';

export interface StreamingPngOptions {
  maxEncodedBytes: number;
  signal?: AbortSignal;
  onProgress?: (rowsWritten: number, totalRows: number) => void;
}
export interface StreamingPng {
  /** Append 1–64 complete RGBA rows in top-to-bottom order; await each call. */
  appendRows(rgba: Uint8Array | Uint8ClampedArray): Promise<void>;
  finish(): Promise<Blob>;
  cancel(reason?: unknown): Promise<void>;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < out.length - 4; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8);
  view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
  return out;
}
const abortError = () => new DOMException('PNG export cancelled.', 'AbortError');

/** One native zlib stream, partitioned into consecutive bounded IDAT chunks.
 * Holds compressed chunks only; Blob construction may copy them, so callers
 * must budget twice maxEncodedBytes plus the bounded strip/tile working set. */
export function createStreamingPng(width: number, height: number, options: StreamingPngOptions): StreamingPng {
  checkedExportDimensions(width, height);
  const { maxEncodedBytes, signal } = options;
  if (!Number.isSafeInteger(maxEncodedBytes) || maxEncodedBytes < 57) throw new Error('Invalid PNG output budget.');
  if (signal?.aborted) throw signal.reason ?? abortError();
  if (typeof CompressionStream === 'undefined') throw new Error('This browser cannot encode streaming PNG files.');
  const compressor = new CompressionStream('deflate'), writer = compressor.writable.getWriter(), reader = compressor.readable.getReader();
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  let parts: Uint8Array<ArrayBuffer>[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  let encodedBytes = 33, rowsWritten = 0, writing = false, state: 'open' | 'finishing' | 'done' | 'failed' = 'open';
  let failure: unknown, pending = new Uint8Array(PNG_IDAT_BYTES), pendingLength = 0;
  let cancellation: Promise<void> | undefined;
  const check = () => { if (state === 'failed') throw failure; };
  const removeAbort = () => signal?.removeEventListener('abort', onAbort);
  function cancel(reason: unknown = abortError()): Promise<void> {
    if (state === 'done') return Promise.resolve();
    if (state !== 'failed') { state = 'failed'; failure = reason; parts = []; pendingLength = 0; removeAbort(); }
    cancellation ??= Promise.allSettled([writer.abort(failure), reader.cancel(failure)]).then(() => undefined);
    return cancellation;
  }
  function onAbort() { void cancel(signal?.reason ?? abortError()); }
  signal?.addEventListener('abort', onAbort, { once: true });
  const flush = () => {
    if (!pendingLength) return;
    if (encodedBytes + pendingLength + 12 + 12 > maxEncodedBytes) throw new Error('The PNG exceeds the export output memory budget.');
    const packed = chunk('IDAT', pending.subarray(0, pendingLength));
    parts.push(packed); encodedBytes += packed.length; pendingLength = 0;
  };
  // Drain while writing: waiting until close would deadlock stream backpressure.
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read(); check(); if (done) break;
        if (encodedBytes + pendingLength + value.length + 24 > maxEncodedBytes) throw new Error('The PNG exceeds the export output memory budget.');
        for (let offset = 0; offset < value.length;) {
          const count = Math.min(PNG_IDAT_BYTES - pendingLength, value.length - offset);
          pending.set(value.subarray(offset, offset + count), pendingLength); pendingLength += count; offset += count;
          if (pendingLength === PNG_IDAT_BYTES) flush();
        }
      }
      flush();
    } catch (error) { void cancel(error); }
  })();
  return {
    async appendRows(rgba) {
      check(); if (state !== 'open' || writing) throw new Error('PNG rows must be written sequentially before finishing.');
      const rows = rgba.byteLength / (width * 4);
      if (!Number.isInteger(rows) || rows < 1 || rows > 64 || rowsWritten + rows > height) throw new Error('PNG input must contain 1–64 complete remaining rows.');
      writing = true;
      try {
        const stride = width * 4, filtered = new Uint8Array((stride + 1) * rows);
        for (let y = 0; y < rows; y++) filtered.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
        await writer.write(filtered); check(); rowsWritten += rows; options.onProgress?.(rowsWritten, height);
      } catch (error) { void cancel(error); throw error; }
      finally { writing = false; }
    },
    async finish() {
      check(); if (state !== 'open' || writing) throw new Error('PNG encoding is not ready to finish.');
      if (rowsWritten !== height) { const error = new Error('PNG input is incomplete.'); void cancel(error); throw error; }
      state = 'finishing';
      try {
        await writer.close(); await pump; check();
        if (encodedBytes + 12 > maxEncodedBytes) throw new Error('The PNG exceeds the export output memory budget.');
        parts.push(chunk('IEND', new Uint8Array(0)));
        const blob = new Blob(parts, { type: 'image/png' });
        parts = []; pending = new Uint8Array(0); state = 'done'; removeAbort();
        return blob;
      } catch (error) { void cancel(error); throw error; }
    },
    cancel,
  };
}
