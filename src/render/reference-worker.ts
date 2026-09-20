/// <reference lib="webworker" />
import { generatePackedReference, type ReferenceOrbitInput } from "./reference-orbit";

type GenerateMessage = { id: number; input: ReferenceOrbitInput; diagnosticStages?: boolean };
type WorkerResponse =
  | { id: number; stage: "generation" | "packing" }
  | { id: number; ok: true; buffer: ArrayBuffer; length: number; escaped: boolean; escapeIndex: number }
  | { id: number; ok: false; name: string; message: string };

const worker = self as DedicatedWorkerGlobalScope;
worker.onmessage = (event: MessageEvent<GenerateMessage>) => {
  const { id, input, diagnosticStages } = event.data;
  try {
    const result = generatePackedReference(input, diagnosticStages ? stage => worker.postMessage({ id, stage } satisfies WorkerResponse) : undefined);
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
