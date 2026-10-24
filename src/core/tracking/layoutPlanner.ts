import { groupFitsInFrame, groupFrameFace, type FaceBox } from "../layoutEngine";
import { FaceTracker, type FaceTrack } from "./faceTracker";
import { trackArea, updateForeground } from "./foregroundFilter";
import { PanelDetector, PANEL_VARIANT, type PanelVariant } from "./panelDetector";
import { PanelEvidence, type PanelFace } from "./panelEvidence";
import { ActiveSpeakerResolver } from "./mainActiveSpeaker";
import { CLEAR_LEAD_FACTOR, leadFactor, scoreContext, subjectScore, SubjectSelector } from "./subjectSelector";

/**
 * Which rules handle 3+ foreground faces:
 * - "tracker": main subject, group, panel grid (tracking/subjectSelector.ts,
 *   panelDetector.ts), with the debounce keyed on the layout kind.
 * - "main": main's active-speaker resolution (mainActiveSpeaker.ts) on the
 *   foreground faces, debounced on the pane count as on main.
 * "main" is the default: on news-interview-2p "tracker" made 13-15 layout
 * changes against main's 11 (see docs/benchmark.md).
 */
export type ManyFacesRules = "tracker" | "main";
export const MANY_FACES_RULES: ManyFacesRules = "main";

/**
 * What the layout shows: nobody ("broll"), one or two people ("single",
 * "stacked"), and for 3+ foreground faces the main subject, the whole group
 * in one crop, or a grid for a real panel.
 */
export type LayoutRule = "broll" | "single" | "stacked" | "subject" | "group" | "grid";

export const LAYOUT_RULES: readonly LayoutRule[] = ["broll", "single", "stacked", "subject", "group", "grid"];

// From this many foreground faces up, the main-subject rules apply.
export const SUBJECT_RULE_MIN_FACES = 3;
// From this many faces up, a layout has several panes (stacked or grid) and needs panel evidence.
export const MULTIPANE_MIN_FACES = 2;
// After the foreground count drops below SUBJECT_RULE_MIN_FACES, the
// subject is kept this long, so one missed face does not reframe.
const SUBJECT_GRACE_BELOW_MIN_SEC = 0.4;
// When the framing moves to a person at least this far away (fraction of
// frame), it changes with a cross-dissolve instead of panning across the
// room: about half the width of a 9:16 crop of a 16:9 frame.
export const SWITCH_DISSOLVE_DISTANCE = 0.15;
// Stands for "the whole group" where a single-pane framing records whom it shows.
const GROUP_FRAMING_ID = -1;
// Fallback without a clear leader and a group too wide for 9:16: the
// largest face near the centre (area weighted down to this share at the edge).
const EDGE_WEIGHT = 0.5;
// A group already shown stays framed until it is this much wider than the
// crop, so a group near the limit does not flip between group and subject.
const GROUP_KEEP_TOLERANCE = 1.1;

// Layout keys for the debounce: the pane count, plus this offset for the
// single pane chosen among 3+ faces (main subject or group), so that a
// short 3+ face reading never agrees with a plain one-face reading.
const MANY_FACES_KEY_OFFSET = 100;

/** The value the person-count debounce compares: what kind of layout `rule` is, and its pane count. */
export function layoutKey(rule: LayoutRule, paneCount: number): number {
  return rule === "subject" || rule === "group" ? MANY_FACES_KEY_OFFSET + paneCount : paneCount;
}

/** The pane count of a layout key. */
export function paneCountOf(key: number): number {
  return key % MANY_FACES_KEY_OFFSET;
}

export interface TrackSnapshot {
  id: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  foreground: boolean;
  confirmed: boolean;
  /** Smoothed mouth activity, and the lower-face change alone (the old measure). */
  mouthActivity: number;
  lowerFaceMotion: number;
}

export interface LayoutPlan {
  rule: LayoutRule;
  /** What the person-count debounce compares (see layoutKey). */
  debounceKey: number;
  /** Faces for the panes, in pane order. */
  faces: FaceBox[];
  /** Track behind each pane (none for group framing). */
  paneTrackIds: number[];
  /** The followed person for "subject" (and the fallback face), else null. */
  subjectTrackId: number | null;
  /** The framing moved to someone far away within the same shot: dissolve instead of panning. */
  switchedFar: boolean;
  tracks: TrackSnapshot[];
  foregroundCount: number;
  /** The largest visible foreground face: max of its width and height, fraction of the frame (0 without one). */
  largestForegroundSize: number;
  /** Confirmed foreground tracks present: visible, or coasting through a missed detection. */
  confirmedPresentCount: number;
  backgroundCount: number;
  /** Pane order changed while the set of pane tracks stayed the same (should stay 0). */
  paneSwap: boolean;
  /** Left-to-right order of the pane tracks changed: a swap the old x-sorted layout would have made. */
  leftToRightFlip: boolean;
  /** 2+ faces that main would show in several panes, but no panel evidence: the decision shows the whole frame instead. */
  panelWholeFrame: boolean;
}

