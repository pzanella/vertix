import { useCallback, useRef, useState } from "react";
import {
  benchmarkReportToCsv,
  benchmarkSummaryRows,
  buildBenchmarkReport,
  buildSuitePlan,
  collectBenchmarkEnvironment,
  defaultWasmBuild,
  describeError,
  videoElementState,
  getActiveWasmBuild,
  isWasmSimdSupported,
  runBenchmarkClip,
  runSuiteSteps,
  runUnrecordedWarmup,
  switchWasmBuild,
  type BenchmarkConfig,
  type BenchmarkFailure,
  type BenchmarkReport,
  type LookaheadComparison,
  type SuiteOutcome,
  type SuiteStep,
  type SuiteStepRunner,
  type VertixEngine,
  type WasmBuildComparison,
} from "../core";
import { BENCHMARK_CLIPS } from "../components/Player/sampleClips";
import { SETTLE_BETWEEN_CLIPS_MS, baselineClipIndices } from "../components/Benchmark/benchmarkConfig";

export type BenchmarkStatus = "idle" | "running" | "done" | "cancelled" | "error";

/** Where a run currently is, for progress display. */
export interface BenchmarkStage {
  label: string;
  /** Zero-based position of this stage within the run. */
  index: number;
  total: number;
  /** Kind of every stage of the run, for the progress rail. */
  kinds: SuiteStep["kind"][];
  /** Set for the unrecorded warm-up, which stops after this many seconds instead of at the clip's end. */
  stopAtSec: number | null;
}

interface UseBenchmarkOptions {
  config: BenchmarkConfig;
  getEngine: () => VertixEngine | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  load: (src: string) => void;
}

interface UseBenchmarkReturn {
  status: BenchmarkStatus;
  /** Human-readable description of the step currently running. */
  step: string | null;
  stage: BenchmarkStage | null;
  report: BenchmarkReport | null;
  error: string | null;
  runSuite: () => void;
  runCurrentClip: () => void;
  cancel: () => void;
  downloadJson: () => void;
  downloadCsv: () => void;
}

/** One line for the UI: where and why the run stopped, and when the last detection came in. */
function failureSummary(failure: BenchmarkFailure): string {
  const where = [
    failure.step ? `step ${failure.step.index + 1}/${failure.step.total} (${failure.step.kind})` : null,
    failure.clip,
    failure.build ? `${failure.build} build` : null,
    failure.lookahead === null ? null : `lookahead ${failure.lookahead ? "on" : "off"}`,
  ]
    .filter(Boolean)
    .join(", ");
  const engine = failure.resources?.engine;
  const lastDetection =
    engine?.lastDetectionAtMs != null && failure.resources
      ? ` Last detection ${((failure.resources.atMs - engine.lastDetectionAtMs) / 1000).toFixed(1)} s before (media ${engine.lastDetectionMediaTimeSec?.toFixed(2)} s).`
      : " No detection since the last reset.";
  return `${failure.name}: ${failure.message}${where ? ` — ${where}.` : "."}${lastDetection}`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Benchmark cancelled", "AbortError"));
      },
      { once: true }
    );
  });
}

