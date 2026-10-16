import type { FaceTrack } from "./faceTracker";
import { trackArea } from "./foregroundFilter";

// Weights of the main-subject score (each part is 0..1). Size and mouth
// activity carry the most. Centre and stability only break ties: with
// three people of equal size in a row, the centre part alone must not give
// the middle one a clear lead (0.2 did: 0.55 vs 0.43).
const SIZE_WEIGHT = 0.4;
const CENTRE_WEIGHT = 0.1;
const STABILITY_WEIGHT = 0.15;
const MOUTH_WEIGHT = 0.35;
// RMS energy below which the audio track counts as silence, not speech.
export const AUDIO_ACTIVE_ENERGY = 0.02;
// Age at which a track gets the full stability part, and the centre
// jitter (fraction of frame) at which it gets none.
const STABILITY_FULL_AGE_SEC = 2;
const STABILITY_MAX_JITTER = 0.05;
// Mouth activity below this (mean RGB difference) is noise: nobody's
// mouth part counts when the most active face is below it.
const MIN_MOUTH_ACTIVITY = 0.5;

// A track is clearly ahead when its score beats the runner-up by this
// factor. The audio gate, as before: when audio does not confirm that
// someone is speaking (no audio track, muted, silent, or too quiet), mouth
// activity still counts but the lead must be larger (it was a 2.2x instead
// of 1.5x motion margin).
export const CLEAR_LEAD_FACTOR = 1.25;
export const CLEAR_LEAD_FACTOR_NO_AUDIO = 1.35;
// A clear leader must hold this long before it is first picked, unless the
// pick is immediate (after a cut, or after the subject was lost).
const INITIAL_PICK_SEC = 0.8;
// Minimum time on a subject before any switch: a news speaking turn is
// usually longer than 3 s, and faster switches look nervous.
export const SUBJECT_HOLD_SEC = 2.5;
// A challenger must beat the subject by the lead factor for this long
// (about 5 detections) to take over.
export const SUBJECT_SWITCH_SUSTAIN_SEC = 1.0;
// Absorbs float rounding in media timestamps.
const TIME_EPSILON_SEC = 1e-3;

export interface ScoreContext {
  largestArea: number;
  highestMouthActivity: number;
  audioConfirmed: boolean;
  atSec: number;
}

export function scoreContext(tracks: readonly FaceTrack[], audioEnergy: number | null, atSec: number): ScoreContext {
  let largestArea = 0;
  let highestMouthActivity = 0;
  for (const track of tracks) {
    largestArea = Math.max(largestArea, trackArea(track));
    highestMouthActivity = Math.max(highestMouthActivity, track.mouthActivity);
  }
  return {
    largestArea,
    highestMouthActivity,
    audioConfirmed: audioEnergy !== null && audioEnergy >= AUDIO_ACTIVE_ENERGY,
    atSec,
  };
}

/** Main-subject score of one foreground track: size, distance from the frame centre, age and stability, mouth activity. */
export function subjectScore(track: FaceTrack, context: ScoreContext): number {
  const size = context.largestArea > 0 ? trackArea(track) / context.largestArea : 0;
  const centre = Math.max(0, 1 - Math.abs(track.box.cx - 0.5) / 0.5);
  const age = Math.min(1, Math.max(0, context.atSec - track.firstSeenSec) / STABILITY_FULL_AGE_SEC);
  const stability = age * Math.max(0, 1 - track.jitter / STABILITY_MAX_JITTER);
  const mouth =
    context.highestMouthActivity >= MIN_MOUTH_ACTIVITY ? track.mouthActivity / context.highestMouthActivity : 0;
  return SIZE_WEIGHT * size + CENTRE_WEIGHT * centre + STABILITY_WEIGHT * stability + MOUTH_WEIGHT * mouth;
}

export interface ScoredTrack {
  track: FaceTrack;
  score: number;
}

/** The lead factor a track needs, given whether audio confirms speech. */
export function leadFactor(audioConfirmed: boolean): number {
  return audioConfirmed ? CLEAR_LEAD_FACTOR : CLEAR_LEAD_FACTOR_NO_AUDIO;
}

