import { summarize, type BenchmarkClipResult, type BenchmarkReport, type WasmBuildVariant } from "../../core";
import type { BenchmarkStatus } from "../../hooks/useBenchmark";

export type BenchmarkVerdict = "valid" | "invalid" | "partial" | "failed";
export type BenchmarkTone = "idle" | "running" | "success" | "danger" | "muted";
export type BenchmarkStageKind = "warmup" | "clip" | "baseline";

export interface BenchmarkHighlights {
  runs: number;
  reframedRuns: number;
  droppedFrames: number | null;
  expectedFrames: number | null;
  /** Median of the per-run WASM p50 over 9:16 runs, per build measured. */
  wasmP50MsByBuild: { build: WasmBuildVariant; p50Ms: number | null }[];
  detectionHz: number | null;
}

export const VERDICT_LABEL: Record<BenchmarkVerdict, string> = {
  valid: "Valid",
  invalid: "Invalid",
  partial: "Partial",
  failed: "Failed",
};

export const VERDICT_TONE: Record<BenchmarkVerdict, BenchmarkTone> = {
  valid: "success",
  invalid: "danger",
  partial: "muted",
  failed: "danger",
};

export const TONE_TEXT: Record<BenchmarkTone, string> = {
  idle: "text-neutral-400",
  running: "text-amber-300",
  success: "text-emerald-300",
  danger: "text-red-300",
  muted: "text-neutral-300",
};

export const TONE_CHIP: Record<BenchmarkTone, string> = {
  idle: "bg-neutral-800 text-neutral-300",
  running: "bg-amber-500/15 text-amber-300",
  success: "bg-emerald-500/15 text-emerald-300",
  danger: "bg-red-500/15 text-red-300",
  muted: "bg-neutral-800 text-neutral-300",
};

export function isClipInvalid(result: BenchmarkClipResult): boolean {
  return result.pageHiddenDuringRun || result.summary.frames.duplicateCallbacks > 0;
}

export function benchmarkVerdict(status: BenchmarkStatus, report: BenchmarkReport | null): BenchmarkVerdict | null {
  if (status === "idle" || status === "running") return null;
  if (status === "error") return "failed";
  if (status === "cancelled") return "partial";
  return report?.results.some(isClipInvalid) ? "invalid" : "valid";
}

function sumKnown(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

export function benchmarkHighlights(report: BenchmarkReport): BenchmarkHighlights {
  const reframed = report.results.filter((result) => result.mode === "9:16");
  const median = (values: (number | null)[]) =>
    summarize(values.filter((value): value is number => value !== null)).p50;
  return {
    runs: report.results.length,
    reframedRuns: reframed.length,
    droppedFrames: sumKnown(report.results.map((result) => result.summary.frames.droppedFramesEstimate)),
    expectedFrames: sumKnown(report.results.map((result) => result.summary.frames.expectedFrames)),
    wasmP50MsByBuild: report.wasmBuildComparison.builds.map((build) => ({
      build,
      p50Ms: median(
        reframed
          .filter((result) => result.wasmBuild.variant === build)
          .map((result) => result.summary.detection.wasmMs.p50)
      ),
    })),
    detectionHz: median(reframed.map((result) => result.summary.detection.rateHz)),
  };
}
