import { describe, expect, it } from "vitest";
import { CutTrigger, TRIGGER_H, TRIGGER_SPIKE_HISTORY, TRIGGER_W, locateCut } from "./cutTrigger";

function solid(r: number, g: number, b: number): Uint8Array {
  const frame = new Uint8Array(TRIGGER_W * TRIGGER_H * 4);
  for (let i = 0; i < frame.length; i += 4) frame.set([r, g, b, 255], i);
  return frame;
}

/** A frame with a horizontal gradient shifted by `offset`, so consecutive frames differ a little, like motion. */
function moving(offset: number): Uint8Array {
  const frame = new Uint8Array(TRIGGER_W * TRIGGER_H * 4);
  for (let y = 0; y < TRIGGER_H; y++) {
    for (let x = 0; x < TRIGGER_W; x++) {
      const v = 60 + ((x + offset) % TRIGGER_W);
      frame.set([v, v, v, 255], (y * TRIGGER_W + x) * 4);
    }
  }
  return frame;
}

describe("CutTrigger", () => {
  it("scores the first frame 0", () => {
    expect(new CutTrigger().observe(solid(200, 30, 30))).toEqual({ hist: 0, grid: 0, triggered: false });
  });

  it("triggers on a colour change", () => {
    const trigger = new CutTrigger();
    trigger.observe(solid(200, 30, 30));
    const scores = trigger.observe(solid(30, 30, 200));
    expect(scores.hist).toBe(1);
    expect(scores.triggered).toBe(true);
  });

  it("does not trigger on small frame-to-frame motion", () => {
    const trigger = new CutTrigger();
    for (let i = 0; i < 30; i++) expect(trigger.observe(moving(i)).triggered).toBe(false);
  });

  it("triggers on a cut after a run of motion", () => {
    const trigger = new CutTrigger();
    for (let i = 0; i < TRIGGER_SPIKE_HISTORY + 2; i++) trigger.observe(moving(i));
    expect(trigger.observe(solid(200, 30, 30)).triggered).toBe(true);
  });

  it("forgets the previous frame on reset", () => {
    const trigger = new CutTrigger();
    trigger.observe(solid(200, 30, 30));
    trigger.reset();
    expect(trigger.observe(solid(30, 30, 200)).triggered).toBe(false);
  });
});

describe("locateCut", () => {
  const scores = [
    { mediaTimeSec: 3.88, score: 0.01 },
    { mediaTimeSec: 3.92, score: 0.02 },
    { mediaTimeSec: 3.96, score: 0.01 },
    { mediaTimeSec: 4.0, score: 0.6 },
    { mediaTimeSec: 4.04, score: 0.02 },
  ];

  it("moves a cut found on a later detection back to the frame with the biggest jump", () => {
    expect(locateCut(scores, 3.88, 4.04)).toBe(4.0);
  });

  it("only looks after the previous detection", () => {
    expect(locateCut(scores, 4.0, 4.04)).toBe(4.04);
  });

  it("keeps the detection frame without scores", () => {
    expect(locateCut([], 3.8, 4.04)).toBe(4.04);
  });
});