export interface FrameGeometry {
  srcW: number;
  srcH: number;
  outW: number;
  outH: number;
}

function faceOf(track: FaceTrack): FaceBox {
  return { ...track.lastDetection, cx: track.box.cx, cy: track.box.cy, w: track.box.w, h: track.box.h };
}

function sameMembers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}

/**
 * Turns one detection into a layout plan: tracks faces, keeps only the
 * foreground ones, and for 3+ applies, in order: hold or switch the main
 * subject; pick a clear leader; a panel -> grid; the group if it fits in
 * 9:16; else the largest face near the centre.
 */
export class LayoutPlanner {
  readonly tracker = new FaceTracker();
  private readonly subjects = new SubjectSelector();
  private panels: PanelDetector;
  private paneOrder: number[] = [];
  private fallbackId: number | null = null;
  private belowMinSinceSec: number | null = null;
  private framedId: number | null = null;
  private framedPosition: { cx: number; cy: number } | null = null;
  private pickNow = true;
  private readonly mainResolver = new ActiveSpeakerResolver();
  private readonly gridEvidence = new PanelEvidence();
  private groupShown = false;
  private leftToRightOrder: number[] = [];

  constructor(
    variant: PanelVariant = PANEL_VARIANT,
    private readonly manyFacesRules: ManyFacesRules = MANY_FACES_RULES
  ) {
    this.panels = new PanelDetector(variant);
  }

  setPanelVariant(variant: PanelVariant): void {
    this.panels = new PanelDetector(variant);
  }

