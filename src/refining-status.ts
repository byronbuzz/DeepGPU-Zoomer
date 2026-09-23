/** Display-only progress hold; numerical work and the refinement timer run separately. */
export class RefiningStatus {
  private displayed = 0;
  private held = false;
  private holdUntil = 0;

  start() { this.held = true; }
  finish(now: number) { if (this.held) { this.held = false; this.holdUntil = now + 250; } }
  wheel(now: number) { this.holdUntil = Math.max(this.holdUntil, now + 250); }
  reset() { this.displayed = 0; this.held = false; this.holdUntil = 0; }
  percentage(now: number, actual: number) {
    if (!this.held && now >= this.holdUntil) this.displayed = Math.max(0, Math.min(100, Math.round(actual)));
    return this.displayed;
  }
  text(now: number, actual: number) { return `Refining · ${String(this.percentage(now, actual)).padStart(3, ' ')}%`; }
}
