/** Calculation timings feed batch sizing without gating rendering. */
type Slot = { query: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean };
export type TimingSample = { slot: Slot };
export class GpuTiming {
  private slots: Slot[] = [];
  private disposed = false;
  readonly supported: boolean;
  constructor(private device: GPUDevice) {
    this.supported = device.features.has("timestamp-query");
  }
  begin(): TimingSample | undefined {
    if(this.disposed || !this.supported)return;
    let slot = this.slots.find(s => !s.busy);
    if (!slot && this.slots.length < 6) {
      slot = {
        query: this.device.createQuerySet({ type: "timestamp", count: 2 }),
        resolve: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false,
      };
      this.slots.push(slot);
    }
    if (!slot) return;
    slot.busy = true;
    return { slot };
  }
  writes(sample: TimingSample | undefined): GPUComputePassTimestampWrites | GPURenderPassTimestampWrites | undefined {
    return sample && { querySet: sample.slot.query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }
  resolve(encoder: GPUCommandEncoder, sample: TimingSample | undefined) {
    if (!sample) return;
    encoder.resolveQuerySet(sample.slot.query, 0, 2, sample.slot.resolve, 0);
    encoder.copyBufferToBuffer(sample.slot.resolve, 0, sample.slot.read, 0, 16);
  }
  collect(sample: TimingSample | undefined, onElapsed?: (ms:number)=>void, onUnavailable?:()=>void) {
    if (!sample) return;
    const { slot } = sample;
    void slot.read.mapAsync(GPUMapMode.READ).then(() => {
      const data = new BigUint64Array(slot.read.getMappedRange());
      const elapsed = Number(data[1] - data[0]) / 1e6;
      if (data[1] < data[0] || !Number.isFinite(elapsed) || elapsed < 0) {
        onUnavailable?.();
      } else {
        onElapsed?.(elapsed);
      }
      slot.read.unmap();
    }).catch(() => {
      onUnavailable?.();
    }).finally(() => { slot.busy = false; });
  }
  dispose() {
    if(this.disposed)return;
    this.disposed=true;
    for(const slot of this.slots){slot.query.destroy();slot.resolve.destroy();slot.read.destroy();}
    this.slots=[];
  }
}
