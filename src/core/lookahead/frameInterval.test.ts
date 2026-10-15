import { describe, expect, it } from "vitest";
import { FrameIntervalTracker } from "./frameInterval";

describe("FrameIntervalTracker", () => {
  it("measures the frame interval and ignores a skipped callback", () => {
    const tracker = new FrameIntervalTracker();
    for (const frame of [0, 1, 2, 3, 5, 6, 7, 8, 9]) tracker.push(frame * 0.04);
    expect(tracker.intervalSec).toBeCloseTo(0.04, 9);
  });

  it("measures 50 fps when most frame callbacks are skipped", () => {
    const tracker = new FrameIntervalTracker();
    let frame = 0;
    for (const step of [2, 1, 3, 2, 2, 1, 3, 2, 3, 2, 1, 2, 3, 2, 2]) tracker.push((frame += step) * 0.02);
    expect(tracker.intervalSec).toBeCloseTo(0.02, 9);
  });

  it("follows a frame-rate change within a few frames", () => {
    const tracker = new FrameIntervalTracker();
    let t = 0;
    for (let i = 0; i < 10; i++) tracker.push((t += 0.04));
    for (let i = 0; i < 6; i++) tracker.push((t += 0.02));
    expect(tracker.intervalSec).toBeCloseTo(0.02, 9);
  });

  it("ignores the jump of a seek", () => {
    const tracker = new FrameIntervalTracker();
    for (let i = 0; i < 5; i++) tracker.push(i * 0.04);
    tracker.restart();
    tracker.push(30);
    tracker.push(30.04);
    expect(tracker.intervalSec).toBeCloseTo(0.04, 9);
  });
});
