// Timings below are media-time seconds, measured from the first detection
// that agrees, so they hold at any frame rate or detection rate. At least
// MIN_AGREEING_DETECTIONS must agree, so one stray reading never commits.
const MIN_AGREEING_DETECTIONS = 2;
// Absorbs float rounding in media timestamps (0.2 * 5 !== 1.0).
export const TIME_EPSILON_SEC = 1e-3;

// A person-count change only takes effect once detections have agreed for
// this long, so a single misdetection doesn't flip the layout and back.
// Three cases: the very first commit (nothing on screen yet, safe to be
// fast), a normal count change (needs more confirmation), and dropping to
// 0/B-roll (faster than a normal change, but not instant either).
const PERSON_COUNT_STABLE_SEC_INITIAL = 0.2;
const PERSON_COUNT_STABLE_SEC = 1.0;
const PERSON_COUNT_DROP_TO_ZERO_SEC = 0.2;
// After a scene cut the new count is committed from a single detection.
// For this long afterwards, count changes use the short initial debounce,
// so a wrong first reading is corrected in ~0.2s instead of ~1s.
const POST_CUT_SHORT_DEBOUNCE_SEC = 1.0;

/** Tracks how long consecutive detections have agreed, in media time. */
export class AgreementStreak {
  private startSec = 0;
  private detections = 0;

  /** Starts a new streak at `atSec`. */
  restart(atSec: number): void {
    this.startSec = atSec;
    this.detections = 1;
  }

  get startedAtSec(): number {
    return this.startSec;
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

/** Holds back person-count changes until consecutive detections have agreed long enough. */
export class PersonCountDebouncer {
  private stable = 0;
  private pendingCount = 0;
  private pendingStreak = new AgreementStreak();
  private lastCutSec: number | null = null;

  get stableCount(): number {
    return this.stable;
  }

  /** Commits `count` right away, without debounce: the first detection after a scene cut, at media time `atSec`. */
  commitNow(count: number, atSec: number): number {
    this.stable = count;
    this.pendingCount = count;
    this.pendingStreak.restart(atSec);
    this.lastCutSec = atSec;
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
        : hasCommittedLayout && !this.startedSoonAfterCut()
          ? PERSON_COUNT_STABLE_SEC
          : PERSON_COUNT_STABLE_SEC_INITIAL;
    if (this.pendingStreak.hasHeldFor(requiredSec, atSec)) this.stable = count;
    return this.stable;
  }

  reset(): void {
    this.stable = 0;
    this.pendingCount = 0;
    this.pendingStreak.clear();
    this.lastCutSec = null;
  }

  private startedSoonAfterCut(): boolean {
    if (this.lastCutSec === null) return false;
    const sinceCutSec = this.pendingStreak.startedAtSec - this.lastCutSec;
    return sinceCutSec >= 0 && sinceCutSec < POST_CUT_SHORT_DEBOUNCE_SEC - TIME_EPSILON_SEC;
  }
}
