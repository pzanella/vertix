import { describe, expect, it } from "vitest";
import { DEFAULT_SHOT_RULES, ShotTypeTracker, shotCandidate } from "./shotType";

const CLOSE = { largestFaceSize: 0.4, foregroundCount: 1 };
const SMALL = { largestFaceSize: 0.1, foregroundCount: 1 };
const NO_FACE = { largestFaceSize: 0, foregroundCount: 0 };
const BETWEEN = { largestFaceSize: 0.2, foregroundCount: 1 };

/** One detection every 0.2 s, starting at `fromSec`. */
function feed(
  tracker: ShotTypeTracker,
  observation: { largestFaceSize: number; foregroundCount: number },
  fromSec: number,
  count: number
) {
  let last = tracker.current;
  for (let i = 0; i < count; i++) last = tracker.observe(observation, fromSec + i * 0.2, false);
  return last;
}

describe("shotCandidate", () => {
  it("is close from the close threshold up, wide below the wide threshold, none without faces", () => {
    expect(shotCandidate(CLOSE)).toBe("close");
    expect(shotCandidate({ largestFaceSize: DEFAULT_SHOT_RULES.closeMinHmax, foregroundCount: 1 })).toBe("close");
    expect(shotCandidate(SMALL)).toBe("wide");
    expect(shotCandidate(NO_FACE)).toBe("none");
  });

  it("has no vote in the zone between the thresholds", () => {
    expect(shotCandidate(BETWEEN)).toBeNull();
    expect(shotCandidate({ largestFaceSize: DEFAULT_SHOT_RULES.wideMaxHmax, foregroundCount: 1 })).toBeNull();
  });

  it("does not call three similar faces of speaker size wide (3-speakers stays close)", () => {
    const threeSpeakers = { largestFaceSize: 0.17, foregroundCount: 3 };
    expect(shotCandidate(threeSpeakers)).toBeNull();
    expect(new ShotTypeTracker().observe(threeSpeakers, 10, true)).toBe("close");
  });
});

describe("ShotTypeTracker", () => {
  it("starts a shot at once from its first detection after a cut", () => {
    const tracker = new ShotTypeTracker();
    expect(tracker.observe(SMALL, 10, true)).toBe("wide");
    expect(tracker.observe(NO_FACE, 10.2, true)).toBe("none");
  });

  it("keeps close for a first detection inside the zone between the thresholds", () => {
    const tracker = new ShotTypeTracker();
    expect(tracker.observe(BETWEEN, 10, true)).toBe("close");
  });

  it("changes inside a shot only after the other side has held for the shot hold", () => {
    const tracker = new ShotTypeTracker();
    tracker.observe(CLOSE, 10, true);
    feed(tracker, CLOSE, 10.2, 5);
    for (let i = 0; i < 4; i++) expect(tracker.observe(SMALL, 11.2 + i * 0.2, false)).toBe("close");
    expect(tracker.observe(SMALL, 12.2, false)).toBe("wide");
  });

  it("uses the short cut hold for the first second of a shot", () => {
    const tracker = new ShotTypeTracker();
    tracker.observe(CLOSE, 10, true);
    expect(tracker.observe(SMALL, 10.2, false)).toBe("close");
    expect(tracker.observe(SMALL, 10.4, false)).toBe("wide");
  });

  it("restarts the hold when the candidate is interrupted by the zone", () => {
    const tracker = new ShotTypeTracker();
    tracker.observe(CLOSE, 10, true);
    feed(tracker, CLOSE, 10.2, 5);
    feed(tracker, SMALL, 11.2, 4);
    expect(tracker.observe(BETWEEN, 12, false)).toBe("close");
    expect(tracker.observe(SMALL, 12.2, false)).toBe("close");
    expect(tracker.observe(SMALL, 13.2, false)).toBe("wide");
  });

  it("keeps the current class inside the zone (a slow zoom does not flip back and forth)", () => {
    const tracker = new ShotTypeTracker();
    tracker.observe(SMALL, 10, true);
    feed(tracker, CLOSE, 10.2, 8);
    expect(tracker.current).toBe("close");
    expect(tracker.observe(BETWEEN, 12, false)).toBe("close");
    expect(tracker.observe(BETWEEN, 12.2, false)).toBe("close");
  });

  it("switches from wide to close only when the close threshold holds", () => {
    const tracker = new ShotTypeTracker();
    tracker.observe(SMALL, 10, true);
    feed(tracker, BETWEEN, 10.2, 10);
    expect(tracker.current).toBe("wide");
    feed(tracker, CLOSE, 12.2, 8);
    expect(tracker.current).toBe("close");
  });

  it("commits the very next detection after a reset", () => {
    const tracker = new ShotTypeTracker();
    tracker.observe(CLOSE, 10, true);
    tracker.reset();
    expect(tracker.observe(SMALL, 20, false)).toBe("wide");
  });

  it("takes the hold from the rules it was built with", () => {
    const tracker = new ShotTypeTracker({ ...DEFAULT_SHOT_RULES, shotHoldSec: 0.4, cutHoldWindowSec: 0 });
    tracker.observe(CLOSE, 10, true);
    expect(tracker.observe(SMALL, 10.2, false)).toBe("close");
    expect(tracker.observe(SMALL, 10.6, false)).toBe("wide");
  });
});
