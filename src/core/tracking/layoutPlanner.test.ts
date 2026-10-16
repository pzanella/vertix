import { describe, expect, it } from "vitest";
import type { FaceBox } from "../layoutEngine";
import { LayoutPlanner, layoutKey, paneCountOf, type LayoutPlan } from "./layoutPlanner";
import { detectionTimes, testFace } from "./testFaces";

const FRAME = { srcW: 1280, srcH: 720, outW: 405, outH: 720 };

/** Plans every detection of `durationSec` seconds of `facesAt(t)`. */
function run(
  facesAt: (t: number) => FaceBox[],
  durationSec: number,
  { planner = new LayoutPlanner(undefined, "tracker"), audioEnergy = null as number | null } = {}
): { t: number; plan: LayoutPlan }[] {
  return [...detectionTimes(durationSec)].map((t) => ({
    t,
    plan: planner.plan(facesAt(t), audioEnergy, t, false, FRAME),
  }));
}

/** How many times `key` changed along the run. */
function changes<T>(values: T[]): number {
  return values.slice(1).filter((v, i) => v !== values[i]).length;
}

describe("LayoutPlanner synthetic sequences, tracker rules for 3+ faces", () => {
  it("two people crossing: the stacked panes keep their tracks (no ID swap)", () => {
    const plans = run((t) => [testFace(0.2 + 0.2 * t, 0.45, 0.15), testFace(0.8 - 0.2 * t, 0.55, 0.15)], 3);
    const stacked = plans.filter(({ plan }) => plan.rule === "stacked");
    expect(stacked.length).toBeGreaterThan(10);
    const firstOrder = stacked[0].plan.paneTrackIds.join();
    expect(stacked.every(({ plan }) => plan.paneTrackIds.join() === firstOrder)).toBe(true);
    expect(stacked.some(({ plan }) => plan.paneSwap)).toBe(false);
    expect(stacked.filter(({ plan }) => plan.leftToRightFlip)).toHaveLength(1);
  });

  it("a large face plus many small ones: stays single", () => {
    const crowd = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9].map((cx) => testFace(cx, 0.3, 0.13));
    const plans = run(() => [testFace(0.5, 0.5, 0.3), ...crowd], 4);
    expect(plans.every(({ plan }) => plan.rule === "single")).toBe(true);
    expect(plans.at(-1)!.plan.backgroundCount).toBe(6);
  });

  it("three similar static faces: grid once they have been still for 1.0s", () => {
    const plans = run(() => [testFace(0.2, 0.5, 0.2), testFace(0.5, 0.5, 0.2), testFace(0.8, 0.5, 0.2)], 4);
    const rules = plans.map(({ plan }) => plan.rule);
    expect(rules.slice(0, 5).every((rule) => rule !== "grid")).toBe(true);
    expect(rules.slice(5).every((rule) => rule === "grid")).toBe(true);
  });

  it("three faces where one moves its mouth: follows that one, no back-and-forth", () => {
    const talker = (t: number) => (Math.floor(t * 5) % 2 === 0 ? 8 : 4);
    const plans = run(
      (t) => [testFace(0.2, 0.5, 0.2, 0.5), testFace(0.5, 0.5, 0.2, 0.5), testFace(0.8, 0.5, 0.2, talker(t))],
      8,
      { audioEnergy: 0.1 }
    );
    const subjects = plans.map(({ plan }) => plan.subjectTrackId);
    const talkerId = plans[0].plan.tracks.find((track) => track.cx > 0.7)!.id;
    expect(subjects.at(-1)).toBe(talkerId);
    expect(changes(subjects.filter((id) => id !== null))).toBe(0);
  });

  it("three people close together, moving, without a leader: frames the group", () => {
    // Real face boxes are narrower than tall in frame fractions (a square face in a 16:9 frame: w = h * 9/16).
    const narrow = (cx: number) => ({ ...testFace(cx, 0.5, 0.13), w: 0.07 });
    const sway = (t: number) => 0.03 * Math.sin(t * 3);
    const plans = run((t) => [narrow(0.42 + sway(t)), narrow(0.5 + sway(t)), narrow(0.58 + sway(t))], 2);
    expect(plans.at(-1)!.plan.rule).toBe("group");
    expect(plans.at(-1)!.plan.faces).toHaveLength(1);
  });

  it("on a cut, drops every track and picks again at once", () => {
    const planner = new LayoutPlanner(undefined, "tracker");
    run(() => [testFace(0.2, 0.5, 0.2), testFace(0.5, 0.5, 0.2), testFace(0.8, 0.5, 0.2)], 3, { planner });
    const before = planner.tracker.tracks.map((t) => t.id);
    const plan = planner.plan(
      [testFace(0.3, 0.5, 0.15), testFace(0.6, 0.5, 0.25), testFace(0.8, 0.5, 0.15)],
      null,
      3.2,
      true,
      FRAME
    );
    expect(plan.tracks.some((t) => before.includes(t.id))).toBe(false);
    expect(plan.rule).toBe("subject");
    expect(plan.faces[0].cx).toBeCloseTo(0.6, 6);
  });

  it("keeps the subject through one missed face", () => {
    const faces = (t: number) => [
      testFace(0.2, 0.5, 0.2),
      testFace(0.5, 0.5, 0.3),
      ...(Math.abs(t - 2) < 0.01 ? [] : [testFace(0.8, 0.5, 0.2)]),
    ];
    const plans = run(faces, 3);
    const subjects = plans.map(({ plan }) => plan.subjectTrackId);
    expect(subjects.every((id) => id === subjects[0] && id !== null)).toBe(true);
  });

  it("a third face seen for a moment next to a two-person shot stays stacked (only confirmed tracks start the 3+ rules)", () => {
    const blip = (t: number) => Math.abs(t - 2) < 0.01 || Math.abs(t - 2.2) < 0.01;
    const plans = run(
      (t) => [
        testFace(0.25, 0.4, 0.17),
        testFace(0.72, 0.4, 0.16),
        ...(blip(t) ? [testFace(0.63, 0.4, 0.14, 40)] : []),
      ],
      4
    );
    expect(plans.every(({ plan }) => plan.rule === "stacked")).toBe(true);
  });
});

