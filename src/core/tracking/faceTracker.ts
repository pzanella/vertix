import type { FaceBox } from "../layoutEngine";

/**
 * Gives each detected face a stable ID across detections. Tracks are matched
 * greedily (lowest cost first) against each track's box moved forward by its
 * smoothed velocity. Greedy, not Hungarian: there are at most a few dozen
 * boxes, faces rarely overlap, and when they do not both give the same
 * answer; people crossing are handled by the velocity prediction, not by
 * the assignment method.
 *
 * All timings are media-time seconds, so they hold at any detection rate.
 */

// A detection may only match a track whose predicted centre is within this
// many track sizes (max of w, h), and whose size is within this ratio.
const MAX_MATCH_DISTANCE_IN_SIZES = 1.0;
const MAX_SIZE_RATIO = 2;
// Weight of the centre distance (in track sizes) against 1 - IoU in the cost.
const DISTANCE_COST_WEIGHT = 0.5;
// Matches before a track is confirmed. Tracks born on the first detection
// after a reset (start, seek, cut) are confirmed at once instead, like the
// person-count commit after a cut.
const CONFIRM_HITS = 3;
// A confirmed track survives this long without a match (2-3 missed
// detections on a slow phone); an unconfirmed one much less.
const CONFIRMED_MAX_MISSING_SEC = 0.8;
const TENTATIVE_MAX_MISSING_SEC = 0.3;
// The velocity prediction stops after this much missing time, so a
// coasting track does not drift across the frame.
const MAX_PREDICTION_SEC = 0.5;
// Time constants of the per-track smoothing (same style as
// paneSmoothingAlpha): position, size (drives the zoom, so calmer),
// velocity, mouth activity, and the residual jitter used for stability.
const POSITION_TAU_SEC = 0.15;
const SIZE_TAU_SEC = 0.4;
const VELOCITY_TAU_SEC = 0.3;
const MOUTH_TAU_SEC = 0.5;
const JITTER_TAU_SEC = 1.0;
// Longer gaps (a pause, a skipped detection) count as this long.
const MAX_SMOOTHING_DT_SEC = 0.5;

export interface TrackBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface FaceTrack {
  readonly id: number;
  /** Smoothed box. */
  box: TrackBox;
  /** The last detection matched to this track. */
  lastDetection: FaceBox;
  /** Smoothed velocity, fraction of frame per second. */
  vx: number;
  vy: number;
  hits: number;
  confirmed: boolean;
  firstSeenSec: number;
  lastSeenSec: number;
  /** Matched by the latest update. */
  visible: boolean;
  /** Smoothed mouth activity (lower-face minus upper-face change). */
  mouthActivity: number;
  /** Smoothed lower-face change alone, for comparison with the old measure. */
  lowerFaceMotion: number;
  /** Smoothed distance between predicted and detected centre, fraction of frame. */
  jitter: number;
  /** Counts for the layout (set by ForegroundFilter). */
  foreground: boolean;
}

export function smoothingAlpha(dtSec: number, tauSec: number): number {
  return 1 - Math.exp(-Math.min(Math.max(dtSec, 0), MAX_SMOOTHING_DT_SEC) / tauSec);
}

function trackSize(box: TrackBox): number {
  return Math.max(box.w, box.h);
}

