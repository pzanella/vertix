const WINDOW = 9;
// Steps longer than this are a seek or a stall, not a frame interval.
const MAX_STEP_SEC = 0.5;

/**
 * Media-time step between consecutive frames, as the median of the recent
 * steps: a skipped frame callback (a step of two frames) or a timestamp
 * jitter does not move it, a real frame-rate change (an HLS/DASH rendition
 * at another frame rate) does within a few frames.
 */
export class FrameIntervalTracker {
  private steps: number[] = [];
  private last: number | null = null;

  /** Current interval in media seconds, or null before two frames. */
  get intervalSec(): number | null {
    if (this.steps.length === 0) return null;
    const sorted = [...this.steps].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
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
