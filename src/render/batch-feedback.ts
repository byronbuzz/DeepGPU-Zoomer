/** Feedback counts logical anchor visits, including visits skipped by reuse. */
export interface BatchSubmission {
  readonly epoch: number;
  readonly serial: number;
  readonly visits: number;
  readonly stride: number;
  readonly targetMs: number;
}

/** Local admission feedback; GPU work and presentation remain independently queued. */
export class BatchFeedback {
  private epoch = 0;
  private serial = 0;
  private accepted = 0;
  private cost = 0;
  private lastBudget = 0;
  private growthLimit = Infinity;
  private measuredStride = 1;
  private wallSample: {visits:number; stride:number; ms:number} | undefined;
  private wallOverhead = 0;

  /** Retire callbacks on every target; only incompatible/fresh work loses its estimate. */
  enterTarget(reseed = false): void {
    this.epoch++; this.serial = 0; this.accepted = 0;
    if (reseed) {
      this.cost = 0; this.lastBudget = 0; this.growthLimit = Infinity;
      this.measuredStride = 1; this.wallSample = undefined; this.wallOverhead = 0;
    }
  }

  submit(visits: number, stride: number, targetMs: number): BatchSubmission {
    const valid = Number.isFinite(visits) && visits > 0 && Number.isFinite(stride) && stride >= 1 &&
      Number.isFinite(targetMs) && targetMs > 0;
    return {epoch:this.epoch, serial:valid ? ++this.serial : 0, visits, stride, targetMs};
  }

  observe(sample: BatchSubmission, ms: number, kind: 'gpu' | 'fallback'): boolean {
    if (sample.epoch !== this.epoch || sample.serial > this.serial || sample.serial <= this.accepted ||
      !Number.isFinite(ms) || ms < 0 || !Number.isFinite(sample.visits) || sample.visits <= 0 ||
      !Number.isFinite(sample.stride) || sample.stride < 1 ||
      !Number.isFinite(sample.targetMs) || sample.targetMs <= 0) return false;
    const priorBudget = this.lastBudget || sample.visits;
    // A tiny edge/reuse pass does not invalidate an already admitted allowance,
    // but cannot justify growing beyond twice the work that was actually sent.
    const growthLimit = Math.max(priorBudget, sample.visits * 2);
    let cost: number;
    let overhead = this.wallOverhead;
    if (kind === 'fallback') {
      // Fit T = fixed + visits * cost only when comparable actual work changes.
      // A fixed queue/fence delay then cannot cause endless proportional shrink.
      // This remains a noisy wall estimate, so every adjustment is bounded.
      const previous = this.wallSample;
      if (!previous || previous.stride !== sample.stride) overhead = 0;
      else if (previous.visits !== sample.visits) {
        const intercept = (previous.ms * sample.visits - ms * previous.visits) /
          (sample.visits - previous.visits);
        if (Number.isFinite(intercept)) overhead = Math.max(0, Math.min(ms, previous.ms, intercept));
      }
      overhead = Math.min(overhead, ms);
      const workMs = ms - overhead;
      const allowance = Math.max(Math.min(priorBudget, sample.visits) / 2, Math.min(growthLimit,
        workMs > 0 ? sample.visits * sample.targetMs / workMs : growthLimit));
      cost = sample.targetMs / allowance;
    } else if (ms === 0) {
      // Quantized zero establishes a cheap pass, not zero per-visit cost.
      cost = Math.min(this.cost || Infinity, sample.targetMs / growthLimit);
    } else {
      const observed = ms / sample.visits;
      cost = this.cost ? this.cost * .75 + observed * .25 : observed;
    }
    if (!Number.isFinite(cost) || cost <= 0) return false;
    this.accepted = sample.serial; this.cost = cost;
    this.growthLimit = growthLimit; this.measuredStride = sample.stride;
    this.wallSample = kind === 'fallback' ? {visits:sample.visits, stride:sample.stride, ms} : undefined;
    this.wallOverhead = kind === 'fallback' ? overhead : 0;
    return true;
  }

  /** Default to dense admission: sparse measurements alone cannot enlarge it. */
  budget(initialVisits: number, targetMs: number, totalVisits: number, stride = 1): number {
    const initial = Number.isFinite(initialVisits) && initialVisits > 0 ? initialVisits : 1;
    const total = Number.isFinite(totalVisits) && totalVisits > 0 ? totalVisits : 1;
    let allowance = this.cost > 0 && Number.isFinite(targetMs) && targetMs > 0
      ? Math.min(targetMs / this.cost, this.growthLimit) : initial;
    if (stride !== this.measuredStride) allowance = Math.min(initial, allowance);
    this.lastBudget = Math.max(1, Math.min(total, allowance));
    return this.lastBudget;
  }
}
