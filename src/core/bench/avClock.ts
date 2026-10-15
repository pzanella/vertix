// Half-width, in media seconds, of the window the clock offset is the median over.
const CLOCK_WINDOW_SEC = 2;

export interface DisplayTiming {
  mediaTimeSec: number;
  /** When the frame reaches the screen. */
  onScreenAtMs: number;
  /** Lookahead it is shown behind (the audio is delayed as much); 0 without. */
  delayMs: number;
}

/**
 * Audio/video offset of each displayed frame against a steady clock: the
 * time it reaches the screen minus when its audio is heard. The audio
 * clock never jitters; the video element shows each frame on a screen
 * refresh near its audio time, a refresh or more early or late when it
 * drops frames. So the clock is estimated, at each media time, as the
 * median of (expectedDisplayMs − mediaTime) over the frame callbacks
 * within ±CLOCK_WINDOW_SEC. The same measure applies with lookahead off
 * (the video element's own jitter, the baseline) and on. Playback rate 1,
 * as the benchmark plays. NaN where no callback is near.
 */
export function avClockErrorsMs(
  callbackMediaSec: ArrayLike<number>,
  callbackDisplayMs: ArrayLike<number>,
  displays: readonly DisplayTiming[]
): number[] {
  const points: { t: number; offsetMs: number }[] = [];
  for (let i = 0; i < callbackMediaSec.length; i++) {
    const offsetMs = callbackDisplayMs[i] - callbackMediaSec[i] * 1000;
    if (Number.isFinite(offsetMs)) points.push({ t: callbackMediaSec[i], offsetMs });
  }
  points.sort((a, b) => a.t - b.t);
  const firstAtOrAfter = (t: number) => {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return displays.map(({ mediaTimeSec, onScreenAtMs, delayMs }) => {
    const from = firstAtOrAfter(mediaTimeSec - CLOCK_WINDOW_SEC);
    const to = firstAtOrAfter(mediaTimeSec + CLOCK_WINDOW_SEC + 1e-9);
    if (to <= from || !Number.isFinite(onScreenAtMs)) return NaN;
    const offsets = points.slice(from, to).map((p) => p.offsetMs);
    offsets.sort((a, b) => a - b);
    const mid = offsets.length >> 1;
    const clockOffsetMs = offsets.length % 2 === 1 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
    return onScreenAtMs - (mediaTimeSec * 1000 + clockOffsetMs + delayMs);
  });
}
