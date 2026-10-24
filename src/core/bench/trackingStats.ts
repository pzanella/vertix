import { LAYOUT_RULES, type LayoutRule } from "../tracking/layoutPlanner";
import { SHOT_TYPES, type ShotType } from "../tracking/shotType";
import { summarize, type SampleSummary } from "./stats";

/** Face tracks and layout rules of one run (schema v6). */
export interface TrackingSummary {
  /** Layout changes (pane count changes, as `layoutChanges`) per minute of measured playback. */
  layoutChangesPerMin: number | null;
  /** Changes of the followed person to another track within a shot (cuts excluded). */
  subjectSwitches: number;
  subjectSwitchesPerMin: number | null;
  /** Share of measured playback per rule, in percent (0 for rules never shown). */
  timeInRulePct: Record<LayoutRule, number>;
  /** Foreground / background tracks matched per detection. */
  foregroundTracks: SampleSummary;
  backgroundTracks: SampleSummary;
  /** Panes whose track changed order while the same tracks stayed on screen (ID switches; should be 0). */
  paneSwaps: number;
  /** Times the left-to-right order of the pane tracks changed: the panel swaps the old x-sorted layout would have made. */
  leftToRightFlips: number;
  /** Tracker + layout rules, per detection (main thread). */
  trackerMs: SampleSummary;
  /** Schema v8: share of measured playback per shot type, in percent. */
  timeInShotPct: Record<ShotType, number>;
  /** Schema v8: shot type changes per minute of measured playback. */
  shotChangesPerMin: number | null;
  /** Schema v8: seconds where the displayed layout was a grid during a wide or none shot (0 when the whole frame is shown). */
  gridSecOnWideShots: number;
  /** Schema v8: time to draw one whole-frame (no crop) frame, in ms. */
  fullSceneDrawMs: SampleSummary;
  /** Schema v8: distance the drawn crop centres moved per layout (all panes summed), in frame widths; layout changes and snaps not included. */
  cropPathFrameWidths: Record<LayoutRule, number>;
  /** Schema v8: cropPathFrameWidths per minute of measured playback in that layout (null when never shown). */
  cropPathPerMin: Record<LayoutRule, number | null>;
}

/** Schema v8 raw: every displayed layout rule change, with the media time of the frame it appeared on. */
export interface LayoutRuleEvents {
  nowMs: number[];
  mediaTimeSec: number[];
  rule: LayoutRule[];
}

const RULE_EVENT_CAPACITY = 8192;
const SHOT_EVENT_CAPACITY = 8192;
const FULL_SCENE_DRAW_CAPACITY = 131072;
const CROP_MOVE_CAPACITY = 262144;
const NO_SUBJECT = -1;

/**
 * Collects the tracker's per-detection numbers and the displayed rule
 * changes into buffers allocated once, like BenchmarkRecorder.
 */
export class TrackingRecorder {
  private readonly trackerMs: Float64Array;
  private readonly foreground: Float64Array;
  private readonly background: Float64Array;
  private readonly paneSwap: Uint8Array;
  private readonly leftToRightFlip: Uint8Array;
  private readonly detectionWarmup: Uint8Array;
  private detectionCount = 0;

  private readonly ruleNow = new Float64Array(RULE_EVENT_CAPACITY);
  private readonly ruleIndex = new Uint8Array(RULE_EVENT_CAPACITY);
  private readonly ruleSubject = new Float64Array(RULE_EVENT_CAPACITY);
  private readonly ruleCut = new Uint8Array(RULE_EVENT_CAPACITY);
  private readonly ruleMediaTime = new Float64Array(RULE_EVENT_CAPACITY);
  private readonly cropNow = new Float64Array(CROP_MOVE_CAPACITY);
  private readonly cropRule = new Uint8Array(CROP_MOVE_CAPACITY);
  private readonly cropDistance = new Float64Array(CROP_MOVE_CAPACITY);
  private cropCount = 0;
  private ruleCount = 0;
  private lastRule = -1;
  private lastSubject = NO_SUBJECT;
  private readonly shotNow = new Float64Array(SHOT_EVENT_CAPACITY);
  private readonly shotIndex = new Uint8Array(SHOT_EVENT_CAPACITY);
  private shotCount = 0;
  private lastShot = -1;
  private readonly fullSceneDraw = new Float64Array(FULL_SCENE_DRAW_CAPACITY);
  private fullSceneDrawCount = 0;
  overflow = 0;

