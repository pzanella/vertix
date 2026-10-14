import { describe, expect, it } from "vitest";
import { DecisionTimeline, mergeDecisions, type LayoutDecision } from "./decisionTimeline";

function decision(mediaTimeSec: number, overrides: Partial<LayoutDecision> = {}): LayoutDecision {
  return {
    mediaTimeSec,
    speakerCount: 1,
    targetPanes: [],
    reframe: null,
    isCut: false,
    cutSource: null,
    skinRejectedFaces: [],
    ...overrides,
  };
}

describe("DecisionTimeline", () => {
  it("releases a decision on the first displayed frame at or after its media time", () => {
    const timeline = new DecisionTimeline();
    timeline.push(decision(4.0, { isCut: true }));
    expect(timeline.takeDue(3.96)).toEqual([]);
    expect(timeline.takeDue(4.0)).toEqual([expect.objectContaining({ mediaTimeSec: 4.0, isCut: true })]);
    expect(timeline.size).toBe(0);
  });

  it("tolerates rounding in media times", () => {
    const timeline = new DecisionTimeline();
    timeline.push(decision(0.2 * 5));
    expect(timeline.takeDue(1.0 - 1e-9)).toHaveLength(1);
  });

  it("keeps media-time order when a cut decision is moved back to an earlier frame", () => {
    const timeline = new DecisionTimeline();
    timeline.push(decision(3.8));
    timeline.push(decision(4.2));
    timeline.push(decision(4.0, { isCut: true }));
    expect(timeline.takeDue(4.0).map((d) => d.mediaTimeSec)).toEqual([3.8, 4.0]);
    expect(timeline.takeDue(4.2).map((d) => d.mediaTimeSec)).toEqual([4.2]);
  });

  it("takeAll empties the timeline in order", () => {
    const timeline = new DecisionTimeline();
    timeline.push(decision(2));
    timeline.push(decision(1));
    expect(timeline.takeAll().map((d) => d.mediaTimeSec)).toEqual([1, 2]);
    expect(timeline.size).toBe(0);
  });
});

describe("mergeDecisions", () => {
  it("returns null for nothing", () => {
    expect(mergeDecisions([])).toBeNull();
  });

  it("keeps the latest layout and lets a snap win over a dissolve", () => {
    const merged = mergeDecisions([
      decision(1, { reframe: "snap", isCut: true, cutSource: "trigger", speakerCount: 2 }),
      decision(1.2, { reframe: "dissolve", speakerCount: 3 }),
    ]);
    expect(merged).toMatchObject({
      mediaTimeSec: 1.2,
      speakerCount: 3,
      reframe: "snap",
      isCut: true,
      cutSource: "trigger",
    });
  });

  it("keeps a dissolve when nothing snaps", () => {
    expect(mergeDecisions([decision(1, { reframe: "dissolve" }), decision(1.2)])?.reframe).toBe("dissolve");
  });
});
