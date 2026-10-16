import type { FaceBox } from "../layoutEngine";
import { AgreementStreak, TIME_EPSILON_SEC } from "../personCount";

// main's active-speaker resolution for 3+ faces, kept unchanged so the
// branch can fall back to it (MANY_FACES_RULES = "main" in layoutPlanner.ts).
// It reads `motion` as main did: the lower-face change alone.

// --- Active-speaker resolution ----------------------------------------
// From this many raw faces up, a plain split/grid stops being a safe
// default — it could be a genuine multi-person conversation, or just one
// person talking with a silent bystander close enough to camera to pass
// the filters (an interview subject with a reporter's face/mic arm in
// frame, a press scrum). See ActiveSpeakerResolver for how it tells them apart.
//
// Tried at 2 and reverted: on a real interview (subject + a reporter
// holding a mic into frame, facing away from camera), the size-dominance
// check picked the reporter — her mic/shoulder read as the larger box at
// that moment — and the lock then held the crop on her, facing
// away, for several seconds while the actual subject went unshown. At 2
// faces a plain split at least always keeps the real subject visible in
// their own pane; a confidently-wrong single-speaker lock is worse than
// that, so this only runs at 3+ again, where it was validated for longer.
const ACTIVE_SPEAKER_THRESHOLD = 3;
// At this face count or below, a scene the resolver can't confidently
// read falls back to the ordinary grid instead of showing nothing — this is
// what keeps a genuine 3-person conversation looking normal whenever
// nobody's clearly dominant. Above it, an unresolved scene is assumed too
// crowded to guess at and shows no crop instead.
const AMBIGUOUS_GRID_FALLBACK_FACES = 3;
// RMS energy below which the audio track counts as silence, not speech.
// A rough starting value — hasn't been tuned against real broadcast audio.
const AUDIO_ACTIVE_ENERGY = 0.02;
// A face's mouth-motion score must beat the runner-up by this multiple to
// count as a clear active speaker, once audio has confirmed someone's
// actually talking.
const ACTIVE_SPEAKER_MARGIN = 1.5;
// Same idea, used when audio can't confirm anyone's speaking — which in
// practice is most playback: no audio track at all, muted (by the viewer,
// or by the browser refusing audible autoplay), or silent on cross-origin
// sources without CORS. Motion
// still gets tried, just held to a stricter margin to make up for the
// missing confirmation.
const ACTIVE_SPEAKER_MARGIN_NO_AUDIO = 2.2;
// A face's size must beat the next-largest by this multiple to count as
// clearly the foregrounded subject — checked before motion, and without
// needing audio. Camera shake reads as motion on every face in a scene;
// framing size doesn't have that problem, and interview subjects are
// usually shot larger than bystanders. Tuned against a real press scrum
// where the actual speaker's face measured about 2x the next-largest.
const FACE_SIZE_DOMINANCE_MARGIN = 1.4;
// How long a new candidate has to keep winning before the resolver
// actually locks onto them — same idea as PERSON_COUNT_STABLE_SEC, applied
// to who's framed instead of how many.
const ACTIVE_SPEAKER_LOCK_SEC = 0.8;
// A candidate within this distance (fraction of frame, per axis) of where
// its streak started counts as "the same person". It is a distance, not a
// speed: it bounds drift over the whole lock window, which is already time-based.
const SAME_PERSON_DISTANCE = 0.08;
// The locked face is followed from one detection to the next. If no face is
// within this straight-line distance (fraction of frame) of where it was,
// the locked person is gone (or the camera cut) and the lock is released
// instead of jumping onto whoever is nearest.
const MAX_LOCK_DISTANCE = 0.15;
// Below ACTIVE_SPEAKER_THRESHOLD faces, the lock is only released once the
// count has stayed low for this long. On slow devices (3-5 detections per
// second, with skips) a single missed face is common, and relocking takes
// ACTIVE_SPEAKER_LOCK_SEC, too close to the count debounce to hide.
const LOCK_GRACE_BELOW_THRESHOLD_SEC = 0.4;
// When the lock moves to a person at least this far (straight-line,
// fraction of frame) from the previously locked one, the framing changes
// with a short cross-dissolve instead of panning across the room. Same as
// MAX_LOCK_DISTANCE: beyond it the lock already treats a face as someone
// else. It is also about half the width of a 9:16 crop of a 16:9 frame,
// so the new speaker would sit near the edge of the old crop.
const SPEAKER_SWITCH_DISTANCE = MAX_LOCK_DISTANCE;