export function boxIou(a: TrackBox, b: TrackBox): number {
  const ix = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
  const iy = Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
  const inter = Math.max(0, ix) * Math.max(0, iy);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Where the track is expected at `atSec`, from its smoothed velocity. */
export function predictedBox(track: FaceTrack, atSec: number): TrackBox {
  const dt = Math.min(Math.max(atSec - track.lastSeenSec, 0), MAX_PREDICTION_SEC);
  return { ...track.box, cx: track.box.cx + track.vx * dt, cy: track.box.cy + track.vy * dt };
}

/** Matching cost of `face` for a track predicted at `predicted`, or null when it is outside the gate. */
export function matchCost(predicted: TrackBox, face: FaceBox): number | null {
  const size = trackSize(predicted);
  const distanceInSizes = Math.hypot(face.cx - predicted.cx, face.cy - predicted.cy) / size;
  const sizeRatio = Math.max(face.w, face.h) / size;
  if (distanceInSizes > MAX_MATCH_DISTANCE_IN_SIZES) return null;
  if (sizeRatio > MAX_SIZE_RATIO || sizeRatio < 1 / MAX_SIZE_RATIO) return null;
  return 1 - boxIou(predicted, face) + DISTANCE_COST_WEIGHT * distanceInSizes;
}

export class FaceTracker {
  private live: FaceTrack[] = [];
  private nextId = 1;
  private bootstrap = true;

  get tracks(): readonly FaceTrack[] {
    return this.live;
  }

  /** Matches one detection's faces to the tracks, at media time `atSec`. */
  update(faces: readonly FaceBox[], atSec: number): readonly FaceTrack[] {
    const pairs: { track: FaceTrack; face: number; cost: number; predicted: TrackBox }[] = [];
    for (const track of this.live) {
      const predicted = predictedBox(track, atSec);
      faces.forEach((face, index) => {
        const cost = matchCost(predicted, face);
        if (cost !== null) pairs.push({ track, face: index, cost, predicted });
      });
    }
    pairs.sort((a, b) => a.cost - b.cost);

    const matchedTracks = new Set<FaceTrack>();
    const matchedFaces = new Set<number>();
    for (const pair of pairs) {
      if (matchedTracks.has(pair.track) || matchedFaces.has(pair.face)) continue;
      matchedTracks.add(pair.track);
      matchedFaces.add(pair.face);
      this.applyMatch(pair.track, faces[pair.face], pair.predicted, atSec);
    }

    for (const track of this.live) {
      if (!matchedTracks.has(track)) track.visible = false;
    }
    this.live = this.live.filter((track) => {
      if (track.visible) return true;
      const missingSec = atSec - track.lastSeenSec;
      return missingSec < (track.confirmed ? CONFIRMED_MAX_MISSING_SEC : TENTATIVE_MAX_MISSING_SEC);
    });

    faces.forEach((face, index) => {
      if (!matchedFaces.has(index)) this.live.push(this.newTrack(face, atSec));
    });
    if (faces.length > 0) this.bootstrap = false;
    return this.live;
  }

  /** Drops every track (a cut, a seek, a new source): the next detection starts again and is confirmed at once. */
  reset(): void {
    this.live = [];
    this.bootstrap = true;
  }

  private newTrack(face: FaceBox, atSec: number): FaceTrack {
    return {
      id: this.nextId++,
      box: { cx: face.cx, cy: face.cy, w: face.w, h: face.h },
      lastDetection: face,
      vx: 0,
      vy: 0,
      hits: 1,
      confirmed: this.bootstrap,
      firstSeenSec: atSec,
      lastSeenSec: atSec,
      visible: true,
      mouthActivity: face.motion,
      lowerFaceMotion: face.lowerFaceMotion,
      jitter: 0,
      foreground: false,
    };
  }

  private applyMatch(track: FaceTrack, face: FaceBox, predicted: TrackBox, atSec: number): void {
    const dt = Math.max(0, atSec - track.lastSeenSec);
    const position = smoothingAlpha(dt, POSITION_TAU_SEC);
    const size = smoothingAlpha(dt, SIZE_TAU_SEC);
    const velocity = smoothingAlpha(dt, VELOCITY_TAU_SEC);
    const mouth = smoothingAlpha(dt, MOUTH_TAU_SEC);
    const jitter = smoothingAlpha(dt, JITTER_TAU_SEC);
    const box = track.box;

    if (dt > 0) {
      track.vx += ((face.cx - track.lastDetection.cx) / dt - track.vx) * velocity;
      track.vy += ((face.cy - track.lastDetection.cy) / dt - track.vy) * velocity;
    }
    track.jitter += (Math.hypot(face.cx - predicted.cx, face.cy - predicted.cy) - track.jitter) * jitter;
    box.cx += (face.cx - box.cx) * position;
    box.cy += (face.cy - box.cy) * position;
    box.w += (face.w - box.w) * size;
    box.h += (face.h - box.h) * size;
    track.mouthActivity += (face.motion - track.mouthActivity) * mouth;
    track.lowerFaceMotion += (face.lowerFaceMotion - track.lowerFaceMotion) * mouth;

    track.lastDetection = face;
    track.hits += 1;
    if (track.hits >= CONFIRM_HITS) track.confirmed = true;
    if (atSec > track.lastSeenSec) track.lastSeenSec = atSec;
    track.visible = true;
  }
}
