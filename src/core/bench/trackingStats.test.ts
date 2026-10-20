import { describe, expect, it } from "vitest";
import {
  gridTimeOnWideShots,
  ruleTimeAndSwitches,
  shotTimeAndChanges,
  TrackingRecorder,
  type RuleEvent,
  type ShotEvent,
} from "./trackingStats";

const event = (nowMs: number, rule: RuleEvent["rule"], subject = -1, cut = false): RuleEvent => ({
  nowMs,
  rule,
  subject,
  cut,
});

describe("ruleTimeAndSwitches", () => {
  it("splits the measured window between rules, including the rule in force when it starts", () => {
    const { timeInRulePct } = ruleTimeAndSwitches(
      [event(0, "broll"), event(1000, "grid"), event(3000, "subject", 4)],
      2000,
      6000
    );
    expect(timeInRulePct.grid).toBe(25);
    expect(timeInRulePct.subject).toBe(75);
    expect(timeInRulePct.broll).toBe(0);
  });

  it("counts a change of the followed track as a subject switch, but not across a cut", () => {
    const events = [
      event(0, "subject", 1),
      event(1000, "group"),
      event(2000, "subject", 2),
      event(3000, "subject", 5, true),
      event(4000, "subject", 2),
    ];
    expect(ruleTimeAndSwitches(events, 0, 5000).subjectSwitches).toBe(2);
  });
});

describe("TrackingRecorder", () => {
  it("summarises measured detections only, and stores rule changes only", () => {
    const recorder = new TrackingRecorder(10);
    recorder.recordDetection(5, 9, 9, true, true, true);
    recorder.recordDetection(0.02, 2, 3, false, true, false);
    recorder.recordDetection(0.04, 2, 5, false, false, false);
    recorder.recordRule(0, "stacked", -1, false);
    recorder.recordRule(500, "stacked", -1, false);
    recorder.recordRule(30000, "single", 3, false);
    const summary = recorder.summarize(0, 60000, 2);
    expect(summary.trackerMs.max).toBe(0.04);
    expect(summary.backgroundTracks.mean).toBe(4);
    expect(summary.paneSwaps).toBe(0);
    expect(summary.leftToRightFlips).toBe(1);
    expect(summary.layoutChangesPerMin).toBe(2);
    expect(summary.timeInRulePct.stacked).toBe(50);
  });
});

describe("shotTimeAndChanges", () => {
  const shot = (nowMs: number, type: ShotEvent["shot"]): ShotEvent => ({ nowMs, shot: type });

  it("splits the measured window between shot types and counts changes inside it", () => {
    const events = [shot(0, "close"), shot(4000, "wide"), shot(8000, "close")];
    const { timeInShotPct, changes } = shotTimeAndChanges(events, 2000, 10000);
    expect(timeInShotPct.close).toBeCloseTo(50);
    expect(timeInShotPct.wide).toBeCloseTo(50);
    expect(timeInShotPct.none).toBe(0);
    expect(changes).toBe(2);
  });

  it("returns zero shares without a measured window", () => {
    expect(shotTimeAndChanges([shot(0, "wide")], null, null).timeInShotPct.wide).toBe(0);
  });
});

describe("gridTimeOnWideShots", () => {
  it("counts grid time only where the shot is not close", () => {
    const rules: RuleEvent[] = [event(0, "broll"), event(1000, "grid"), event(5000, "broll")];
    const shots: ShotEvent[] = [
      { nowMs: 0, shot: "close" },
      { nowMs: 3000, shot: "wide" },
    ];
    expect(gridTimeOnWideShots(rules, shots, 0, 6000)).toBe(2000);
  });

  it("is zero when the whole frame is shown on wide shots", () => {
    const rules: RuleEvent[] = [event(0, "broll")];
    const shots: ShotEvent[] = [{ nowMs: 0, shot: "wide" }];
    expect(gridTimeOnWideShots(rules, shots, 0, 6000)).toBe(0);
  });
});
