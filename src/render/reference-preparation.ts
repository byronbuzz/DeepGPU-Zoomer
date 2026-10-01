import { referenceIdentity, referenceSampleWords, REFERENCE_FORMAT_VERSION,
  type PackedReferenceOrbit, type ReferenceOrbitInput, type ReferenceResumeState, type ReferenceSampleWords } from './reference-orbit';

/** Keeps any one main-thread copy or upload at 4 MiB. */
export const REFERENCE_TRANSFER_FLOATS = 1_048_576;

export interface ReferencePreparationTimings {
  generationWallMs: number;
  concatAllocationMs: number;
  concatWallMs: number;
  concatCpuMs: number;
  concatMaxSliceMs: number;
  concatSlices: number;
}

export interface PreparedReference {
  samples: Float32Array<ArrayBuffer>;
  formatVersion: typeof REFERENCE_FORMAT_VERSION;
  sampleWords: ReferenceSampleWords;
  terminal: ReferenceResumeState;
  length: number;
  escaped: boolean;
  iterationsComputed: number;
  timings: ReferencePreparationTimings;
}

/** Assemble bounded worker suffixes without re-running or rounding the prefix.
 * Nothing is committed until the caller accepts the completed reference. */
export async function prepareReference(
  input: ReferenceOrbitInput,
  generate: (input: ReferenceOrbitInput, resume?: ReferenceResumeState) => Promise<PackedReferenceOrbit>,
  checkCurrent: () => void,
  previous?: Pick<PreparedReference, 'samples' | 'terminal' | 'formatVersion' | 'sampleWords'>,
  yieldForCopy?: () => Promise<void>,
): Promise<PreparedReference> {
  const started = performance.now();
  const identity = referenceIdentity(input);
  const sampleWords = referenceSampleWords(input.family);
  const reusable = previous?.terminal.identity === identity &&
    previous.formatVersion === REFERENCE_FORMAT_VERSION && previous.sampleWords === sampleWords &&
    previous.terminal.iteration <= input.maxIterations &&
    previous.samples.length === (previous.terminal.iteration + 1) * sampleWords;
  let terminal = reusable ? previous!.terminal : undefined;
  let length = terminal ? terminal.iteration + 1 : 0;
  let iterationsComputed = 0;
  const chunks: Float32Array<ArrayBuffer>[] = reusable ? [previous!.samples] : [];
  while (!terminal || !terminal.escaped && terminal.iteration < input.maxIterations) {
    checkCurrent();
    const result = await generate(input, terminal);
    checkCurrent();
    const chunk = new Float32Array(result.buffer);
    if (result.formatVersion !== REFERENCE_FORMAT_VERSION || result.sampleWords !== sampleWords ||
        result.startIndex !== length || result.length <= length ||
        result.length > input.maxIterations + 1 || chunk.length !== (result.length - length) * sampleWords ||
        result.terminal.identity !== identity || result.terminal.iteration !== result.length - 1 ||
        result.escaped !== result.terminal.escaped ||
        result.iterationsComputed !== result.terminal.iteration - (terminal?.iteration ?? 0) ||
        result.complete !== (result.escaped || result.terminal.iteration === input.maxIterations)) {
      throw new Error('Reference worker returned an incompatible suffix');
    }
    chunks.push(chunk);
    length = result.length; terminal = result.terminal;
    iterationsComputed += result.iterationsComputed;
  }
  checkCurrent();
  const generationEnded = performance.now();
  const samples = chunks.length === 1 ? chunks[0] : new Float32Array(length * sampleWords);
  const allocated = performance.now();
  const timings: ReferencePreparationTimings = {
    generationWallMs: generationEnded - started, concatAllocationMs: allocated - generationEnded,
    concatWallMs: 0, concatCpuMs: 0, concatMaxSliceMs: 0, concatSlices: 0,
  };
  if (chunks.length !== 1) {
    let offset = 0;
    for (const chunk of chunks) {
      // A reusable prefix can itself contain millions of samples. Bound the
      // copy inside every chunk, rather than assuming worker-sized inputs.
      for (let start = 0; start < chunk.length; start += REFERENCE_TRANSFER_FLOATS) {
        checkCurrent();
        const end = Math.min(chunk.length, start + REFERENCE_TRANSFER_FLOATS);
        const copyStarted = performance.now();
        samples.set(chunk.subarray(start, end), offset + start);
        const elapsed = performance.now() - copyStarted;
        timings.concatCpuMs += elapsed;
        timings.concatMaxSliceMs = Math.max(timings.concatMaxSliceMs, elapsed);
        timings.concatSlices++;
        if (offset + end < samples.length) await yieldForCopy?.();
      }
      offset += chunk.length;
    }
  }
  checkCurrent();
  timings.concatWallMs = performance.now() - generationEnded;
  return { samples, formatVersion: REFERENCE_FORMAT_VERSION, sampleWords,
    terminal: terminal!, length, escaped: terminal!.escaped, iterationsComputed, timings };
}

/** Two-dimensional dispatch keeps long references within per-axis GPU limits. */
export function referenceDecodeDispatch(samples: number, maxWorkgroups: number): [number, number] {
  if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isSafeInteger(maxWorkgroups) || maxWorkgroups < 1) {
    throw new Error('Invalid reference decode dimensions');
  }
  const groups = Math.ceil(samples / 64), x = Math.min(groups, maxWorkgroups), y = Math.ceil(groups / x);
  if (y > maxWorkgroups || x * y * 64 > 0xffffffff) throw new Error('Reference decode exceeds GPU dispatch capacity');
  return [x, y];
}