function downloadText(filename: string, text: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function fileStamp(report: BenchmarkReport): string {
  return report.environment.collectedAt.replace(/[:.]/g, "-");
}

function currentClipName(video: HTMLVideoElement): string {
  const src = video.currentSrc;
  if (!src || src.startsWith("blob:")) return "current source";
  return decodeURIComponent(new URL(src).pathname.split("/").pop() || src);
}

declare global {
  interface Window {
    /** Benchmark mode only: the last finished report, for inspection from DevTools. */
    vertixBenchmarkReport?: BenchmarkReport;
  }
}

/** The suite switches builds; afterwards the app goes back to the one it would pick on its own. */
function restoreDefaultWasmBuild() {
  const fallback = defaultWasmBuild();
  const active = getActiveWasmBuild();
  if (active.variant !== fallback.variant || active.reason !== fallback.reason) void switchWasmBuild(fallback);
}

function publishReport(report: BenchmarkReport) {
  window.vertixBenchmarkReport = report;
  console.info("[Vertix bench] environment", report.environment);
  console.table(benchmarkSummaryRows(report));
  if (report.precisionWarnings.length > 0) {
    console.warn("[Vertix bench] timings close to the timer resolution:");
    console.table(report.precisionWarnings);
  }
}

/** Runs benchmark suites against the app's engine and video element and keeps the last report. */
export function useBenchmark({ config, getEngine, videoRef, load }: UseBenchmarkOptions): UseBenchmarkReturn {
  const [status, setStatus] = useState<BenchmarkStatus>("idle");
  const [stage, setStage] = useState<BenchmarkStage | null>(null);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (
      comparison: WasmBuildComparison,
      lookaheadComparison: LookaheadComparison,
      steps: SuiteStep[],
      makeRunner: (engine: VertixEngine, video: HTMLVideoElement, signal: AbortSignal) => SuiteStepRunner
    ) => {
      const engine = getEngine();
      const video = videoRef.current;
      if (!engine || !video || abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("running");
      setError(null);
      setReport(null);

      // Collected before any playback: the timer-resolution probe busy-waits for a few ms.
      const environment = collectBenchmarkEnvironment();
      const outcome: SuiteOutcome = { results: [], failures: [] };
      // The user's switch (or null: the build default), restored after the suite.
      const lookaheadPreference = engine.getLookaheadPreference();
      const finish = (status: BenchmarkStatus) => {
        const finished = buildBenchmarkReport(
          config,
          environment,
          comparison,
          outcome.results,
          lookaheadComparison,
          outcome.failures
        );
        setReport(finished);
        setStatus(status);
        if (outcome.failures.length > 0) {
          console.error("[Vertix bench] failed steps", outcome.failures);
          setError(
            outcome.failures.length === 1
              ? failureSummary(outcome.failures[0])
              : `${outcome.failures.length} steps failed. First: ${failureSummary(outcome.failures[0])}`
          );
        }
        publishReport(finished);
      };
      try {
        await runSuiteSteps(steps, makeRunner(engine, video, controller.signal), outcome);
        finish(outcome.failures.length > 0 ? "error" : "done");
      } catch (err) {
        const cancelled = err instanceof DOMException && err.name === "AbortError";
        if (!cancelled) {
          outcome.failures.push({
            ...describeError(err),
            step: null,
            clip: null,
            build: null,
            lookahead: null,
            mode: null,
            failedAt: new Date().toISOString(),
            resources: await engine.getResourceStats().catch(() => null),
            video: videoElementState(video),
          });
        }
        finish(cancelled ? "cancelled" : "error");
      } finally {
        engine.setMode("9:16");
        engine.setLookaheadEnabled(lookaheadPreference);
        restoreDefaultWasmBuild();
        abortRef.current = null;
        setStage(null);
      }
    },
    [config, getEngine, videoRef]
  );

  const runSuite = useCallback(() => {
    const simdSupported = isWasmSimdSupported();
    const steps = buildSuitePlan(BENCHMARK_CLIPS.length, baselineClipIndices(config), simdSupported);
    const kinds = steps.map((step) => step.kind);
    const comparison: WasmBuildComparison = simdSupported
      ? { builds: ["simd", "scalar"], order: "alternating-per-clip", simdSkippedReason: null }
      : { builds: ["scalar"], order: null, simdSkippedReason: "not-supported" };

    void run(comparison, { order: "off-first-per-clip" }, steps, (engine, video, signal) => ({
      describe: (step, index, total) => {
        const clip = BENCHMARK_CLIPS[step.clipIndex];
        if (step.kind === "warmup") {
          return {
            step: {
              index,
              total,
              kind: step.kind,
              label: `Switch to the ${step.build.variant} build, warm-up (${config.wasmWarmupSec}s of ${clip.file}, not recorded)`,
            },
            clip: clip.file,
            build: step.build.variant,
            lookahead: true,
            mode: "9:16",
          };
        }
        const reframed = step.kind === "clip";
        const lookahead = reframed ? step.lookahead : true;
        const runOrder = reframed ? step.build.runOrder : null;
        return {
          step: {
            index,
            total,
            kind: step.kind,
            label: reframed
              ? `Clip ${step.clipIndex + 1}/${BENCHMARK_CLIPS.length}: ${clip.file} (9:16, ${step.build.variant} build, lookahead ${
                  lookahead ? "on" : "off"
                }${runOrder ? `, run ${runOrder.position}/${runOrder.sequence.length}` : ""})`
              : `Baseline: ${clip.file} (16:9, no detection)`,
          },
          clip: clip.file,
          build: reframed ? step.build.variant : getActiveWasmBuild().variant,
          lookahead,
          mode: reframed ? "9:16" : "16:9",
        };
      },
      onStep: (context) =>
        setStage({
          label: context.step.label,
          index: context.step.index,
          total: context.step.total,
          kinds,
          stopAtSec: context.step.kind === "warmup" ? config.wasmWarmupSec : null,
        }),
      warmup: async (step) => {
        const clip = BENCHMARK_CLIPS[step.clipIndex];
        await switchWasmBuild(step.build);
        await runUnrecordedWarmup(engine, video, {
          mode: "9:16",
          lookahead: true,
          loadSource: () => load(clip.url),
          seconds: config.wasmWarmupSec,
          signal,
        });
      },
      record: async (step, context) => {
        const clip = BENCHMARK_CLIPS[step.clipIndex];
        await delay(SETTLE_BETWEEN_CLIPS_MS, signal);
        return runBenchmarkClip(engine, video, {
          clipName: clip.file,
          mode: context.mode,
          nominalFps: clip.nominalFps,
          knownCutsSec: clip.knownCutsSec,
          stopAtSec: clip.stopAtSec,
          warmupSec: config.clipWarmupSec,
          lookahead: context.lookahead ?? true,
          loadSource: () => load(clip.url),
          wasmBuild: step.kind === "clip" ? step.build : { ...getActiveWasmBuild(), runOrder: null },
          signal,
        });
      },
      failureDetails: async () => ({
        resources: await engine.getResourceStats().catch(() => null),
        video: videoElementState(video),
      }),
    }));
  }, [config, load, run]);

  const runCurrentClip = useCallback(() => {
    const build = getActiveWasmBuild();
    const comparison: WasmBuildComparison = { builds: [build.variant], order: null, simdSkippedReason: null };
    const step: SuiteStep = { kind: "clip", clipIndex: -1, build: { ...build, runOrder: null }, lookahead: true };
    void run(comparison, { order: null }, [step], (engine, video, signal) => {
      const clipName = currentClipName(video);
      const sample = BENCHMARK_CLIPS.find((clip) => clip.file === clipName);
      return {
        describe: (_, index, total) => ({
          step: {
            index,
            total,
            kind: "clip",
            label: `${clipName} (9:16, ${build.variant} build, rewound and replayed)`,
          },
          clip: clipName,
          build: build.variant,
          lookahead: null,
          mode: "9:16",
        }),
        onStep: (context) =>
          setStage({ label: context.step.label, index: 0, total: 1, kinds: ["clip"], stopAtSec: null }),
        warmup: async () => {},
        record: () =>
          runBenchmarkClip(engine, video, {
            clipName,
            mode: "9:16",
            nominalFps: sample?.nominalFps ?? null,
            knownCutsSec: sample?.knownCutsSec,
            warmupSec: config.clipWarmupSec,
            wasmBuild: { ...build, runOrder: null },
            signal,
          }),
        failureDetails: async () => ({
          resources: await engine.getResourceStats().catch(() => null),
          video: videoElementState(video),
        }),
      };
    });
  }, [config, run]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const downloadJson = useCallback(() => {
    if (!report) return;
    downloadText(`vertix-bench-${fileStamp(report)}.json`, JSON.stringify(report, null, 2), "application/json");
  }, [report]);

  const downloadCsv = useCallback(() => {
    if (!report) return;
    downloadText(`vertix-bench-${fileStamp(report)}.csv`, benchmarkReportToCsv(report), "text/csv");
  }, [report]);

  return {
    status,
    step: stage?.label ?? null,
    stage,
    report,
    error,
    runSuite,
    runCurrentClip,
    cancel,
    downloadJson,
    downloadCsv,
  };
}
