import { describe, expect, it } from "vitest";
import { BenchmarkRecorder } from "./BenchmarkRecorder";
import type { BenchmarkEnvironment } from "./environment";
import { benchmarkReportToCsv, benchmarkSummaryRows, buildBenchmarkReport, findPrecisionWarnings } from "./report";

const environment: BenchmarkEnvironment = {
  collectedAt: "2026-01-01T00:00:00.000Z",
  pageUrl: "http://localhost/",
  userAgent: "test",
  hardwareConcurrency: 8,
  deviceMemoryGb: null,
  screen: { width: 1920, height: 1080 },
  devicePixelRatio: 2,
  crossOriginIsolated: false,
  wasmSimdSupported: true,
  wasmBuiltWithSimd: false,
  requestVideoFrameCallbackSupported: true,
  longTasksSupported: false,
  timerResolutionMs: 0.1,
};

function sampleResult() {
  const video = {
    duration: 2,
    videoWidth: 1280,
    videoHeight: 720,
    muted: false,
  } as unknown as HTMLVideoElement;
  const recorder = new BenchmarkRecorder({ clipName: "clip, one", video, warmupSec: 0, nominalFps: 25 });
  for (let i = 0; i < 10; i++) recorder.recordFrame(i * 40, 0.3, i * 0.04, i);
  recorder.recordDetection("worker", 2, 3, 40, 0.5, 50, 2, 1);
  recorder.recordSkippedDetection();
  recorder.recordLayoutChange(200);
  return recorder.finish("9:16");
}

describe("findPrecisionWarnings", () => {
  it("flags timing metrics whose median is within 10 timer ticks", () => {
    const warnings = findPrecisionWarnings([sampleResult()], 0.1);
    expect(warnings.map((w) => w.metric)).toEqual(["frameWorkMs", "detection.postProcessMs"]);
  });

  it("returns nothing when the timer resolution is unknown", () => {
    expect(findPrecisionWarnings([sampleResult()], null)).toEqual([]);
  });
});

describe("benchmarkReportToCsv", () => {
  it("writes one row per raw sample with a shared header and quotes commas", () => {
    const report = buildBenchmarkReport({ wasmWarmupSec: 3, clipWarmupSec: 1, baseline: true }, environment, [
      sampleResult(),
    ]);
    const lines = benchmarkReportToCsv(report).trim().split("\n");
    expect(lines[0].startsWith("kind,clip,mode,index,warmup")).toBe(true);
    expect(lines).toHaveLength(1 + 10 + 1 + 1 + 1);
    expect(lines[1].startsWith('frame,"clip, one",9:16,0,0,0,0,0.3,0')).toBe(true);
    expect(lines.some((line) => line.startsWith("skipped_detection,"))).toBe(true);
    expect(lines.some((line) => line.startsWith("layout_change,"))).toBe(true);
  });
});

describe("benchmarkSummaryRows", () => {
  it("produces one row per clip with detection rate and skipped count", () => {
    const report = buildBenchmarkReport({ wasmWarmupSec: 3, clipWarmupSec: 1, baseline: false }, environment, [
      sampleResult(),
    ]);
    const [row] = benchmarkSummaryRows(report);
    expect(row.clip).toBe("clip, one");
    expect(row["skipped (in flight)"]).toBe(1);
    expect(row["render fps"]).toBe(25);
    expect(report.precisionWarnings.length).toBeGreaterThan(0);
  });
});
