import Decimal from 'decimal.js';

/** Small LRU for pure geometry. Decimal methods are nonmutating; their
 * constructors' arithmetic settings are mutable and must be part of the key.
 * Snapshot operand identities and scalar fields, never mutable view containers.
 */
export class ExactGeometryCache<T> {
  private entries: Array<{key: unknown[]; value: T}> = [];

  constructor(private readonly capacity: number) {}

  get(operands: readonly Decimal[], scalars: readonly unknown[], compute: () => T): T {
    const key: unknown[] = [...scalars];
    const config = (ctor: typeof Decimal) => {
      key.push(ctor, ctor.precision, ctor.rounding, ctor.minE, ctor.maxE);
    };
    config(Decimal);
    for (const operand of operands) {
      key.push(operand);
      config(operand.constructor as typeof Decimal);
    }
    const index = this.entries.findIndex(entry => entry.key.length === key.length &&
      entry.key.every((part, i) => Object.is(part, key[i])));
    if (index >= 0) {
      const entry = this.entries.splice(index, 1)[0];
      this.entries.unshift(entry);
      return entry.value;
    }
    const value = compute();
    this.entries.unshift({key, value});
    if (this.entries.length > this.capacity) this.entries.pop();
    return value;
  }
}
