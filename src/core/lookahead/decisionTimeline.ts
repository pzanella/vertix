import type { FaceBox, PaneTarget } from "../layoutEngine";
import type { LayoutRule, TrackSnapshot } from "../tracking/layoutPlanner";

/**
 * A framing change that must not glide: "snap" after a hard cut in the
 * source (the viewer already saw a cut), "dissolve" when the active
 * speaker switches to someone else within the same shot.
 */
export type Reframe = "snap" | "dissolve";

/**
 * How a hard cut was found: on a detection the cut trigger asked for
 * ("trigger"), on a regular detection and moved back to the frame where it
 * happened ("localised"), or on a regular detection that was the cut frame
 * or without lookahead ("tick").
 */
export type CutSource = "trigger" | "localised" | "tick";

/** What one detection decided for the output, from the frame it was computed on onwards. */
export interface LayoutDecision {
  /** Media time of the frame the decision belongs to: the detection frame, or the cut frame for a hard cut. */
  mediaTimeSec: number;
  speakerCount: number;
  targetPanes: PaneTarget[];
  reframe: Reframe | null;
  isCut: boolean;
  /** Set for a hard cut. */
  cutSource: CutSource | null;
  skinRejectedFaces: FaceBox[];
  /** The rule behind `speakerCount` and `targetPanes`. */
  rule: LayoutRule;
  /** The followed person (main subject or its fallback), else null. */
  subjectTrackId: number | null;
  /** The track behind each pane of the latest plan. */
  paneTrackIds: number[];
  /** Every track at this detection, for the "Show tracks" overlay. */
  tracks: TrackSnapshot[];
}

// Media times of one frame can differ in the last bits depending on where
// they were read (rVFC metadata vs. a stored copy).
const MEDIA_TIME_EPSILON_SEC = 1e-4;

/**
 * Layout decisions ordered by media time. Each is released once a frame
 * at or after its media time is displayed, so a change lands on the frame
 * it was computed for, however late the detection result arrived — as
 * long as it arrived before that frame was displayed.
 */
export class DecisionTimeline {
  private entries: LayoutDecision[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** Inserts in media-time order; equal times keep arrival order. */
  push(decision: LayoutDecision): void {
    let i = this.entries.length;
    while (i > 0 && this.entries[i - 1].mediaTimeSec > decision.mediaTimeSec) i -= 1;
    this.entries.splice(i, 0, decision);
  }

  /** Removes and returns, oldest first, every decision for a frame at or before `mediaTimeSec`. */
  takeDue(mediaTimeSec: number): LayoutDecision[] {
    let count = 0;
    while (count < this.entries.length && this.entries[count].mediaTimeSec <= mediaTimeSec + MEDIA_TIME_EPSILON_SEC) {
      count += 1;
    }
    return count === 0 ? [] : this.entries.splice(0, count);
  }

  /** Removes and returns every decision, oldest first. */
  takeAll(): LayoutDecision[] {
    const all = this.entries;
    this.entries = [];
    return all;
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Merges decisions released on the same displayed frame into one: the
 * latest layout wins, a snap anywhere in the batch wins over a dissolve
 * (the viewer is about to see a cut either way).
 */
export function mergeDecisions(decisions: LayoutDecision[]): LayoutDecision | null {
  if (decisions.length === 0) return null;
  const latest = decisions[decisions.length - 1];
  let reframe: Reframe | null = null;
  let cut: LayoutDecision | null = null;
  for (const d of decisions) {
    if (d.reframe === "snap") reframe = "snap";
    else if (d.reframe === "dissolve" && reframe === null) reframe = "dissolve";
    if (d.isCut && cut === null) cut = d;
  }
  return { ...latest, reframe, isCut: cut !== null, cutSource: cut?.cutSource ?? null };
}