  /** `cut`: this detection is the first after a hard cut (everything learned before is stale). */
  plan(
    faces: readonly FaceBox[],
    audioEnergy: number | null,
    atSec: number,
    cut: boolean,
    frame: FrameGeometry
  ): LayoutPlan {
    if (cut) this.reset();
    const tracks = this.tracker.update(faces, atSec);
    updateForeground(tracks);
    const visibleForeground = tracks.filter((t) => t.visible && t.foreground);
    // A confirmed track missed by one detection still holds its place
    // among 3+ people, so a missed face does not reset the panel evidence
    // or reshape the group.
    const presentForeground = tracks.filter((t) => t.foreground && (t.visible || t.confirmed));
    // Only confirmed tracks start the 3+ rules: a face seen for one or two
    // detections (often a false detection next to a real face) must not
    // turn a two-person shot into a main-subject shot.
    const confirmedCount = presentForeground.filter((t) => t.confirmed).length;
    const foregroundCount = visibleForeground.length;

    let rule: LayoutRule;
    let paneTracks: FaceTrack[] = [];
    let groupFaces: FaceTrack[] = [];
    let subjectTrackId: number | null = null;

    let mainSwitchedFar = false;
    let panelWholeFrame = false;
    let seatFaces: FaceBox[] | null = null;
    let seatTrackIds: number[] | null = null;
    const keepSubject = this.manyFacesRules === "tracker" ? this.subjectDuringGrace(presentForeground, atSec) : null;
    if (this.manyFacesRules === "main") {
      // main's rules read the raw detection box and the lower-face change.
      // A confirmed track coasting through a missed detection still counts, as in the shot rule.
      const counted = presentForeground;
      const inputs = counted.map((t) => ({ ...t.lastDetection, motion: t.lastDetection.lowerFaceMotion }));
      const resolved = this.mainResolver.resolve(inputs, audioEnergy, atSec);
      mainSwitchedFar = this.mainResolver.switchedSpeaker;
      const resolvedTracks = resolved.map((face) => counted[inputs.indexOf(face)]);
      const panelFaces: PanelFace[] = presentForeground
        .filter((t) => t.confirmed)
        .map((t) => ({ id: t.id, cx: t.box.cx, cy: t.box.cy, w: t.box.w, h: t.box.h, visible: t.visible }));
      const panel = this.gridEvidence.observe(panelFaces, atSec, cut);
      // With evidence, the panes are the panel's seats: a missing face keeps its pane for
      // MULTIPANE_HOLD_SEC, and a face that is not seated (a false box, a passer-by) adds none.
      const fromSeats =
        panel.evidence &&
        panel.seats.length >= MULTIPANE_MIN_FACES &&
        (resolved.length >= MULTIPANE_MIN_FACES || panel.seats.some((seat) => seat.held));
      panelWholeFrame = resolved.length >= MULTIPANE_MIN_FACES && !fromSeats;
      if (fromSeats) {
        seatTrackIds = panel.seats.map((seat) => seat.trackId);
        paneTracks = panel.seats.flatMap((seat) => tracks.filter((t) => t.id === seat.trackId));
        seatFaces = panel.seats.map((seat) => {
          const track = tracks.find((t) => t.id === seat.trackId);
          return track
            ? faceOf(track)
            : { cx: seat.cx, cy: seat.cy, w: seat.w, h: seat.h, motion: 0, lowerFaceMotion: 0, confidence: 0 };
        });
        rule = panel.seats.length === 2 ? "stacked" : "grid";
      } else {
        paneTracks = this.ordered(resolvedTracks);
        rule =
          resolved.length === 0
            ? "broll"
            : resolved.length === 1
              ? counted.length >= SUBJECT_RULE_MIN_FACES
                ? "subject"
                : "single"
              : resolved.length === 2
                ? "stacked"
                : "grid";
        if (rule === "subject") subjectTrackId = paneTracks[0].id;
      }
    } else if (keepSubject !== null) {
      rule = "subject";
      paneTracks = [keepSubject];
      subjectTrackId = keepSubject.id;
    } else if (confirmedCount < SUBJECT_RULE_MIN_FACES) {
      this.subjects.reset();
      this.fallbackId = null;
      this.groupShown = false;
      const shown =
        foregroundCount < SUBJECT_RULE_MIN_FACES ? visibleForeground : visibleForeground.filter((t) => t.confirmed);
      paneTracks = this.ordered(shown);
      rule = shown.length === 0 ? "broll" : shown.length === 1 ? "single" : "stacked";
    } else {
      this.belowMinSinceSec = null;
      const context = scoreContext(presentForeground, audioEnergy, atSec);
      const scored = presentForeground.map((track) => ({ track, score: subjectScore(track, context) }));
      const subjectId = this.subjects.select(scored, atSec, this.pickNow, leadFactor(context.audioConfirmed));
      const isPanel = this.panels.observe(presentForeground, atSec);
      const groupFits = groupFitsInFrame(
        presentForeground.map(faceOf),
        frame.srcW,
        frame.srcH,
        frame.outW,
        frame.outH,
        this.groupShown ? GROUP_KEEP_TOLERANCE : 1
      );
      this.groupShown = false;
      if (subjectId !== null) {
        rule = "subject";
        paneTracks = presentForeground.filter((t) => t.id === subjectId);
        subjectTrackId = subjectId;
        this.fallbackId = null;
      } else if (isPanel) {
        rule = "grid";
        paneTracks = this.ordered(presentForeground);
        this.fallbackId = null;
      } else if (groupFits) {
        rule = "group";
        groupFaces = presentForeground;
        this.groupShown = true;
        this.fallbackId = null;
      } else {
        rule = "subject";
        const fallback = this.largestNearCentre(presentForeground);
        paneTracks = [fallback];
        subjectTrackId = fallback.id;
      }
    }
    if (foregroundCount > 0) this.pickNow = false;

    const previousOrder = this.paneOrder;
    const paneTrackIds = seatTrackIds ?? paneTracks.map((t) => t.id);
    const paneSwap =
      paneTrackIds.length > 1 && sameMembers(paneTrackIds, previousOrder) && !sameOrder(paneTrackIds, previousOrder);
    const leftToRightFlip =
      paneTrackIds.length > 1 &&
      sameMembers(paneTrackIds, previousOrder) &&
      !sameOrder(this.leftToRight(paneTracks), this.leftToRightOrder);
    this.paneOrder = paneTrackIds;
    this.leftToRightOrder = this.leftToRight(paneTracks);

    const planFaces =
      seatFaces ??
      (rule === "group"
        ? [groupFrameFace(groupFaces.map(faceOf), frame.srcW, frame.srcH, frame.outW, frame.outH)]
        : paneTracks.map(faceOf));
    const switchedFar =
      this.manyFacesRules === "main" ? mainSwitchedFar : this.noteFraming(rule, paneTrackIds, planFaces);

    return {
      rule,
      debounceKey: this.manyFacesRules === "main" ? planFaces.length : layoutKey(rule, planFaces.length),
      faces: planFaces,
      paneTrackIds,
      subjectTrackId,
      switchedFar,
      tracks: tracks.map((t) => ({
        id: t.id,
        cx: t.box.cx,
        cy: t.box.cy,
        w: t.box.w,
        h: t.box.h,
        foreground: t.foreground,
        confirmed: t.confirmed,
        mouthActivity: t.mouthActivity,
        lowerFaceMotion: t.lowerFaceMotion,
      })),
      foregroundCount,
      largestForegroundSize: visibleForeground.reduce((largest, t) => Math.max(largest, t.box.w, t.box.h), 0),
      confirmedPresentCount: presentForeground.filter((t) => t.confirmed).length,
      backgroundCount: tracks.filter((t) => t.visible && !t.foreground).length,
      paneSwap,
      leftToRightFlip,
      panelWholeFrame,
    };
  }

