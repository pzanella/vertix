import type { BenchmarkClipResult, BenchmarkClipSummary } from "./BenchmarkRecorder";
import type { BenchmarkEnvironment } from "./environment";
import type { SampleSummary } from "./stats";
import type { WasmBuildVariant } from "../wasmBuild";

export interface BenchmarkConfig {
  /** Seconds of the first clip played, unrecorded, before the suite starts — warms up WASM and the JIT. */
  wasmWarmupSec: number;
  /** Media-time seconds at the start of each clip that are recorded but excluded from the summary (player startup). */
  clipWarmupSec: number;
  /** Whether the suite ends with a 16:9 (no detection) run of the first clip. */
  baseline: boolean;
}

export interface PrecisionWarning {
  clip: string;
  metric: string;
  p50Ms: number;
  timerResolutionMs: number;
}

/** How the run compared the WASM builds. Schema v3. */
export interface WasmBuildComparison {
  /** Builds measured in this run, in first-use order. */
  builds: WasmBuildVariant[];
  /** "alternating-per-clip": even clips ran SIMD then scalar, odd clips scalar then SIMD. */
  order: "alternating-per-clip" | null;
  /** Set when the SIMD build was not measured because this browser cannot run it. */
  simdSkippedReason: "not-supported" | null;
}

export interface BenchmarkReport {
  tool: "vertix-benchmark";
  schemaVersion: 4;
  config: BenchmarkConfig;
  environment: BenchmarkEnvironment;
  wasmBuildComparison: WasmBuildComparison;
  /** Timing metrics whose median is within PRECISION_WARNING_FACTOR × the measured timer resolution. */
  precisionWarnings: PrecisionWarning[];
  results: BenchmarkClipResult[];
}

/** A median below this many timer ticks is reported as low-precision. */
export const PRECISION_WARNING_FACTOR = 10;

const TIMED_METRICS: { name: string; get: (s: BenchmarkClipSummary) => SampleSummary }[] = [
  { name: "frameWorkMs", get: (s) => s.frameWorkMs },
  { name: "detection.downscaleMs", get: (s) => s.detection.downscaleMs },
  { name: "detection.readbackMs", get: (s) => s.detection.readbackMs },
  { name: "detection.wasmMs", get: (s) => s.detection.wasmMs },
  { name: "detection.postProcessMs", get: (s) => s.detection.postProcessMs },
  { name: "detection.overheadMs", get: (s) => s.detection.overheadMs },
  { name: "detection.totalMs", get: (s) => s.detection.totalMs },
];

export function findPrecisionWarnings(
  results: BenchmarkClipResult[],
  timerResolutionMs: number | null
): PrecisionWarning[] {
  if (timerResolutionMs === null || timerResolutionMs <= 0) return [];
  const warnings: PrecisionWarning[] = [];
  for (const result of results) {
    for (const metric of TIMED_METRICS) {
      const { count, p50 } = metric.get(result.summary);
      if (count > 0 && p50 !== null && p50 < timerResolutionMs * PRECISION_WARNING_FACTOR) {
        warnings.push({ clip: result.clip, metric: metric.name, p50Ms: p50, timerResolutionMs });
      }
    }
  }
  return warnings;
}

export function buildBenchmarkReport(
  config: BenchmarkConfig,
  environment: BenchmarkEnvironment,
  wasmBuildComparison: WasmBuildComparison,
  results: BenchmarkClipResult[]
): BenchmarkReport {
  return {
    tool: "vertix-benchmark",
    schemaVersion: 4,
    config,
    environment,
    wasmBuildComparison,
    precisionWarnings: findPrecisionWarnings(results, environment.timerResolutionMs),
    results,
  };
}

