// Signed offset of each known cut, in displayed frames: how many frames were
// shown from the source cut up to (not including) the frame the crop changed
// on (positive = late), or from the crop change up to the cut (negative =
// early). A crop change is matched to a cut when it falls within
// MAX_OFFSET_FRAMES source frames of it; otherwise the cut is "missed".

export const MAX_OFFSET_FRAMES = 5;
const EPSILON_SEC = 1e-4;

function framesBetween(displayedMediaTimeSec, fromSec, toSec) {
  return displayedMediaTimeSec.filter((t) => t >= fromSec - EPSILON_SEC && t < toSec - EPSILON_SEC).length;
}

/**
 * `{ timeSec, offsetFrames, shownMediaTimeSec, source }` per known cut;
 * offsetFrames is null when missed. `cutsShown` are the run's crop changes at
 * cuts, `displayedMediaTimeSec` the media time of every displayed frame.
 */
export function cutOffsets(knownCutsSec, cutsShown, fps, displayedMediaTimeSec) {
  return knownCutsSec.map((timeSec) => {
    let best = null;
    for (const shown of cutsShown) {
      const distance = Math.abs(shown.shownMediaTimeSec - timeSec) * fps;
      if (distance > MAX_OFFSET_FRAMES + EPSILON_SEC) continue;
      if (best === null || distance < best.distance) best = { distance, shown };
    }
    if (best === null) return { timeSec, offsetFrames: null, shownMediaTimeSec: null, source: null };
    const shownSec = best.shown.shownMediaTimeSec;
    const offsetFrames =
      shownSec >= timeSec - EPSILON_SEC
        ? framesBetween(displayedMediaTimeSec, timeSec, shownSec)
        : -framesBetween(displayedMediaTimeSec, shownSec, timeSec);
    return { timeSec, offsetFrames, shownMediaTimeSec: shownSec, source: best.shown.source };
  });
}

/** "+1", "-2", "0" or "missed". */
export function formatOffset(offsetFrames) {
  if (offsetFrames === null) return "missed";
  return offsetFrames > 0 ? `+${offsetFrames}` : String(offsetFrames);
}
