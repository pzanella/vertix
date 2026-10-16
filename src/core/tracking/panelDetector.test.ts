import { describe, expect, it } from "vitest";
import type { FaceTrack } from "./faceTracker";
import { PanelDetector } from "./panelDetector";

function track(id: number, cx: number, size = 0.2): FaceTrack {
  return {
    id,
    box: { cx, cy: 0.5, w: size, h: size },
    lastDetection: { cx, cy: 0.5, w: size, h: size, motion: 0, lowerFaceMotion: 0, confidence: 0.9 },
    vx: 0,
    vy: 0,
    hits: 10,
    confirmed: true,
    firstSeenSec: 0,
    lastSeenSec: 0,
    visible: true,
    mouthActivity: 0,
    lowerFaceMotion: 0,
    jitter: 0,
    foreground: true,
  };
}

const panel = () => [track(1, 0.2), track(2, 0.5), track(3, 0.8)];

function verdicts(detector: PanelDetector, frames: (t: number) => FaceTrack[], untilSec: number): boolean[] {
  const result: boolean[] = [];
  for (let t = 0.2; t <= untilSec + 1e-9; t = Math.round((t + 0.2) * 10) / 10)
    result.push(detector.observe(frames(t), t));
  return result;
}

describe("PanelDetector, evidence variant (default)", () => {
  it("accepts 3 similar still faces only after 1.0s", () => {
    expect(verdicts(new PanelDetector("evidence"), panel, 1.4)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("never accepts faces that move", () => {
    const moving = (t: number) => [track(1, 0.2 + 0.05 * t), track(2, 0.5), track(3, 0.8)];
    expect(verdicts(new PanelDetector("evidence"), moving, 3).some(Boolean)).toBe(false);
  });

  it("does not accept faces of very different sizes, or more than 4", () => {
    const mixed = () => [track(1, 0.2, 0.3), track(2, 0.5), track(3, 0.8, 0.15)];
    const crowd = () => [0.1, 0.3, 0.5, 0.7, 0.9].map((cx, i) => track(i + 1, cx));
    expect(verdicts(new PanelDetector("evidence"), mixed, 2).some(Boolean)).toBe(false);
    expect(verdicts(new PanelDetector("evidence"), crowd, 2).some(Boolean)).toBe(false);
  });

  it("starts collecting evidence again when the set of faces changes", () => {
    const detector = new PanelDetector("evidence");
    verdicts(detector, panel, 2);
    expect(detector.observe([track(1, 0.2), track(2, 0.5), track(4, 0.8)], 2.2)).toBe(false);
  });
});

describe("PanelDetector, until-moved variant", () => {
  it("accepts similar faces at once, and rules them out for good once one moves", () => {
    const detector = new PanelDetector("until-moved");
    expect(detector.observe(panel(), 0.2)).toBe(true);
    expect(detector.observe([track(1, 0.27), track(2, 0.5), track(3, 0.8)], 0.4)).toBe(false);
    expect(detector.observe(panel(), 0.6)).toBe(false);
  });
});
