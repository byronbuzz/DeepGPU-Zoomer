import type { SavedView } from './state';

export type NavigationView = Pick<SavedView, 'family' | 'x' | 'y' | 'span' | 'jx' | 'jy' | 'iterations' | 'angle'>;

/** A cap change alone does not depart from the current camera location. */
export function sameNavigationLocation(a: NavigationView, b: NavigationView): boolean {
  return a.family === b.family && a.x === b.x && a.y === b.y && a.span === b.span &&
    a.jx === b.jx && a.jy === b.jy && (a.angle ?? 0) === (b.angle ?? 0);
}

/** Stores owned stationary departures; no fields, imagery or per-frame snapshots. */
export class NavigationHistory<T> {
  private entries: T[] = [];
  private active = false;
  private lastChange = 0;

  get count(): number { return this.entries.length; }

  capture<U>(read: () => U): U | null { return this.active ? null : read(); }

  changed(before: T | null, time: number): void {
    if (!this.active && before !== null) this.push(before);
    this.active = true;
    this.lastChange = time;
  }

  settle(time: number, held: boolean): void {
    if (!held && this.active && time - this.lastChange >= 250) this.active = false;
  }

  jumped(before: T | null): void {
    if (!this.active && before !== null) this.push(before);
    this.restored();
  }

  restored(): void { this.active = false; }

  back(): T | undefined {
    this.restored();
    return this.entries.pop();
  }

  clear(): void {
    this.entries.length = 0;
    this.restored();
  }

  private push(entry: T): void {
    this.entries.push(entry);
    if (this.entries.length > 1000) this.entries.shift();
  }
}
