import { describe, expect, it } from "vitest";
import {
  DETECTION_WARMUP_COUNT,
  DETECTION_WARMUP_MS,
  DetectionLatencyTracker,
  MIN_WARM_SAMPLES,
} from "./detectionLatency";

/** Records `count` detections of `build`, 200 ms apart, starting `startMs` after the detector was ready. */
function feed(
  tracker: DetectionLatencyTracker,
  build: "simd" | "scalar",
  latencyMs: number,
  count: number,
  startMs = 0
) {
  for (let i = 0; i < count; i++) tracker.record(build, latencyMs, startMs + i * 200, i + 1);
}

describe("DetectionLatencyTracker", () => {
  it("ignores the first detections after a detector starts, by time and by count", () => {
    const tracker = new DetectionLatencyTracker();
    expect(tracker.record("simd", 900, DETECTION_WARMUP_MS - 1, 50)).toBe(false);
    expect(tracker.record("simd", 900, DETECTION_WARMUP_MS + 1000, DETECTION_WARMUP_COUNT)).toBe(false);
    expect(tracker.record("simd", 50, DETECTION_WARMUP_MS, DETECTION_WARMUP_COUNT + 1)).toBe(true);
  });

  it("gives no p95 until enough warm samples exist", () => {
    const tracker = new DetectionLatencyTracker();
    feed(tracker, "simd", 50, MIN_WARM_SAMPLES - 1, DETECTION_WARMUP_MS);
    expect(tracker.p95("simd")).toBeNull();
  });

  it("keeps cold-start detections of a new worker out of the p95", () => {
    const tracker = new DetectionLatencyTracker();
    // A fresh worker: 15 detections over 3 s, the first ones very slow.
    for (let i = 0; i < 15; i++) tracker.record("scalar", i < 4 ? 900 : 200, i * 200, i + 1);
    feed(tracker, "scalar", 200, 20, 3000);
    expect(tracker.p95("scalar")).toBe(200);
  });

  it("keeps one p95 per build", () => {
    const tracker = new DetectionLatencyTracker();
    feed(tracker, "simd", 50, 20, DETECTION_WARMUP_MS);
    feed(tracker, "scalar", 200, 20, DETECTION_WARMUP_MS);
    expect(tracker.p95("simd")).toBe(50);
    expect(tracker.p95("scalar")).toBe(200);
  });
});
