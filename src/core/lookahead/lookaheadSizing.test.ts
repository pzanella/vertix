import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETECTION_P95_MS,
  DEFAULT_TRIGGER_P95_MS,
  FRAME_BUFFER_BUDGET_BYTES,
  MAX_LOOKAHEAD_MS,
  MIN_LOOKAHEAD_MS,
  RollingP95,
  chooseSlotSize,
  lookaheadLengthMs,
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

describe("chooseSlotSize", () => {
  it("keeps a 720p source at full size", () => {
    const size = chooseSlotSize(1280, 720, 290, 30, 1);
    expect(size).toMatchObject({ width: 1280, height: 720, neededSlots: 12 });
    expect(size.neededSlots * size.bytesPerSlot).toBeLessThanOrEqual(FRAME_BUFFER_BUDGET_BYTES);
  });

  it("keeps 1080p up to a phone SIMD lookahead, drops to 720p for a phone scalar one", () => {
    expect(chooseSlotSize(1920, 1080, 170, 30, 1).height).toBe(1080);
    expect(chooseSlotSize(1920, 1080, 290, 30, 1).height).toBe(1080);
    expect(chooseSlotSize(1920, 1080, 490, 30, 1)).toMatchObject({ width: 1280, height: 720 });
  });

  it("never upscales", () => {
    expect(chooseSlotSize(640, 360, 600, 60, 2)).toMatchObject({ width: 640, height: 360 });
  });

  it("allows more slots than needed when the budget has room", () => {
    const size = chooseSlotSize(1280, 720, 170, 25, 1);
    expect(size.maxSlots).toBeGreaterThan(size.neededSlots);
    expect(size.maxSlots * size.bytesPerSlot).toBeLessThanOrEqual(FRAME_BUFFER_BUDGET_BYTES);
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
