import { describe, expect, it } from "vitest";
import {
  MESH_LOOKAHEAD_MARGIN_MS,
  MESH_LOOKAHEAD_MIN_SAMPLES,
  MAX_TICK_INTERVAL_MS,
  MeshLatency,
  meshLookaheadMinimumMs,
  nextMinimumMs,
} from "./meshLookahead";

function measured(tickIntervalMs: number, resultAgeMs: number, count = MESH_LOOKAHEAD_MIN_SAMPLES) {
  const latency = new MeshLatency();
  for (let i = 0; i < count; i++) {
    latency.recordTickInterval(tickIntervalMs);
    latency.recordResultAge(resultAgeMs);
  }
  return latency;
}

describe("demo-only minimum lookahead", () => {
  it("is tick interval + result age + one frame + the margin, from p95 values", () => {
    expect(meshLookaheadMinimumMs(200, 70, 40)).toBe(310 + MESH_LOOKAHEAD_MARGIN_MS);
    const latency = measured(200, 60, 19);
    latency.recordResultAge(300);
    expect(latency.resultAgeP95Ms).toBe(300);
    expect(latency.minimumMs(40, "desktop")).toBe(200 + 300 + 40 + MESH_LOOKAHEAD_MARGIN_MS);
  });

  it("is about 0.3 s with the desktop numbers from the spike", () => {
    expect(measured(200, 60).minimumMs(40, "desktop")).toBe(330);
  });

  it("is null until enough has been measured, and always null on phones (the mesh off leaves L as on main)", () => {
    expect(measured(200, 60, MESH_LOOKAHEAD_MIN_SAMPLES - 1).minimumMs(40, "desktop")).toBeNull();
    expect(measured(200, 60).minimumMs(40, "mobile")).toBeNull();
    expect(new MeshLatency().minimumMs(40, "desktop")).toBeNull();
  });

  it("ignores gaps longer than a tick interval can be (a pause or a seek)", () => {
    const latency = measured(200, 60);
    latency.recordTickInterval(MAX_TICK_INTERVAL_MS + 1);
    expect(latency.tickIntervalP95Ms).toBe(200);
  });

  it("only moves the applied minimum on a change larger than the hysteresis", () => {
    expect(nextMinimumMs(null, 330)).toBe(330);
    expect(nextMinimumMs(330, 350)).toBe(330);
    expect(nextMinimumMs(330, 400)).toBe(400);
    expect(nextMinimumMs(330, null)).toBeNull();
  });
});