  constructor(detectionCapacity: number) {
    this.trackerMs = new Float64Array(detectionCapacity);
    this.foreground = new Float64Array(detectionCapacity);
    this.background = new Float64Array(detectionCapacity);
    this.paneSwap = new Uint8Array(detectionCapacity);
    this.leftToRightFlip = new Uint8Array(detectionCapacity);
    this.detectionWarmup = new Uint8Array(detectionCapacity);
  }

  recordDetection(
    trackerMs: number,
    foreground: number,
    background: number,
    paneSwap: boolean,
    leftToRightFlip: boolean,
    warmup: boolean
  ): void {
    const i = this.detectionCount;
    if (i >= this.trackerMs.length) {
      this.overflow += 1;
      return;
    }
    this.trackerMs[i] = trackerMs;
    this.foreground[i] = foreground;
    this.background[i] = background;
    this.paneSwap[i] = paneSwap ? 1 : 0;
    this.leftToRightFlip[i] = leftToRightFlip ? 1 : 0;
    this.detectionWarmup[i] = warmup ? 1 : 0;
    this.detectionCount = i + 1;
  }

  /** The rule and followed track (-1 for none) applied on a displayed frame; only changes are stored. */
  recordRule(nowMs: number, rule: LayoutRule, subjectTrackId: number, isCut: boolean, mediaTimeSec = NaN): void {
    const index = LAYOUT_RULES.indexOf(rule);
    if (index === this.lastRule && subjectTrackId === this.lastSubject && !isCut) return;
    const i = this.ruleCount;
    if (i >= RULE_EVENT_CAPACITY) {
      this.overflow += 1;
      return;
    }
    this.ruleNow[i] = nowMs;
    this.ruleIndex[i] = index;
    this.ruleSubject[i] = subjectTrackId;
    this.ruleCut[i] = isCut ? 1 : 0;
    this.ruleMediaTime[i] = mediaTimeSec;
    this.ruleCount = i + 1;
    this.lastRule = index;
    this.lastSubject = subjectTrackId;
  }

  /** The shot type on a displayed frame; only changes are stored. */
  recordShot(nowMs: number, shot: ShotType): void {
    const index = SHOT_TYPES.indexOf(shot);
    if (index === this.lastShot) return;
    const i = this.shotCount;
    if (i >= SHOT_EVENT_CAPACITY) {
      this.overflow += 1;
      return;
    }
    this.shotNow[i] = nowMs;
    this.shotIndex[i] = index;
    this.shotCount = i + 1;
    this.lastShot = index;
  }

  /** How far the drawn crop centres moved on one frame, in frame widths, under the rule last recorded. */
  recordCropMove(nowMs: number, frameWidths: number): void {
    if (this.lastRule < 0) return;
    const i = this.cropCount;
    if (i >= CROP_MOVE_CAPACITY) {
      this.overflow += 1;
      return;
    }
    this.cropNow[i] = nowMs;
    this.cropRule[i] = this.lastRule;
    this.cropDistance[i] = frameWidths;
    this.cropCount = i + 1;
  }

  /** Every displayed rule change, for raw output. */
  ruleEvents(): LayoutRuleEvents {
    const n = this.ruleCount;
    return {
      nowMs: Array.from(this.ruleNow.subarray(0, n)),
      mediaTimeSec: Array.from(this.ruleMediaTime.subarray(0, n)),
      rule: Array.from(this.ruleIndex.subarray(0, n), (index) => LAYOUT_RULES[index]),
    };
  }

