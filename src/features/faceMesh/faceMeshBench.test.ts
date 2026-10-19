import { describe, expect, it } from "vitest";
import { FaceMeshBenchRecorder, frameKindOf } from "./faceMeshBench";

function recorder() {
  return new FaceMeshBenchRecorder({
    lookahead: () => ({ lengthMs: 320, baseLengthMs: 160, minimumMs: 330 }),
    init: () => null,
    wasmMemoryBytes: () => Promise.resolve(null),
    workerRestarts: () => 0,
  });
}

describe("face mesh benchmark block", () => {
  it("classifies a frame by its least smooth mesh", () => {
    expect(frameKindOf([])).toBe("empty");
    expect(frameKindOf(["interpolated", "interpolated"])).toBe("interpolated");
    expect(frameKindOf(["interpolated", "stepped"])).toBe("stepped");
    expect(frameKindOf(["stepped", "held", "interpolated"])).toBe("held");
  });

  it("counts a mesh appearing or disappearing as one flicker event, per minute of media time, after warm-up", async () => {
    const bench = recorder();
    bench.start({ warmupSec: 1 });
    bench.recordFrame(0.5, [], [], 1);
    bench.recordFrame(1, [1], ["interpolated"], 1);
    bench.recordFrame(16, [], [], 1);
    bench.recordFrame(31, [1], ["stepped"], 1);
    const block = await bench.finish();
    expect(block.frames).toEqual({ displayed: 3, interpolated: 1 / 3, stepped: 1 / 3, held: 0, empty: 1 / 3 });
    expect(block.flickerEventsPerMinute).toBeCloseTo(3 / 0.5, 6);
    expect(block.lookahead).toEqual({ lengthMs: 320, baseLengthMs: 160, minimumMs: 330 });
  });

  it("summarises checked ticks and counts skipped ones and faces without a mesh", async () => {
    const bench = recorder();
    bench.start({ warmupSec: 0 });
    const tick = {
      mediaTimeSec: 1,
      faces: 2,
      resultAgeMs: 80,
      roundTripMs: 45,
      landmarkerMs: [19, 21],
      meshesFound: 1,
    };
    bench.recordTick({ ...tick, outcome: "checked" });
    bench.recordTick({ ...tick, outcome: "skipped" });
    bench.recordBlocked("odml.pa.googleapis.com");
    const block = await bench.finish();
    expect(block.landmark).toMatchObject({
      checkedTicks: 1,
      skippedTicks: 1,
      facesPerCheckedTick: 2,
      noMeshShare: 0.5,
    });
    expect(block.landmark.perFaceMs.count).toBe(2);
    expect(block.blockedRequests).toEqual({ count: 1, hosts: ["odml.pa.googleapis.com"] });
  });
});
