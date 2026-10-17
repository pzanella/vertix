import { describe, expect, it } from "vitest";
import { ruleTimeAndSwitches, TrackingRecorder, type RuleEvent } from "./trackingStats";

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