  /** Time to draw one whole-frame (no crop) frame. */
  recordFullSceneDraw(ms: number): void {
    if (this.fullSceneDrawCount >= this.fullSceneDraw.length) {
      this.overflow += 1;
      return;
    }
    this.fullSceneDraw[this.fullSceneDrawCount++] = ms;
  }

  /** Summary over measured playback, wall time [`fromMs`, `toMs`], with `layoutChanges` counted by the caller. */
  summarize(fromMs: number | null, toMs: number | null, layoutChanges: number): TrackingSummary {
    const measured: number[] = [];
    for (let i = 0; i < this.detectionCount; i++) if (this.detectionWarmup[i] === 0) measured.push(i);
    const column = (values: Float64Array) => measured.map((i) => values[i]);
    let paneSwaps = 0;
    let leftToRightFlips = 0;
    for (const i of measured) {
      paneSwaps += this.paneSwap[i];
      leftToRightFlips += this.leftToRightFlip[i];
    }

    const events = Array.from({ length: this.ruleCount }, (_, i) => ({
      nowMs: this.ruleNow[i],
      rule: LAYOUT_RULES[this.ruleIndex[i]],
      subject: this.ruleSubject[i],
      cut: this.ruleCut[i] === 1,
    }));
    const rules = ruleTimeAndSwitches(events, fromMs, toMs);
    const shotEvents = Array.from({ length: this.shotCount }, (_, i) => ({
      nowMs: this.shotNow[i],
      shot: SHOT_TYPES[this.shotIndex[i]],
    }));
    const shots = shotTimeAndChanges(shotEvents, fromMs, toMs);
    const minutes = fromMs !== null && toMs !== null && toMs > fromMs ? (toMs - fromMs) / 60000 : null;

    return {
      layoutChangesPerMin: minutes ? layoutChanges / minutes : null,
      subjectSwitches: rules.subjectSwitches,
      subjectSwitchesPerMin: minutes ? rules.subjectSwitches / minutes : null,
      timeInRulePct: rules.timeInRulePct,
      foregroundTracks: summarize(column(this.foreground)),
      backgroundTracks: summarize(column(this.background)),
      paneSwaps,
      leftToRightFlips,
      trackerMs: summarize(column(this.trackerMs)),
      timeInShotPct: shots.timeInShotPct,
      shotChangesPerMin: minutes ? shots.changes / minutes : null,
      gridSecOnWideShots: gridTimeOnWideShots(events, shotEvents, fromMs, toMs) / 1000,
      fullSceneDrawMs: summarize(this.fullSceneDraw.subarray(0, this.fullSceneDrawCount)),
      ...this.cropPath(fromMs, toMs, rules.timeInRulePct),
    };
  }

  private cropPath(
    fromMs: number | null,
    toMs: number | null,
    timeInRulePct: Record<LayoutRule, number>
  ): Pick<TrackingSummary, "cropPathFrameWidths" | "cropPathPerMin"> {
    const path = Object.fromEntries(LAYOUT_RULES.map((rule) => [rule, 0])) as Record<LayoutRule, number>;
    const perMin = Object.fromEntries(LAYOUT_RULES.map((rule) => [rule, null])) as Record<LayoutRule, number | null>;
    if (fromMs === null || toMs === null || toMs <= fromMs)
      return { cropPathFrameWidths: path, cropPathPerMin: perMin };
    for (let i = 0; i < this.cropCount; i++) {
      if (this.cropNow[i] >= fromMs && this.cropNow[i] <= toMs)
        path[LAYOUT_RULES[this.cropRule[i]]] += this.cropDistance[i];
    }
    for (const rule of LAYOUT_RULES) {
      const minutes = ((timeInRulePct[rule] / 100) * (toMs - fromMs)) / 60000;
      perMin[rule] = minutes > 0 ? path[rule] / minutes : null;
    }
    return { cropPathFrameWidths: path, cropPathPerMin: perMin };
  }
}

export interface ShotEvent {
  nowMs: number;
  shot: ShotType;
}