const CSV_COLUMNS = [
  "kind",
  "clip",
  "mode",
  "wasm_build",
  "wasm_build_position",
  "index",
  "warmup",
  "time_ms",
  "media_time_s",
  "work_ms",
  "presented_frames",
  "path",
  "downscale_ms",
  "readback_ms",
  "wasm_ms",
  "post_process_ms",
  "total_ms",
  "raw_faces",
  "kept_faces",
  "skin_rejected",
  "skin_rejected_speaker_sized",
  "duration_ms",
  "frame_media_time_s",
  "scene_cut_hist",
  "scene_cut_grid",
  "scene_cut",
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number];
type CsvRow = Partial<Record<CsvColumn, string | number>>;

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per raw sample (frame, detection, skipped detection, layout change, long task) of every clip, in one long-format table. */
export function benchmarkReportToCsv(report: BenchmarkReport): string {
  const lines = [CSV_COLUMNS.join(",")];
  const push = (row: CsvRow) => lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));

  for (const { clip, mode, raw, wasmBuild } of report.results) {
    const { frames, detections, skippedDetections, layoutChanges, longTasks } = raw;
    const build = { wasm_build: wasmBuild.variant, wasm_build_position: wasmBuild.runOrder?.position };
    frames.nowMs.forEach((_, i) =>
      push({
        kind: "frame",
        clip,
        mode,
        ...build,
        index: i,
        warmup: frames.warmup[i],
        time_ms: frames.nowMs[i],
        media_time_s: frames.mediaTimeSec[i],
        work_ms: frames.workMs[i],
        presented_frames: frames.presentedFrames[i],
      })
    );
    detections.totalMs.forEach((_, i) =>
      push({
        kind: "detection",
        clip,
        mode,
        ...build,
        index: i,
        warmup: detections.warmup[i],
        time_ms: detections.endedAtMs[i],
        media_time_s: detections.mediaTimeSec[i],
        path: detections.path[i],
        downscale_ms: detections.downscaleMs[i],
        readback_ms: detections.readbackMs[i],
        wasm_ms: detections.wasmMs[i],
        post_process_ms: detections.postProcessMs[i],
        total_ms: detections.totalMs[i],
        raw_faces: detections.rawFaces[i],
        kept_faces: detections.keptFaces[i],
        skin_rejected: detections.skinRejected[i],
        skin_rejected_speaker_sized: detections.skinRejectedSpeakerSized[i],
        frame_media_time_s: detections.frameMediaTimeSec[i],
        scene_cut_hist: detections.sceneCutHist[i],
        scene_cut_grid: detections.sceneCutGrid[i],
        scene_cut: detections.sceneCut[i],
      })
    );
    skippedDetections.mediaTimeSec.forEach((_, i) =>
      push({
        kind: "skipped_detection",
        clip,
        mode,
        ...build,
        index: i,
        warmup: skippedDetections.warmup[i],
        media_time_s: skippedDetections.mediaTimeSec[i],
      })
    );
    layoutChanges.nowMs.forEach((_, i) =>
      push({
        kind: "layout_change",
        clip,
        mode,
        ...build,
        index: i,
        warmup: layoutChanges.warmup[i],
        time_ms: layoutChanges.nowMs[i],
        media_time_s: layoutChanges.mediaTimeSec[i],
      })
    );
    longTasks.startTimeMs.forEach((_, i) =>
      push({
        kind: "long_task",
        clip,
        mode,
        ...build,
        index: i,
        warmup: longTasks.warmup[i],
        time_ms: longTasks.startTimeMs[i],
        duration_ms: longTasks.durationMs[i],
      })
    );
  }
  return lines.join("\n") + "\n";
}

function round(value: number | null, digits = 2): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type BenchmarkTableRow = Record<string, string | number | null>;

/** One compact row per clip, for console.table and the on-page results table. */
export function benchmarkSummaryRows(report: BenchmarkReport): BenchmarkTableRow[] {
  return report.results.map(({ clip, mode, summary, pageHiddenDuringRun, wasmBuild }) => ({
    clip,
    mode,
    build: mode === "16:9" ? "n/a" : wasmBuild.variant,
    "build order": wasmBuild.runOrder ? `${wasmBuild.runOrder.position}/${wasmBuild.runOrder.sequence.length}` : null,
    "render fps": round(summary.effectiveFps, 1),
    "frame work p50 ms": round(summary.frameWorkMs.p50),
    "frame work p95 ms": round(summary.frameWorkMs.p95),
    "frame work p99 ms": round(summary.frameWorkMs.p99),
    "dropped (est.)": summary.frames.droppedFramesEstimate,
    "expected frames": summary.frames.expectedFrames,
    "detect Hz": round(summary.detection.rateHz),
    detections: summary.detection.count,
    "skipped (in flight)": summary.detection.skippedInFlight,
    "detect total p50 ms": round(summary.detection.totalMs.p50),
    "detect total p95 ms": round(summary.detection.totalMs.p95),
    "wasm p50 ms": round(summary.detection.wasmMs.p50),
    "wasm p95 ms": round(summary.detection.wasmMs.p95),
    "faces p50": round(summary.detection.keptFaces.p50, 1),
    "skin rejected": summary.detection.skinRejected.total,
    "skin rejected (speaker-sized)": summary.detection.skinRejected.speakerSized,
    "layout changes": summary.layoutChanges,
    "scene cuts": summary.sceneCutCount,
    "long tasks": summary.longTasks.supported ? summary.longTasks.count : "n/a",
    "page hidden": pageHiddenDuringRun ? "yes (invalid)" : "no",
    "duplicate callbacks": summary.frames.duplicateCallbacks,
  }));
}
