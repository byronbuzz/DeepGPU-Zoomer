import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePackedReference, referenceIdentity, REFERENCE_CHUNK_ITERATIONS,
  type ReferenceOrbitInput, type ReferenceResumeState, type PackedReferenceOrbit } from '../src/render/reference-orbit';
import { ReferenceWorkerClient } from '../src/render/reference-worker-client';

const input = (changes: Partial<ReferenceOrbitInput> = {}): ReferenceOrbitInput => ({
  family: 'mandelbrot', centerX: '-0.1', centerY: '0.2', juliaX: '-0.8', juliaY: '0.156',
  limbs: 8, maxIterations: 257, ...changes,
});

function append(parts: PackedReferenceOrbit[]): Uint8Array {
  const bytesPerSample = parts[0].sampleWords * 4;
  const result = new Uint8Array(parts.at(-1)!.length * bytesPerSample);
  let end = 0;
  for (const part of parts) {
    expect(part.startIndex).toBe(end);
    expect(part.sampleWords).toBe(parts[0].sampleWords);
    expect(part.buffer.byteLength).toBe((part.length - part.startIndex) * bytesPerSample);
    result.set(new Uint8Array(part.buffer), part.startIndex * bytesPerSample);
    end = part.length;
  }
  return result;
}

function sameBytes(left: ArrayBuffer, right: Uint8Array): boolean {
  const bytes = new Uint8Array(left);
  if (bytes.length !== right.length) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== right[i]) return false;
  return true;
}

describe('exact reference suffixes', () => {
  it.each([
    input(),
    input({ family: 'julia', centerX: '0.123456789', centerY: '-0.2', juliaX: '-0.1', juliaY: '0.2' }),
    input({ centerX: '0.5', centerY: '0.2' }),
  ])('concatenates to identical one-shot bytes and exact terminal state: $family $centerX', request => {
    const full = generatePackedReference(request), parts: PackedReferenceOrbit[] = [];
    let resume: ReferenceResumeState | undefined;
    do {
      const next = generatePackedReference(request, undefined, resume, 7);
      expect(next.iterationsComputed).toBeLessThanOrEqual(7);
      expect(next.length).toBe(next.terminal.iteration + 1);
      parts.push(next); resume = next.terminal;
    } while (!parts.at(-1)!.complete);
    expect(append(parts)).toEqual(new Uint8Array(full.buffer));
    expect(parts.at(-1)!.terminal).toEqual(full.terminal);
  });

  it('extends a previous cap without repeating its boundary sample', () => {
    const short = generatePackedReference(input({ maxIterations: 13 }));
    const next = generatePackedReference(input({ maxIterations: 27 }), undefined, short.terminal);
    expect(next).toMatchObject({ startIndex: 14, length: 28, iterationsComputed: 14, complete: true });
    expect(append([short, next])).toEqual(new Uint8Array(generatePackedReference(input({ maxIterations: 27 })).buffer));
    expect(referenceIdentity(input({ maxIterations: 13 }))).toBe(referenceIdentity(input({ maxIterations: 27 })));
  });

  it('returns an empty suffix for an escaped or already-complete checkpoint', () => {
    const escaped = generatePackedReference(input({ centerX: '1', centerY: '0' }));
    const suffix = generatePackedReference(input({ centerX: '1', centerY: '0', maxIterations: 10_000_000 }), undefined, escaped.terminal, 7);
    expect(suffix).toMatchObject({ startIndex: escaped.length, length: escaped.length, escaped: true,
      escapeIndex: escaped.escapeIndex, iterationsComputed: 0, complete: true, terminal: escaped.terminal });
    expect(suffix.buffer.byteLength).toBe(0);
    const bounded = generatePackedReference(input());
    expect(generatePackedReference(input(), undefined, bounded.terminal).buffer.byteLength).toBe(0);
  });

  it('rejects changed coordinates, family, precision, and malformed checkpoint metadata', () => {
    const state = generatePackedReference(input({ maxIterations: 5 })).terminal;
    for (const change of [{ centerX: '-0.10' }, { centerY: '0.21' }, { juliaX: '-0.7' },
      { juliaY: '0.157' }, { family: 'julia' as const }, { limbs: 16 }]) {
      expect(() => generatePackedReference(input(change), undefined, state)).toThrow(/continuation/);
    }
    for (const change of [{ iteration: -1 }, { iteration: 1.5 }, { iteration: 258 },
      { x: 1n << 255n }, { escaped: true }, { escapeIndex: 4 }, { y: '0' as unknown as bigint }]) {
      expect(() => generatePackedReference(input(), undefined, { ...state, ...change })).toThrow(/continuation/);
    }
    expect(() => generatePackedReference(input({ maxIterations: 4 }), undefined, state)).toThrow(/continuation/);
  });

  it('extends beyond one million with a small suffix, retaining the full exact state', () => {
    const request = input({ centerX: '0.250000000006', centerY: '0', maxIterations: 1_000_008 });
    const prefix = generatePackedReference({ ...request, maxIterations: 1_000_000 });
    const suffix = generatePackedReference(request, undefined, prefix.terminal, 8);
    const full = generatePackedReference(request);
    expect(suffix).toMatchObject({ startIndex: 1_000_001, length: 1_000_009, iterationsComputed: 8, escaped: false, complete: true });
    expect(suffix.buffer.byteLength).toBe(8 * 40);
    expect(suffix.terminal).toEqual(full.terminal);
    expect(sameBytes(suffix.buffer, new Uint8Array(full.buffer, prefix.length * 40))).toBe(true);
    expect(sameBytes(prefix.buffer, new Uint8Array(full.buffer, 0, prefix.buffer.byteLength))).toBe(true);
  }, 30_000);

  it('keeps the audited deep center unescaped through four million in bounded chunks', () => {
    const request = input({ limbs: 16, maxIterations: 4_000_000,
      centerX: '-0.7401408595537835797448924117325742086696962554056268878774185668230676815415566060941405477446061390426769353287404782809440464621396706711888191312861607531543255952427948843',
      centerY: '0.157214149744021202345549555647215326519243518253367685572932689869919805285017292498860336033494516112861283760747394891646729383691953951015691536504893941290164669945419121' });
    let part: PackedReferenceOrbit | undefined;
    do {
      const start = part?.length ?? 0;
      part = generatePackedReference(request, undefined, part?.terminal, REFERENCE_CHUNK_ITERATIONS);
      expect(part.startIndex).toBe(start);
      expect(part.buffer.byteLength).toBeLessThanOrEqual((REFERENCE_CHUNK_ITERATIONS + 1) * 40);
    } while (!part.complete);
    // Independent Decimal200/260 and BigInt768/1024 audit oracles agree on this cap classification.
    expect(part).toMatchObject({ length: 4_000_001, escaped: false, escapeIndex: 0 });
  }, 30_000);
});

