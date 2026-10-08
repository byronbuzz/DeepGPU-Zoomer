import type { Region } from './regions';

export const SURVIVOR_CAPACITY = 256;
const FLUSH_LANES = 128;
const MAX_AGE_MS = 16;

/** One target, one density and disjoint output rectangles. Slots are never
 * recycled within a cohort: the GPU append count stays independently checkable. */
export class SurvivorCohort {
  readonly regions: Region[] = [];
  lanes = 0;
  private started = 0;

  conflicts(region: Region): boolean {
    return this.regions.some(r => r.stride !== region.stride ||
      r.x < region.x + region.width && region.x < r.x + r.width &&
      r.y < region.y + region.height && region.y < r.y + r.height);
  }

  accepts(region: Region, survivors: number, originalLanes: number): boolean {
    return Number.isSafeInteger(survivors) && survivors > 0 && survivors <= 32 &&
      Number.isSafeInteger(originalLanes) && originalLanes > 0 && survivors * 100 <= originalLanes &&
      this.lanes + survivors <= SURVIVOR_CAPACITY && !this.conflicts(region);
  }

  add(region: Region, survivors: number, originalLanes: number, now: number): void {
    if (!this.accepts(region, survivors, originalLanes) || !Number.isFinite(now))
      throw Error('Invalid survivor cohort admission');
    if (!this.lanes) this.started = now;
    this.regions.push(region);
    this.lanes += survivors;
  }

  ready(now: number, pending: boolean): boolean {
    return this.lanes > 0 && (!pending || this.lanes >= FLUSH_LANES || now - this.started >= MAX_AGE_MS);
  }

  clear(): void { this.regions.length = 0; this.lanes = 0; this.started = 0; }
}