  /** Forgets every track and choice (a cut, a seek, a new source); the next detection picks again at once. */
  reset(): void {
    this.tracker.reset();
    this.subjects.reset();
    this.mainResolver.reset();
    this.gridEvidence.reset();
    this.panels.reset();
    this.paneOrder = [];
    this.leftToRightOrder = [];
    this.fallbackId = null;
    this.belowMinSinceSec = null;
    this.framedId = null;
    this.framedPosition = null;
    this.pickNow = true;
    this.groupShown = false;
  }

  private leftToRight(tracks: readonly FaceTrack[]): number[] {
    return [...tracks].sort((a, b) => a.box.cx - b.box.cx).map((t) => t.id);
  }

  /**
   * Pane order: kept from the previous detection while it has the same
   * tracks; a new set of tracks is ordered left to right once, when the
   * layout starts.
   */
  private ordered(tracks: readonly FaceTrack[]): FaceTrack[] {
    const ids = tracks.map((t) => t.id);
    if (sameMembers(ids, this.paneOrder)) {
      return this.paneOrder.map((id) => tracks.find((t) => t.id === id)!);
    }
    return [...tracks].sort((a, b) => a.box.cx - b.box.cx);
  }

  /** The held subject while the foreground count is briefly below 3, or null. */
  private subjectDuringGrace(present: readonly FaceTrack[], atSec: number): FaceTrack | null {
    const subjectId = this.subjects.subjectTrackId;
    if (present.length >= SUBJECT_RULE_MIN_FACES || subjectId === null) return null;
    const subject = present.find((t) => t.id === subjectId);
    if (subject === undefined) return null;
    if (this.belowMinSinceSec === null || atSec < this.belowMinSinceSec) this.belowMinSinceSec = atSec;
    if (atSec - this.belowMinSinceSec >= SUBJECT_GRACE_BELOW_MIN_SEC - 1e-3) return null;
    return subject;
  }

  /** Largest face weighted towards the centre; the previous choice is kept unless another beats it clearly. */
  private largestNearCentre(tracks: readonly FaceTrack[]): FaceTrack {
    const weight = (t: FaceTrack) => trackArea(t) * (1 - EDGE_WEIGHT * Math.min(1, Math.abs(t.box.cx - 0.5) / 0.5));
    const best = tracks.reduce((a, b) => (weight(b) > weight(a) ? b : a));
    const previous = tracks.find((t) => t.id === this.fallbackId);
    const chosen = previous && weight(best) < weight(previous) * CLEAR_LEAD_FACTOR ? previous : best;
    this.fallbackId = chosen.id;
    return chosen;
  }

  /** Records who a single-pane framing shows; true when it moved to someone else at least SWITCH_DISSOLVE_DISTANCE away. */
  private noteFraming(rule: LayoutRule, paneTrackIds: readonly number[], faces: readonly FaceBox[]): boolean {
    if (faces.length !== 1) {
      this.framedId = null;
      this.framedPosition = null;
      return false;
    }
    const id = rule === "group" ? GROUP_FRAMING_ID : paneTrackIds[0];
    const position = { cx: faces[0].cx, cy: faces[0].cy };
    const previous = this.framedPosition;
    const changed = this.framedId !== null && this.framedId !== id;
    this.framedId = id;
    this.framedPosition = position;
    return (
      changed &&
      previous !== null &&
      Math.hypot(previous.cx - position.cx, previous.cy - position.cy) >= SWITCH_DISSOLVE_DISTANCE
    );
  }
}