afterEach(() => vi.unstubAllGlobals());

describe('reference worker ownership and bounded transport', () => {
  it('bounds a ten-million request and transfers only its suffix buffer', async () => {
    const postMessage = vi.fn();
    const worker = { postMessage, onmessage: null as null | ((event: { data: unknown }) => void) };
    vi.stubGlobal('self', worker);
    await import('../src/render/reference-worker');
    worker.onmessage!({ data: { id: 7, input: input({ centerX: '0', centerY: '0', maxIterations: 10_000_000 }) } });
    const [message, transfers] = postMessage.mock.calls.at(-1)!;
    expect(message).toMatchObject({ id: 7, ok: true, startIndex: 0, length: REFERENCE_CHUNK_ITERATIONS + 1,
      iterationsComputed: REFERENCE_CHUNK_ITERATIONS, complete: false });
    expect(message).toMatchObject({ formatVersion: 2, sampleWords: 10 });
    expect(message.buffer.byteLength).toBe((REFERENCE_CHUNK_ITERATIONS + 1) * 40);
    expect(transfers).toEqual([message.buffer]);
    worker.onmessage!({ data: { id: 8, input: input({ centerX: '0', centerY: '0', maxIterations: 10_000_000 }),
      resume: message.terminal, iterationBudget: 3 } });
    expect(postMessage.mock.calls.at(-1)![0]).toMatchObject({ startIndex: REFERENCE_CHUNK_ITERATIONS + 1,
      length: REFERENCE_CHUNK_ITERATIONS + 4, iterationsComputed: 3 });
  });

  it('ignores canceled worker replies and keeps checkpoint ownership with each job', async () => {
    class WorkerMock {
      static instances: WorkerMock[] = [];
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror = null; onmessageerror = null;
      postMessage = vi.fn(); terminate = vi.fn();
      constructor() { WorkerMock.instances.push(this); }
    }
    vi.stubGlobal('Worker', WorkerMock);
    const client = new ReferenceWorkerClient();
    const oldJob = client.generate(input());
    const rejection = expect(oldJob).rejects.toMatchObject({ name: 'AbortError' });
    client.cancel(); await rejection;
    const state = generatePackedReference(input({ maxIterations: 5 })).terminal;
    const job = client.generate(input(), false, state, 7);
    const old = WorkerMock.instances[0], current = WorkerMock.instances[1];
    expect(old.terminate).toHaveBeenCalledOnce();
    const sent = current.postMessage.mock.calls[0][0];
    expect(sent).toMatchObject({ resume: state, iterationBudget: 7 });
    old.onmessage!({ data: { id: 1, ok: true, ...generatePackedReference(input()) } });
    expect(client.active).toBe(true);
    const reply = generatePackedReference(input(), undefined, state, 7);
    current.onmessage!({ data: { id: sent.id, ok: true, ...reply } });
    expect(await job).toMatchObject(reply);
    expect(client.active).toBe(false);
  });
});
