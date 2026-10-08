import type { FaceBox } from "./layoutEngine";

// Timings below are media-time seconds, measured from the first detection
// that agrees, so they hold at any frame rate or detection rate. At least
// MIN_AGREEING_DETECTIONS must agree, so one stray reading never commits.
const MIN_AGREEING_DETECTIONS = 2;
// Absorbs float rounding in media timestamps (0.2 * 5 !== 1.0).
const TIME_EPSILON_SEC = 1e-3;

// A person-count change only takes effect once detections have agreed for
// this long, so a single misdetection doesn't flip the layout and back.
// Three cases: the very first commit (nothing on screen yet, safe to be
// fast), a normal count change (needs more confirmation), and dropping to
// 0/B-roll (faster than a normal change, but not instant either).
const PERSON_COUNT_STABLE_SEC_INITIAL = 0.2;
const PERSON_COUNT_STABLE_SEC = 1.0;
const PERSON_COUNT_DROP_TO_ZERO_SEC = 0.2;

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

/** Tracks how long consecutive detections have agreed, in media time. */
class AgreementStreak {
  private startSec = 0;
  private detections = 0;

  /** Starts a new streak at `atSec`. */
  restart(atSec: number): void {
    this.startSec = atSec;
    this.detections = 1;
  }

  /** Adds an agreeing detection; restarts instead after a clear or if media time went backwards. */
  extend(atSec: number): void {
    if (this.detections === 0 || atSec < this.startSec) this.restart(atSec);
    else this.detections += 1;
  }

  clear(): void {
    this.detections = 0;
  }

  hasHeldFor(durationSec: number, atSec: number): boolean {
    return this.detections >= MIN_AGREEING_DETECTIONS && atSec - this.startSec >= durationSec - TIME_EPSILON_SEC;
  }
}

function closestFaceTo(faces: FaceBox[], pos: FacePosition): FaceBox {
  return faces.reduce((best, f) => {
    const d = (f.cx - pos.cx) ** 2 + (f.cy - pos.cy) ** 2;
    const bd = (best.cx - pos.cx) ** 2 + (best.cy - pos.cy) ** 2;
    return d < bd ? f : best;
  });
}

/** Holds back person-count changes until consecutive detections have agreed long enough. */
export class PersonCountDebouncer {
  private stable = 0;
  private pendingCount = 0;
  private pendingStreak = new AgreementStreak();

  get stableCount(): number {
    return this.stable;
  }

  /** Feeds one detection's resolved face count, taken at media time `atSec`; returns the (possibly unchanged) committed count. */
  observe(count: number, hasCommittedLayout: boolean, atSec: number): number {
    if (count === this.pendingCount) {
      this.pendingStreak.extend(atSec);
    } else {
      this.pendingCount = count;
      this.pendingStreak.restart(atSec);
    }
    const requiredSec =
      count === 0
        ? PERSON_COUNT_DROP_TO_ZERO_SEC
        : hasCommittedLayout
          ? PERSON_COUNT_STABLE_SEC
          : PERSON_COUNT_STABLE_SEC_INITIAL;
    if (this.pendingStreak.hasHeldFor(requiredSec, atSec)) this.stable = count;
    return this.stable;
  }

  reset(): void {
    this.stable = 0;
    this.pendingCount = 0;
    this.pendingStreak.clear();
  }
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
 * If neither signal is confident, falls back to the raw faces (today's
 * ordinary split/grid) at AMBIGUOUS_GRID_FALLBACK_FACES or below, or to
 * showing nothing above it — better to punt on a scene we can't read
 * than confidently show the wrong crop.
 */
export class ActiveSpeakerResolver {
  private lockedPos: FacePosition | null = null;
  private pendingPos: FacePosition | null = null;
  private pendingStreak = new AgreementStreak();

  /** `energy` is the audio reading for the same detection, or null when there is no usable audio; `atSec` is its media time. */
  resolve(rawFaces: FaceBox[], energy: number | null, atSec: number): FaceBox[] {
    if (rawFaces.length < ACTIVE_SPEAKER_THRESHOLD) return rawFaces;
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
      return this.lockedPos ? [closestFaceTo(rawFaces, this.lockedPos)] : ambiguousFallback;
    }

    const candidate = { cx: winner.cx, cy: winner.cy };
    if (this.pendingPos && isSamePerson(this.pendingPos, candidate)) {
      this.pendingStreak.extend(atSec);
    } else {
      this.pendingPos = candidate;
      this.pendingStreak.restart(atSec);
    }
    if (this.pendingStreak.hasHeldFor(ACTIVE_SPEAKER_LOCK_SEC, atSec)) {
      this.lockedPos = candidate;
    }

    return this.lockedPos ? [closestFaceTo(rawFaces, this.lockedPos)] : ambiguousFallback;
  }

  reset(): void {
    this.lockedPos = null;
    this.pendingPos = null;
    this.pendingStreak.clear();
  }
}
