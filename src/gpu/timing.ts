/** Optional pass timings. Readbacks never gate rendering and the pool is bounded. */
type Slot = { query: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean };
export type TimingSample = { slot: Slot; phase: string; generation: number };
export class GpuTiming {
  private slots: Slot[] = [];
  private generation = 0;
  private values = new Map<string, number[]>();
  private invalid = 0;
  private missed = 0;
  enabled = false;
  readonly supported: boolean;
  constructor(private device: GPUDevice) {
    this.supported = device.features.has("timestamp-query");
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled && this.supported; this.generation++;
    this.values.clear(); this.invalid = 0; this.missed = 0;
  }
  begin(phase: string): TimingSample | undefined {
    if (!this.enabled) return;
    let slot = this.slots.find(s => !s.busy);
    if (!slot && this.slots.length < 6) {
      slot = {
        query: this.device.createQuerySet({ type: "timestamp", count: 2 }),
        resolve: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false,
      };
      this.slots.push(slot);
    }
    if (!slot) { this.missed++; return; }
    slot.busy = true;
    return { slot, phase, generation: this.generation };
  }
  writes(sample: TimingSample | undefined): GPUComputePassTimestampWrites | undefined {
    return sample && { querySet: sample.slot.query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }
  resolve(encoder: GPUCommandEncoder, sample: TimingSample | undefined) {
    if (!sample) return;
    encoder.resolveQuerySet(sample.slot.query, 0, 2, sample.slot.resolve, 0);
    encoder.copyBufferToBuffer(sample.slot.resolve, 0, sample.slot.read, 0, 16);
  }
  collect(sample: TimingSample | undefined) {
    if (!sample) return;
    const { slot } = sample;
    void slot.read.mapAsync(GPUMapMode.READ).then(() => {
      const data = new BigUint64Array(slot.read.getMappedRange());
      const elapsed = Number(data[1] - data[0]) / 1e6;
      if (this.enabled && sample.generation === this.generation) {
        if (data[1] < data[0] || !Number.isFinite(elapsed) || elapsed < 0) this.invalid++;
        else {
          const values = this.values.get(sample.phase) ?? [];
          values.push(elapsed); if (values.length > 120) values.shift();
          this.values.set(sample.phase, values);
        }
      }
      slot.read.unmap();
    }).catch(() => {
      if (this.enabled && sample.generation === this.generation) this.invalid++;
    }).finally(() => { slot.busy = false; });
  }
  snapshot() {
    return { enabled: this.enabled, supported: this.supported, invalid: this.invalid, missed: this.missed,
      phases: Object.fromEntries([...this.values].map(([name, values]) => {
        const sorted = [...values].sort((a,b) => a-b);
        return [name, { count: values.length, meanMs: values.reduce((a,b) => a+b,0)/values.length,
          p95Ms: sorted[Math.floor((sorted.length-1)*.95)], maxMs: sorted.at(-1)! }];
      })) };
  }
}
