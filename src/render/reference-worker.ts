/// <reference lib="webworker" />
import { generatePackedReference, REFERENCE_CHUNK_ITERATIONS,
  type ReferenceOrbitInput, type ReferenceResumeState, type PackedReferenceOrbit } from "./reference-orbit";

type GenerateMessage = { id: number; input: ReferenceOrbitInput;
  resume?: ReferenceResumeState; iterationBudget?: number };
type WorkerResponse =
  | ({ id: number; ok: true } & PackedReferenceOrbit)
  | { id: number; ok: false; name: string; message: string };

const worker = self as DedicatedWorkerGlobalScope;
worker.onmessage = (event: MessageEvent<GenerateMessage>) => {
  const { id, input, resume, iterationBudget = REFERENCE_CHUNK_ITERATIONS } = event.data;
  try {
    if (!Number.isInteger(iterationBudget) || iterationBudget < 1) throw new Error("Unsupported reference chunk budget");
    const result = generatePackedReference(input, resume, Math.min(iterationBudget, REFERENCE_CHUNK_ITERATIONS));
    const response: WorkerResponse = { id, ok: true, ...result };
    worker.postMessage(response, [result.buffer]);
  } catch (error) {
    const response: WorkerResponse = {
      id, ok: false,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
    worker.postMessage(response);
  }
};

export {};