interface FacePosition {
  cx: number;
  cy: number;
}

/** The single face whose score clearly stands out from the rest by at least `margin`×, or null if the top two are too close to call (or there's only a zero-scoring "winner", which isn't one). */
function dominantBy(faces: FaceBox[], scoreOf: (f: FaceBox) => number, margin: number): FaceBox | null {
  const sorted = [...faces].sort((a, b) => scoreOf(b) - scoreOf(a));
  const top = sorted[0];
  const topScore = scoreOf(top);
  if (topScore <= 0) return null;
  const runnerUp = sorted[1];
  if (runnerUp !== undefined && topScore <= scoreOf(runnerUp) * margin) return null;
  return top;
}

function isSamePerson(a: FacePosition, b: FacePosition): boolean {
  return Math.abs(a.cx - b.cx) < SAME_PERSON_DISTANCE && Math.abs(a.cy - b.cy) < SAME_PERSON_DISTANCE;
}

function distanceBetween(a: FacePosition, b: FacePosition): number {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

function closestFaceTo(faces: FaceBox[], pos: FacePosition): FaceBox | null {
  let best: FaceBox | null = null;
  for (const f of faces) {
    if (best === null || distanceBetween(f, pos) < distanceBetween(best, pos)) best = f;
  }
  return best;
}

/**
 * Resolves raw detected faces down to what the layout should actually
 * track for one detection. Below ACTIVE_SPEAKER_THRESHOLD, faces pass through
 * unchanged.
 *
 * Above it, a plain split/grid isn't trustworthy anymore — it could be a
 * real multi-person conversation, or one person talking with a silent
 * bystander close enough to camera to pass the filters. This looks for a
 * single active speaker: first by framing size (works without audio),
 * then by mouth motion if sizes are too close to call. A winner has to
 * hold for ACTIVE_SPEAKER_LOCK_SEC before the resolver actually locks onto them, so
 * one noisy read doesn't flip the framing.
 *
 * Once locked, the lock follows that face from detection to detection. It
 * is released when the face is gone (no face within MAX_LOCK_DISTANCE), or
 * when fewer than ACTIVE_SPEAKER_THRESHOLD faces remain for
 * LOCK_GRACE_BELOW_THRESHOLD_SEC. When a new winner takes the lock from
 * someone at least SPEAKER_SWITCH_DISTANCE away, `switchedSpeaker` is
 * true for that detection, so the caller can change framing without a pan.
 *
 * If neither signal is confident, falls back to the raw faces (today's
 * ordinary split/grid) at AMBIGUOUS_GRID_FALLBACK_FACES or below, or to
 * showing nothing above it — better to punt on a scene we can't read
 * than confidently show the wrong crop.
 */
export class ActiveSpeakerResolver {
  private lockedPos: FacePosition | null = null;
  private pendingPos: FacePosition | null = null;
  private pendingStreak = new AgreementStreak();
  private belowThresholdSinceSec: number | null = null;
  private switched = false;

  /** Whether the last `resolve` moved the lock to a different person, at least SPEAKER_SWITCH_DISTANCE away. */
  get switchedSpeaker(): boolean {
    return this.switched;
  }

  /** `energy` is the audio reading for the same detection, or null when there is no usable audio; `atSec` is its media time. */
  resolve(rawFaces: FaceBox[], energy: number | null, atSec: number): FaceBox[] {
    this.switched = false;
    if (rawFaces.length < ACTIVE_SPEAKER_THRESHOLD) return this.resolveBelowThreshold(rawFaces, atSec);
    this.belowThresholdSinceSec = null;
    this.followLock(rawFaces);
    const ambiguousFallback = rawFaces.length <= AMBIGUOUS_GRID_FALLBACK_FACES ? rawFaces : [];

    // Size doesn't need audio — playback is often muted or has no audio
    // track, so a signal that required audio would frequently go unused.
    let winner = dominantBy(rawFaces, (f) => Math.max(f.w, f.h), FACE_SIZE_DOMINANCE_MARGIN);

    if (winner === null) {
      // Sizes are too close to call — try motion instead, held to a
      // stricter margin if audio hasn't confirmed anyone's actually
      // talking.
      const audioConfirmed = energy !== null && energy >= AUDIO_ACTIVE_ENERGY;
      winner = dominantBy(
        rawFaces,
        (f) => f.motion,
        audioConfirmed ? ACTIVE_SPEAKER_MARGIN : ACTIVE_SPEAKER_MARGIN_NO_AUDIO
      );
    }

    if (winner === null) {
      // No confident winner in this detection — don't restart the lock streak,
      // but don't extend it either. Keep showing whoever's already locked
      // on, if anyone.
      this.pendingPos = null;
      this.pendingStreak.clear();
      return this.lockedFaceIn(rawFaces) ?? ambiguousFallback;
    }

    const candidate = { cx: winner.cx, cy: winner.cy };
    if (this.pendingPos && isSamePerson(this.pendingPos, candidate)) {
      this.pendingStreak.extend(atSec);
    } else {
      this.pendingPos = candidate;
      this.pendingStreak.restart(atSec);
    }
    if (this.pendingStreak.hasHeldFor(ACTIVE_SPEAKER_LOCK_SEC, atSec)) {
      this.switched = this.lockedPos !== null && distanceBetween(this.lockedPos, candidate) >= SPEAKER_SWITCH_DISTANCE;
      this.lockedPos = candidate;
    }

    return this.lockedFaceIn(rawFaces) ?? ambiguousFallback;
  }

  reset(): void {
    this.lockedPos = null;
    this.pendingPos = null;
    this.pendingStreak.clear();
    this.belowThresholdSinceSec = null;
    this.switched = false;
  }

  /** Too few faces for a lock to be needed: keeps an existing lock through a short gap, then releases it. */
  private resolveBelowThreshold(rawFaces: FaceBox[], atSec: number): FaceBox[] {
    if (this.lockedPos === null) return rawFaces;
    if (this.belowThresholdSinceSec === null || atSec < this.belowThresholdSinceSec) {
      this.belowThresholdSinceSec = atSec;
    }
    if (atSec - this.belowThresholdSinceSec >= LOCK_GRACE_BELOW_THRESHOLD_SEC - TIME_EPSILON_SEC) {
      this.reset();
      return rawFaces;
    }
    this.followLock(rawFaces);
    return this.lockedFaceIn(rawFaces) ?? rawFaces;
  }

  /** Moves the lock to the locked person's new position, or releases it if they are gone. */
  private followLock(rawFaces: FaceBox[]): void {
    if (this.lockedPos === null) return;
    const nearest = closestFaceTo(rawFaces, this.lockedPos);
    if (nearest === null || distanceBetween(nearest, this.lockedPos) > MAX_LOCK_DISTANCE) {
      this.reset();
      return;
    }
    this.lockedPos = { cx: nearest.cx, cy: nearest.cy };
  }

  private lockedFaceIn(rawFaces: FaceBox[]): FaceBox[] | null {
    if (this.lockedPos === null) return null;
    const face = closestFaceTo(rawFaces, this.lockedPos);
    return face ? [face] : null;
  }
}
