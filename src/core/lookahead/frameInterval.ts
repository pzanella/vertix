const WINDOW = 15;
// Steps within this fraction of each other count as the same interval.
const SAME_STEP_FRACTION = 0.1;
// Steps longer than this are a seek or a stall, not a frame interval.
const MAX_STEP_SEC = 0.5;

/**
 * Media-time step between consecutive frames, as the smallest of the
 * recent steps that occurs at least twice: skipped frame callbacks only add
 * longer steps (two, three frames), even when most callbacks are skipped,
 * and a single short timestamp jitter does not count. A real frame-rate
 * change (an HLS/DASH rendition at another frame rate) moves it within a
 * few frames.
 */
export class FrameIntervalTracker {
  private steps: number[] = [];
  private last: number | null = null;

  /** Current interval in media seconds, or null before two frames. */
  get intervalSec(): number | null {
    if (this.steps.length === 0) return null;
    const sorted = [...this.steps].sort((a, b) => a - b);
    let interval = sorted[sorted.length >> 1];
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (sorted[i + 1] <= sorted[i] * (1 + SAME_STEP_FRACTION)) {
        interval = sorted[i + 1];
        break;
      }
    }
    // Media timestamps are microseconds: the rest is float noise from subtracting them.
    return Math.round(interval * 1e6) / 1e6;
  }

  push(mediaTimeSec: number): void {
    const last = this.last;
    this.last = mediaTimeSec;
    if (last === null) return;
    const step = mediaTimeSec - last;
    if (step <= 0 || step > MAX_STEP_SEC) return;
    if (this.steps.length === WINDOW) this.steps.shift();
    this.steps.push(step);
  }

  /** Forgets the last frame (after a seek), keeping the interval. */
  restart(): void {
    this.last = null;
  }

  reset(): void {
    this.steps = [];
    this.last = null;
  }
}