describe("layoutKey", () => {
  it("tells a main-subject or group pane apart from a single face, with the same pane count", () => {
    expect(layoutKey("subject", 1)).not.toBe(layoutKey("single", 1));
    expect(layoutKey("group", 1)).toBe(layoutKey("subject", 1));
    expect(layoutKey("stacked", 2)).toBe(2);
    expect(paneCountOf(layoutKey("subject", 1))).toBe(1);
    expect(paneCountOf(layoutKey("grid", 3))).toBe(3);
  });
});

describe("LayoutPlanner, main's rules for 3+ faces (default)", () => {
  it("keeps the tracker and the foreground filter: a large face plus small ones stays single", () => {
    const crowd = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9].map((cx) => testFace(cx, 0.3, 0.13));
    const plans = run(() => [testFace(0.5, 0.5, 0.3), ...crowd], 2, { planner: new LayoutPlanner() });
    expect(plans.every(({ plan }) => plan.rule === "single")).toBe(true);
  });

  it("shows three similar faces as a grid, debounced on the pane count", () => {
    const plans = run(() => [testFace(0.2, 0.5, 0.2), testFace(0.5, 0.5, 0.2), testFace(0.8, 0.5, 0.2)], 1, {
      planner: new LayoutPlanner(),
    });
    expect(plans.every(({ plan }) => plan.rule === "grid" && plan.debounceKey === 3)).toBe(true);
  });

  it("locks onto a size-dominant face after 0.8s", () => {
    const plans = run(() => [testFace(0.2, 0.5, 0.15), testFace(0.5, 0.5, 0.22), testFace(0.8, 0.5, 0.15)], 1.2, {
      planner: new LayoutPlanner(),
    });
    expect(plans[0].plan.rule).toBe("grid");
    expect(plans.at(-1)!.plan.rule).toBe("subject");
    expect(plans.at(-1)!.plan.faces[0].cx).toBeCloseTo(0.5, 6);
    expect(plans.at(-1)!.plan.debounceKey).toBe(1);
  });
});
