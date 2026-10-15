/** Frame-copy height used while the device struggles above HIGH_FRAME_RATE_FPS. */
export const REDUCED_SLOT_HEIGHT = 540;
/** Above this frame rate the frame copies may be reduced. */
export const HIGH_FRAME_RATE_FPS = 30;
// Dropped frames are measured over this window.
const DROP_WINDOW_MS = 3000;
// Fewer presented frames than this in the window: not enough to judge.
const MIN_WINDOW_FRAMES = 30;
// Step down above this share of dropped frames, step back up only after
// STEP_UP_AFTER_MS below RECOVERED_DROP_RATIO (hysteresis).
export const STEP_DOWN_DROP_RATIO = 0.05;
export const RECOVERED_DROP_RATIO = 0.02;
export const STEP_UP_AFTER_MS = 10_000;

export type SlotHeightChangeReason = "drops" | "overflow" | "recovered" | "frame-rate";

export interface PlaybackQualitySample {
  droppedVideoFrames: number;
  totalVideoFrames: number;
}

/**
 * Decides whether frame copies use full height or REDUCED_SLOT_HEIGHT.
 * Full height by default; reduced only above HIGH_FRAME_RATE_FPS when the
 * video element drops more than STEP_DOWN_DROP_RATIO of its frames over
 * the last DROP_WINDOW_MS, or the buffer overflows. Back to full height
 * after STEP_UP_AFTER_MS of good playback, or at once at 30 fps or less.
 */
export class SlotHeightGovernor {
  private _reduced = false;
  private samples: (PlaybackQualitySample & { atMs: number })[] = [];
  private lastOverflowDrops = 0;
  private goodSinceMs: number | null = null;

  get reduced(): boolean {
    return this._reduced;
  }

  /** Feeds one reading (a few times a second). Returns the reason when the decision changed, else null. */
  update(
    nowMs: number,
    frameRateFps: number | null,
    quality: PlaybackQualitySample | null,
    overflowDrops: number
  ): SlotHeightChangeReason | null {
    const overflowed = overflowDrops > this.lastOverflowDrops;
    this.lastOverflowDrops = overflowDrops;
    if (frameRateFps === null || frameRateFps <= HIGH_FRAME_RATE_FPS + 0.5) {
      this.samples = [];
      this.goodSinceMs = null;
      return this.set(false, "frame-rate");
    }
    const dropRatio = this.dropRatio(nowMs, quality);
    if (!this._reduced) {
      if (overflowed) return this.set(true, "overflow");
      if (dropRatio !== null && dropRatio > STEP_DOWN_DROP_RATIO) return this.set(true, "drops");
      return null;
    }
    if (overflowed || dropRatio === null || dropRatio > RECOVERED_DROP_RATIO) {
      this.goodSinceMs = null;
      return null;
    }
    this.goodSinceMs ??= nowMs;
    return nowMs - this.goodSinceMs >= STEP_UP_AFTER_MS ? this.set(false, "recovered") : null;
  }

  /** New source or seek: full height, history forgotten. */
  reset(): void {
    this._reduced = false;
    this.samples = [];
    this.lastOverflowDrops = 0;
    this.goodSinceMs = null;
  }

  private set(reduced: boolean, reason: SlotHeightChangeReason): SlotHeightChangeReason | null {
    if (reduced === this._reduced) return null;
    this._reduced = reduced;
    this.goodSinceMs = null;
    // Drops counted before the change say nothing about the new height.
    this.samples = this.samples.slice(-1);
    return reason;
  }

  private dropRatio(nowMs: number, quality: PlaybackQualitySample | null): number | null {
    if (!quality) return null;
    // VideoPlaybackQuality's fields are prototype getters: a spread would copy none.
    this.samples.push({
      atMs: nowMs,
      droppedVideoFrames: quality.droppedVideoFrames,
      totalVideoFrames: quality.totalVideoFrames,
    });
    while (this.samples.length > 2 && this.samples[1].atMs <= nowMs - DROP_WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    const frames = quality.totalVideoFrames - first.totalVideoFrames;
    if (frames < MIN_WINDOW_FRAMES || nowMs - first.atMs < DROP_WINDOW_MS * 0.9) return null;
    return (quality.droppedVideoFrames - first.droppedVideoFrames) / frames;
  }
}
