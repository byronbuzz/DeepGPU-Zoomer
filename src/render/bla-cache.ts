import Decimal from 'decimal.js';
import {ENTRY_FLOATS, type BlaTable} from './bla';

interface CachedTable {
  samples: Float32Array;
  length: number;
  sampleWords: number;
  epsilonLog2: number;
  maxDelta: Decimal;
  table: BlaTable;
  bytes: number;
}

/** Completed CPU tables only. Admission transfers read-only ownership of the
 * packed array; callers must not write it after remember. No GPU state is kept. */
export class BlaTableCache {
  private tables: CachedTable[] = [];
  private bytes = 0;

  constructor(private readonly maxTables = 2, private readonly maxBytes = 128 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxTables) || maxTables < 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Error('Invalid BLA cache limits');
  }

  private validInput(samples: Float32Array, length: number, sampleWords: number,
    epsilonLog2: number, maxDelta: Decimal): boolean {
    return samples instanceof Float32Array && samples.buffer instanceof ArrayBuffer &&
      samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength &&
      Number.isSafeInteger(length) && length >= 0 && (sampleWords === 10 || sampleWords === 20) &&
      samples.length === length * sampleWords && Number.isFinite(epsilonLog2) &&
      maxDelta.isFinite() && maxDelta.gte(0);
  }

  get(samples: Float32Array, length: number, sampleWords: number, epsilonLog2: number,
    maxDelta: Decimal): {table:BlaTable;maxDelta:Decimal} | undefined {
    if (!this.validInput(samples, length, sampleWords, epsilonLog2, maxDelta)) return;
    for (let index = this.tables.length - 1; index >= 0; index--) {
      const entry = this.tables[index];
      if (entry.samples !== samples || entry.length !== length || entry.sampleWords !== sampleWords ||
          entry.epsilonLog2 !== epsilonLog2 || entry.maxDelta.lt(maxDelta)) continue;
      // A narrower domain can rescue a nonempty table that had no usable skip.
      // Structural empty tables have no ranges to rescue and remain reusable.
      if (entry.table.entryCount > 0 && !entry.table.hasUsableMultiStep && entry.maxDelta.gt(maxDelta)) continue;
      this.tables.splice(index, 1); this.tables.push(entry);
      return {table:entry.table, maxDelta:new Decimal(entry.maxDelta)};
    }
  }

  remember(samples: Float32Array, length: number, sampleWords: number, epsilonLog2: number,
    maxDelta: Decimal, table: BlaTable): void {
    if (!this.validInput(samples, length, sampleWords, epsilonLog2, maxDelta) ||
        !(table.data instanceof Float32Array) || !(table.data.buffer instanceof ArrayBuffer) ||
        table.data.byteOffset !== 0 || table.data.byteLength !== table.data.buffer.byteLength ||
        !Number.isSafeInteger(table.levels) || table.levels < 1 || table.levels > 21 ||
        !Number.isSafeInteger(table.entryCount) || table.entryCount < 0 ||
        !Array.isArray(table.levelOffsets) || !Array.isArray(table.levelCounts) ||
        table.levelOffsets.length !== table.levels || table.levelCounts.length !== table.levels ||
        typeof table.hasUsableMultiStep !== 'boolean') throw Error('Cannot cache an incompatible BLA table');
    let count = Math.max(0, length - 2), entries = 0, levels = 1;
    for (let level = 0; level < table.levels; level++) {
      const stored = level === 0 ? 0 : count;
      if (table.levelOffsets[level] !== entries || table.levelCounts[level] !== stored) {
        throw Error('Cannot cache an incomplete BLA table');
      }
      entries += stored;
      const next = Math.floor(count / 2);
      if (next >= 1 && levels < 21) levels++;
      count = next;
    }
    if (levels !== table.levels || entries !== table.entryCount ||
        table.data.length !== Math.max(1, entries) * ENTRY_FLOATS) throw Error('Cannot cache an incomplete BLA table');
    let usable = false;
    for (let entry = 0; entry < entries; entry++) {
      const radius = table.data[entry * ENTRY_FLOATS + 10];
      if (!Number.isFinite(radius)) throw Error('Cannot cache an invalid BLA radius');
      if (radius > -1e29) usable = true;
    }
    if (usable !== table.hasUsableMultiStep) throw Error('Cannot cache inconsistent BLA eligibility');
    const bytes = samples.byteLength + table.data.byteLength +
      4 * (table.levelOffsets.length + table.levelCounts.length);
    if (this.maxTables === 0 || bytes > this.maxBytes) return;
    const old = this.tables.findIndex(entry => entry.samples === samples && entry.length === length &&
      entry.sampleWords === sampleWords && entry.epsilonLog2 === epsilonLog2 && entry.maxDelta.eq(maxDelta));
    if (old >= 0) this.bytes -= this.tables.splice(old, 1)[0].bytes;
    const owned = {...table, levelOffsets:[...table.levelOffsets], levelCounts:[...table.levelCounts]};
    Object.freeze(owned.levelOffsets); Object.freeze(owned.levelCounts); Object.freeze(owned);
    this.tables.push({samples, length, sampleWords, epsilonLog2, maxDelta:new Decimal(maxDelta), table:owned, bytes});
    this.bytes += bytes;
    while (this.tables.length > this.maxTables || this.bytes > this.maxBytes) {
      this.bytes -= this.tables.shift()!.bytes;
    }
  }

  clear(): void { this.tables = []; this.bytes = 0; }
}
