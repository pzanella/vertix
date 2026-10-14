import { describe, expect, it } from "vitest";
import { BenchmarkRecorder, type BenchmarkClipResult } from "./BenchmarkRecorder";
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
  wasmBuiltWithSimd: true,
  wasmBuild: { defaultVariant: "simd", defaultReason: "supported" },
  wasmBinarySizes: { simd: 100, scalar: 110 },
  requestVideoFrameCallbackSupported: true,
  longTasksSupported: false,
  timerResolutionMs: 0.1,
};

const comparison = { builds: ["simd" as const], order: null, simdSkippedReason: null };

function sampleResult(): BenchmarkClipResult {
  const video = {
    duration: 2,
    videoWidth: 1280,
    videoHeight: 720,
    muted: false,
  } as unknown as HTMLVideoElement;
  const recorder = new BenchmarkRecorder({ clipName: "clip, one", video, warmupSec: 0, nominalFps: 25 });
  for (let i = 0; i < 10; i++) recorder.recordFrame(i * 40, 0.3, i * 0.04, i);
  recorder.recordDetection("worker", 2, 3, 40, 0.5, 50, 2, 1, 1, 0, 1.2, 0.4, 0.3, true);
  recorder.recordSkippedDetection();
  recorder.recordLayoutChange(200);
  return {
    ...recorder.finish("9:16"),
    wasmBuild: { variant: "simd", reason: "benchmark-suite", runOrder: { position: 1, sequence: ["simd", "scalar"] } },
    lookahead: {
      enabled: true,
      unavailableReason: null,
      bypassed: false,
      audioDelayMs: 160,
      lengthMs: 160,
      delayFrames: 4,
      detectionP95Ms: 60,
      lengthSource: "default",
      slotWidth: 1280,
      slotHeight: 720,
      allocatedSlots: 9,
      bufferBytes: 9 * 1280 * 720 * 4,
      droppedFrames: 0,
      overflowDrops: 0,
      skippedOnDisplay: 0,
    },
  };
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
    const report = buildBenchmarkReport(
      { wasmWarmupSec: 3, clipWarmupSec: 1, baseline: true },
      environment,
      comparison,
      [sampleResult()]
    );
    const lines = benchmarkReportToCsv(report).trim().split("\n");
    expect(lines[0].startsWith("kind,clip,mode,wasm_build,wasm_build_position,index,warmup")).toBe(true);
    expect(lines).toHaveLength(1 + 10 + 1 + 1 + 1);
    expect(lines[1].startsWith('frame,"clip, one",9:16,simd,1,0,0,0,0,0.3,0')).toBe(true);
    expect(lines[1].includes(",160,")).toBe(true);
    expect(lines.some((line) => line.startsWith("skipped_detection,"))).toBe(true);
    expect(lines.some((line) => line.startsWith("layout_change,"))).toBe(true);
    expect(
      lines[0].endsWith(
        "scene_cut_hist,scene_cut_grid,scene_cut,lookahead_ms,triggered,resolved_faces,resolved_cx,error_ms,cut_media_time_s,shown_media_time_s,cut_source"
      )
    ).toBe(true);
    expect(
      lines.find((line) => line.startsWith("detection,"))!.endsWith(",2,1,1,0,,1.2,0.4,0.3,1,160,0,NaN,NaN,,,,")
    ).toBe(true);
  });
});

describe("benchmarkSummaryRows", () => {
  it("produces one row per clip with detection rate and skipped count", () => {
    const report = buildBenchmarkReport(
      { wasmWarmupSec: 3, clipWarmupSec: 1, baseline: false },
      environment,
      comparison,
      [sampleResult()]
    );
    const [row] = benchmarkSummaryRows(report);
    expect(row.clip).toBe("clip, one");
    expect(row["skipped (in flight)"]).toBe(1);
    expect(row["skin rejected"]).toBe(1);
    expect(row["skin rejected (speaker-sized)"]).toBe(0);
    expect(row["scene cuts"]).toBe(1);
    expect(report.schemaVersion).toBe(5);
    expect(row.lookahead).toBe("160 ms");
    expect(row["render fps"]).toBe(25);
    expect(report.precisionWarnings.length).toBeGreaterThan(0);
  });
});