/** Time per shot type within [fromMs, toMs] (in percent) and the shot changes inside the window. */
export function shotTimeAndChanges(
  events: readonly ShotEvent[],
  fromMs: number | null,
  toMs: number | null
): { timeInShotPct: Record<ShotType, number>; changes: number } {
  const timeMs = Object.fromEntries(SHOT_TYPES.map((shot) => [shot, 0])) as Record<ShotType, number>;
  let changes = 0;
  if (fromMs === null || toMs === null || toMs <= fromMs) return { timeInShotPct: timeMs, changes };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.nowMs > fromMs && event.nowMs <= toMs && i > 0) changes += 1;
    const start = Math.max(event.nowMs, fromMs);
    const end = Math.min(i + 1 < events.length ? events[i + 1].nowMs : toMs, toMs);
    if (end > start) timeMs[event.shot] += end - start;
  }
  const total = toMs - fromMs;
  for (const shot of SHOT_TYPES) timeMs[shot] = (timeMs[shot] / total) * 100;
  return { timeInShotPct: timeMs, changes };
}

/**
 * Milliseconds in [fromMs, toMs] where the displayed rule is "grid" and
 * the shot is not close. Both event lists are in time order.
 */
export function gridTimeOnWideShots(
  rules: readonly RuleEvent[],
  shots: readonly ShotEvent[],
  fromMs: number | null,
  toMs: number | null
): number {
  if (fromMs === null || toMs === null || toMs <= fromMs) return 0;
  const edges = [fromMs, toMs, ...rules.map((r) => r.nowMs), ...shots.map((s) => s.nowMs)]
    .filter((t) => t >= fromMs && t <= toMs)
    .sort((a, b) => a - b);
  let gridMs = 0;
  for (let i = 0; i + 1 < edges.length; i++) {
    const at = edges[i];
    const rule = lastAtOrBefore(rules, at)?.rule;
    const shot = lastAtOrBefore(shots, at)?.shot ?? "close";
    if (rule === "grid" && shot !== "close") gridMs += edges[i + 1] - at;
  }
  return gridMs;
}

function lastAtOrBefore<T extends { nowMs: number }>(events: readonly T[], atMs: number): T | undefined {
  let found: T | undefined;
  for (const event of events) {
    if (event.nowMs > atMs) break;
    found = event;
  }
  return found;
}

export interface RuleEvent {
  nowMs: number;
  rule: LayoutRule;
  /** Followed track id, -1 for none. */
  subject: number;
  cut: boolean;
}

/**
 * Time per rule within [fromMs, toMs] (the rule in force at fromMs is the
 * last event before it), and subject switches inside the window: the
 * followed track changing to another one without a cut in between.
 */
export function ruleTimeAndSwitches(
  events: readonly RuleEvent[],
  fromMs: number | null,
  toMs: number | null
): { timeInRulePct: Record<LayoutRule, number>; subjectSwitches: number } {
  const timeMs = Object.fromEntries(LAYOUT_RULES.map((rule) => [rule, 0])) as Record<LayoutRule, number>;
  let subjectSwitches = 0;
  if (fromMs === null || toMs === null || toMs <= fromMs) return { timeInRulePct: timeMs, subjectSwitches };

  let followed = NO_SUBJECT;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.cut) followed = NO_SUBJECT;
    if (event.subject !== NO_SUBJECT) {
      if (followed !== NO_SUBJECT && event.subject !== followed && event.nowMs >= fromMs && event.nowMs <= toMs) {
        subjectSwitches += 1;
      }
      followed = event.subject;
    }
    const start = Math.max(event.nowMs, fromMs);
    const end = Math.min(i + 1 < events.length ? events[i + 1].nowMs : toMs, toMs);
    if (end > start) timeMs[event.rule] += end - start;
  }
  const total = toMs - fromMs;
  for (const rule of LAYOUT_RULES) timeMs[rule] = (timeMs[rule] / total) * 100;
  return { timeInRulePct: timeMs, subjectSwitches };
}
