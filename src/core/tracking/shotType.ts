/**
 * What kind of shot is on screen. "close": one or two large people, framed
 * as before. "wide": the faces are small in the frame (a crowd, a pitch), so
 * the whole frame is shown. "none": no face at all, the whole frame too.
 */
export type ShotType = "close" | "wide" | "none";

export const SHOT_TYPES: readonly ShotType[] = ["close", "wide", "none"];

export interface ShotRules {
  /** A largest foreground face at least this tall (fraction of the frame, max of width and height) makes the shot close. */
  closeMinHmax: number;
  /** Below this the shot is wide. Between the two thresholds the shot keeps its class (at a cut: close). */
  wideMaxHmax: number;
  /** A change of shot type inside a shot must hold this long (media seconds) before it applies. */
  shotHoldSec: number;
  /** Right after a cut the hold is this short, for cutHoldWindowSec of media time. */
  cutHoldSec: number;
  cutHoldWindowSec: number;
}

export const DEFAULT_SHOT_RULES: ShotRules = {
  closeMinHmax: 0.25,
  wideMaxHmax: 0.15,
  shotHoldSec: 1,
  cutHoldSec: 0.2,
  cutHoldWindowSec: 1,
};

export interface ShotObservation {
  /** Largest visible foreground face: max of its width and height, fraction of the frame. */
  largestFaceSize: number;
  foregroundCount: number;
}

const HOLD_EPSILON_SEC = 1e-3;

/** The shot type one detection points to, or null inside the zone between the two thresholds (no vote). */
export function shotCandidate(observation: ShotObservation, rules: ShotRules = DEFAULT_SHOT_RULES): ShotType | null {
  if (observation.foregroundCount === 0) return "none";
  if (observation.largestFaceSize >= rules.closeMinHmax) return "close";
  if (observation.largestFaceSize < rules.wideMaxHmax) return "wide";
  return null;
}

/**
 * Follows the shot type from one detection to the next. A shot starts at a
 * hard cut (and after a reset): its first detection decides at once, or
 * "close" inside the zone between the thresholds. Inside a shot, a change
 * applies only when the other side's candidate has held for the hold time;
 * a detection inside the zone keeps the current class.
 */
export class ShotTypeTracker {
  private type: ShotType = "close";
  private shotStartSec: number | null = null;
  private candidate: ShotType | null = null;
  private candidateSinceSec = 0;

  constructor(private readonly rules: ShotRules = DEFAULT_SHOT_RULES) {}

  get current(): ShotType {
    return this.type;
  }

  /** Shot type for the detection at `atSec`; `startsShot`: a hard cut, or the first detection after a reset. */
  observe(observation: ShotObservation, atSec: number, startsShot: boolean): ShotType {
    const candidate = shotCandidate(observation, this.rules);
    if (startsShot || this.shotStartSec === null) {
      this.type = candidate ?? "close";
      this.shotStartSec = atSec;
      this.candidate = null;
      return this.type;
    }
    if (candidate === null || candidate === this.type) {
      this.candidate = null;
      return this.type;
    }
    if (candidate !== this.candidate) {
      this.candidate = candidate;
      this.candidateSinceSec = atSec;
    }
    if (atSec - this.candidateSinceSec >= this.holdSec(atSec) - HOLD_EPSILON_SEC) {
      this.type = candidate;
      this.candidate = null;
    }
    return this.type;
  }

  /** Forgets the shot (a seek, a new source): the next detection decides at once. */
  reset(): void {
    this.type = "close";
    this.shotStartSec = null;
    this.candidate = null;
  }

  private holdSec(atSec: number): number {
    const sinceShotStartSec = atSec - (this.shotStartSec ?? atSec);
    return sinceShotStartSec < this.rules.cutHoldWindowSec ? this.rules.cutHoldSec : this.rules.shotHoldSec;
  }
}
