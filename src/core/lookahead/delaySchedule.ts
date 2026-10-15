/**
 * Largest speed change a delay ramp may cause: while the delay grows by Δ
 * over a ramp of length T, audio plays at 1 − Δ/T speed and video repeats
 * a frame now and then (the opposite while it shrinks). 5% is hard to hear
 * on speech and invisible on video.
 */
export const MAX_RAMP_SPEED_CHANGE = 0.05;
export const MIN_RAMP_MS = 300;

/**
 * The output delay (ms) as a function of wall time (performance.now()):
 * constant, or a linear ramp from one value to another. The video display
 * and the audio DelayNode follow the same function, so a change of
 * lookahead length never needs a flush or a gap.
 */
export class DelaySchedule {
  private fromMs = 0;
  private toMs = 0;
  private startAt = 0;
  private endAt = 0;

  /** The delay the schedule ends at. */
  get targetMs(): number {
    return this.toMs;
  }

  /** When the current ramp ends (in the past when not ramping). */
  get rampEndsAt(): number {
    return this.endAt;
  }

  /** Jumps to `delayMs` at once (after a flush, nothing in flight depends on the old value). */
  set(delayMs: number): void {
    this.fromMs = delayMs;
    this.toMs = delayMs;
    this.startAt = 0;
    this.endAt = 0;
  }

  /** Ramps from the current value to `delayMs`; returns the ramp duration in ms (0 if no change). */
  rampTo(nowMs: number, delayMs: number): number {
    const current = this.valueAt(nowMs);
    if (delayMs === current) {
      this.set(delayMs);
      return 0;
    }
    const durationMs = Math.max(MIN_RAMP_MS, Math.abs(delayMs - current) / MAX_RAMP_SPEED_CHANGE);
    this.fromMs = current;
    this.toMs = delayMs;
    this.startAt = nowMs;
    this.endAt = nowMs + durationMs;
    return durationMs;
  }

  valueAt(nowMs: number): number {
    if (nowMs >= this.endAt) return this.toMs;
    if (nowMs <= this.startAt) return this.fromMs;
    return this.fromMs + ((this.toMs - this.fromMs) * (nowMs - this.startAt)) / (this.endAt - this.startAt);
  }

  isRamping(nowMs: number): boolean {
    return nowMs < this.endAt;
  }
}