/** The best track when it beats the runner-up by `factor`, else null. */
export function clearLeader(scored: readonly ScoredTrack[], factor = CLEAR_LEAD_FACTOR): FaceTrack | null {
  if (scored.length === 0) return null;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const [top, runnerUp] = sorted;
  if (top.score <= 0) return null;
  if (runnerUp !== undefined && top.score < runnerUp.score * factor) return null;
  return top.track;
}

/** A track that keeps winning since `sinceSec`. */
interface Streak {
  trackId: number;
  sinceSec: number;
  detections: number;
}

function heldFor(streak: Streak | null, durationSec: number, atSec: number): boolean {
  return streak !== null && streak.detections >= 2 && atSec - streak.sinceSec >= durationSec - TIME_EPSILON_SEC;
}

function extendStreak(streak: Streak | null, trackId: number, atSec: number): Streak {
  if (streak !== null && streak.trackId === trackId && atSec >= streak.sinceSec) {
    return { ...streak, detections: streak.detections + 1 };
  }
  return { trackId, sinceSec: atSec, detections: 1 };
}

/**
 * Chooses and holds the main subject among 3+ foreground tracks. A subject
 * is held for at least SUBJECT_HOLD_SEC, then replaced only by a track that
 * beats it by the lead factor (see leadFactor) for SUBJECT_SWITCH_SUSTAIN_SEC. Without a
 * subject, a clear leader is picked once it has led for INITIAL_PICK_SEC,
 * or at once when `pickNow` (first detection after a cut, or the subject
 * was lost).
 */
export class SubjectSelector {
  private subjectId: number | null = null;
  private subjectSinceSec = 0;
  private leaderStreak: Streak | null = null;
  private challengerStreak: Streak | null = null;

  get subjectTrackId(): number | null {
    return this.subjectId;
  }

  /** Returns the subject track id, or null when nobody is clearly ahead. */
  select(scored: readonly ScoredTrack[], atSec: number, pickNow: boolean, factor = CLEAR_LEAD_FACTOR): number | null {
    const subject = this.subjectId === null ? undefined : scored.find((s) => s.track.id === this.subjectId);
    if (subject === undefined) {
      const lost = this.subjectId !== null;
      this.subjectId = null;
      this.challengerStreak = null;
      return this.pickLeader(scored, atSec, pickNow || lost, factor);
    }

    this.leaderStreak = null;
    if (atSec - this.subjectSinceSec < SUBJECT_HOLD_SEC - TIME_EPSILON_SEC) return this.subjectId;

    let challenger: ScoredTrack | null = null;
    for (const s of scored) {
      if (s.track.id !== this.subjectId && (challenger === null || s.score > challenger.score)) challenger = s;
    }
    if (challenger === null || challenger.score < subject.score * factor) {
      this.challengerStreak = null;
      return this.subjectId;
    }
    this.challengerStreak = extendStreak(this.challengerStreak, challenger.track.id, atSec);
    if (heldFor(this.challengerStreak, SUBJECT_SWITCH_SUSTAIN_SEC, atSec)) this.adopt(challenger.track.id, atSec);
    return this.subjectId;
  }

  /** Forgets the subject: a cut, a seek, or fewer than three foreground faces. */
  reset(): void {
    this.subjectId = null;
    this.leaderStreak = null;
    this.challengerStreak = null;
  }

  private pickLeader(scored: readonly ScoredTrack[], atSec: number, pickNow: boolean, factor: number): number | null {
    const leader = clearLeader(scored, factor);
    if (leader === null) {
      this.leaderStreak = null;
      return null;
    }
    if (pickNow) {
      this.adopt(leader.id, atSec);
      return this.subjectId;
    }
    this.leaderStreak = extendStreak(this.leaderStreak, leader.id, atSec);
    if (heldFor(this.leaderStreak, INITIAL_PICK_SEC, atSec)) this.adopt(leader.id, atSec);
    return this.subjectId;
  }

  private adopt(trackId: number, atSec: number): void {
    this.subjectId = trackId;
    this.subjectSinceSec = atSec;
    this.leaderStreak = null;
    this.challengerStreak = null;
  }
}
