import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETECTION_P95_MS,
  DEFAULT_TRIGGER_P95_MS,
  FRAME_BUFFER_BUDGET_BYTES,
  MAX_LOOKAHEAD_MS,
  MIN_LOOKAHEAD_MS,
  RollingP95,
  alignToFrames,
  chooseSlotSize,
  lookaheadLengthMs,
  maxSlotsFor,
  slotsForDelay,
} from "./lookaheadSizing";

describe("lookaheadLengthMs", () => {
  it("gives the expected defaults per device and build at 25 fps", () => {
    const at25 = (detection: number) => lookaheadLengthMs(detection, DEFAULT_TRIGGER_P95_MS, 40);
    expect(at25(DEFAULT_DETECTION_P95_MS.desktop.simd)).toBe(170);
    expect(at25(DEFAULT_DETECTION_P95_MS.desktop.scalar)).toBe(206);
    expect(at25(DEFAULT_DETECTION_P95_MS.mobile.simd)).toBe(290);
    expect(at25(DEFAULT_DETECTION_P95_MS.mobile.scalar)).toBe(490);
  });

  it("stays within its bounds", () => {
    expect(lookaheadLengthMs(1, 0, 1)).toBe(MIN_LOOKAHEAD_MS);
    expect(lookaheadLengthMs(1000, 0, 40)).toBe(MAX_LOOKAHEAD_MS);
  });
});

describe("alignToFrames", () => {
  it("rounds the length up to whole frames", () => {
    expect(alignToFrames(290, 0.04, 1)).toEqual({ frames: 8, lengthMs: 320 });
    expect(alignToFrames(170, 0.02, 1)).toEqual({ frames: 9, lengthMs: 180 });
    expect(alignToFrames(160, 0.04, 1)).toEqual({ frames: 4, lengthMs: 160 });
  });

  it("counts frames in wall time at other speeds", () => {
    expect(alignToFrames(170, 0.04, 2)).toEqual({ frames: 9, lengthMs: 180 });
  });

  it("rounds down instead of passing the maximum", () => {
    // 70 ms frames: 9 frames would be 630 ms.
    const { frames, lengthMs } = alignToFrames(590, 0.07, 1);
    expect(lengthMs).toBeLessThanOrEqual(MAX_LOOKAHEAD_MS);
    expect(frames).toBe(8);
  });
});

describe("chooseSlotSize", () => {
  it("keeps a 720p source at full size on a large screen and on a phone", () => {
    expect(chooseSlotSize(1280, 720, slotsForDelay(8), null)).toMatchObject({ width: 1280, height: 720 });
    // Phone: the 9:16 canvas is about 600 CSS px tall at DPR 2.6.
    expect(chooseSlotSize(1280, 720, slotsForDelay(8), 1560)).toMatchObject({ width: 1280, height: 720 });
  });

  it("stores no more pixels than the canvas on screen can show", () => {
    expect(chooseSlotSize(1920, 1080, slotsForDelay(8), 400)).toMatchObject({ width: 1066, height: 600 });
  });

  it("keeps 1080p for phone lookaheads, drops to 720p only when the budget forces it", () => {
    expect(chooseSlotSize(1920, 1080, slotsForDelay(8), null).height).toBe(1080);
    expect(chooseSlotSize(1920, 1080, slotsForDelay(13), null).height).toBe(720);
  });

  it("applies a height cap", () => {
    expect(chooseSlotSize(1280, 720, slotsForDelay(8), null, 540)).toMatchObject({ width: 960, height: 540 });
    expect(chooseSlotSize(640, 360, slotsForDelay(8), null, 540)).toMatchObject({ width: 640, height: 360 });
  });

  it("never upscales", () => {
    expect(chooseSlotSize(640, 360, slotsForDelay(15), 2000)).toMatchObject({ width: 640, height: 360 });
  });
});

describe("maxSlotsFor", () => {
  it("allows the slots needed, no more, within the budget", () => {
    const size = chooseSlotSize(1280, 720, slotsForDelay(8), null);
    expect(maxSlotsFor(size, slotsForDelay(8))).toBe(10);
    expect(maxSlotsFor(size, 200) * size.bytesPerSlot).toBeLessThanOrEqual(FRAME_BUFFER_BUDGET_BYTES);
  });
});

describe("RollingP95", () => {
  it("needs enough samples, then follows the recent window", () => {
    const p95 = new RollingP95(20);
    for (let i = 1; i <= 9; i++) p95.push(i);
    expect(p95.p95()).toBeNull();
    p95.push(10);
    expect(p95.p95()).toBe(10);
    for (let i = 0; i < 20; i++) p95.push(50);
    expect(p95.p95()).toBe(50);
  });
});
