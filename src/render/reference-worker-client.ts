import { REFERENCE_CHUNK_ITERATIONS,
  type PackedReferenceOrbit, type ReferenceOrbitInput, type ReferenceResumeState } from "./reference-orbit";

type WorkerResponse =
  | ({ id: number; ok: true } & PackedReferenceOrbit)
  | { id: number; ok: false; name: string; message: string };

interface ActiveJob {
  id: number;
  resolve: (result: PackedReferenceOrbit) => void;
  reject: (error: unknown) => void;
}
const aborted = (message: string) => new DOMException(message, "AbortError");

export class ReferenceWorkerClient {
  private worker: Worker | null = null;
  private activeJob: ActiveJob | null = null;
  private nextId = 1;

  get active() { return this.activeJob !== null; }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./reference-worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker || !this.activeJob || event.data.id !== this.activeJob.id) return;
      const job = this.activeJob; this.activeJob = null;
      if (event.data.ok) job.resolve(event.data);
      else {
        this.worker = null; worker.terminate();
        const error = new Error(event.data.message); error.name = event.data.name; job.reject(error);
      }
    };
    worker.onerror = event => {
      if (this.worker !== worker) return;
      event.preventDefault();
      const job = this.activeJob; this.activeJob = null; this.worker = null; worker.terminate();
      job?.reject(new Error(event.message || "Reference worker failed"));
    };
    worker.onmessageerror = () => {
      if (this.worker !== worker) return;
      const job = this.activeJob; this.activeJob = null; this.worker = null; worker.terminate();
      job?.reject(new Error("Reference worker returned an incompatible message"));
    };
    return worker;
  }

  /** Returns one bounded suffix; the owner admits it before requesting the next. */
  generate(input: ReferenceOrbitInput, resume?: ReferenceResumeState,
    iterationBudget = REFERENCE_CHUNK_ITERATIONS): Promise<PackedReferenceOrbit> {
    if (this.activeJob) throw new Error("Reference worker already has an active job");
    const id = this.nextId++, worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.activeJob = { id, resolve, reject };
      try { worker.postMessage({ id, input, resume, iterationBudget }); }
      catch (error) {
        this.activeJob = null; this.worker = null; worker.terminate(); reject(error);
      }
    });
  }

  cancel(message = "Reference generation superseded") {
    const job = this.activeJob, worker = this.worker;
    this.activeJob = null; this.worker = null;
    worker?.terminate();
    job?.reject(aborted(message));
  }
}
