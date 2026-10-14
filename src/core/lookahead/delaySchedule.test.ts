import { describe, expect, it } from "vitest";
import { DelaySchedule, MAX_RAMP_SPEED_CHANGE, MIN_RAMP_MS } from "./delaySchedule";

describe("DelaySchedule", () => {
  it("jumps at once with set", () => {
    const schedule = new DelaySchedule();
    schedule.set(320);
    expect(schedule.valueAt(0)).toBe(320);
    expect(schedule.isRamping(0)).toBe(false);
  });

  it("ramps linearly, never faster than the allowed speed change", () => {
    const schedule = new DelaySchedule();
    schedule.set(320);
    const duration = schedule.rampTo(1000, 480);
    expect(duration).toBe(160 / MAX_RAMP_SPEED_CHANGE);
    expect(schedule.valueAt(1000 + duration / 2)).toBe(400);
    expect(schedule.valueAt(1000 + duration)).toBe(480);
    expect(schedule.isRamping(1000 + duration - 1)).toBe(true);
  });

  it("takes at least the minimum ramp time for a small change", () => {
    const schedule = new DelaySchedule();
    schedule.set(160);
    expect(schedule.rampTo(0, 170)).toBe(MIN_RAMP_MS);
  });

  it("starts a new ramp from where the current one is", () => {
    const schedule = new DelaySchedule();
    schedule.set(100);
    const first = schedule.rampTo(0, 200);
    schedule.rampTo(first / 2, 100);
    expect(schedule.valueAt(first / 2)).toBe(150);
    expect(schedule.targetMs).toBe(100);
  });
});
