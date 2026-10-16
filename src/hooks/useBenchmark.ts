import { useCallback, useRef, useState } from "react";
import {
  BenchmarkRunError,
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
  runUnrecordedWarmup,
  switchWasmBuild,
  type BenchmarkClipResult,
  type BenchmarkConfig,
  type BenchmarkFailure,
  type BenchmarkReport,
  type LookaheadComparison,
  type SuiteStep,
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

/** The step a run is on, so a failure can say where it happened. */
interface StepContext {
  step: BenchmarkFailure["step"];
  clip: string | null;
  build: string | null;
  lookahead: boolean | null;
  mode: BenchmarkFailure["mode"];
}

const NO_STEP: StepContext = { step: null, clip: null, build: null, lookahead: null, mode: null };

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
      plan: (
        engine: VertixEngine,
        video: HTMLVideoElement,
        signal: AbortSignal,
        results: BenchmarkClipResult[],
        enterStep: (context: StepContext) => void
      ) => Promise<void>
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
      const results: BenchmarkClipResult[] = [];
      // The user's switch (or null: the build default), restored after the suite.
      const lookaheadPreference = engine.getLookaheadPreference();
      let context = NO_STEP;
      const enterStep = (next: StepContext) => {
        context = next;
      };
      try {
        await plan(engine, video, controller.signal, results, enterStep);
        const finished = buildBenchmarkReport(config, environment, comparison, results, lookaheadComparison);
        setReport(finished);
        setStatus("done");
        publishReport(finished);
      } catch (err) {
        const cancelled = err instanceof DOMException && err.name === "AbortError";
        setStatus(cancelled ? "cancelled" : "error");
        let failure: BenchmarkFailure | null = null;
        if (!cancelled) {
          failure =
            err instanceof BenchmarkRunError
              ? { ...err.failure, step: context.step }
              : {
                  ...describeError(err),
                  ...context,
                  failedAt: new Date().toISOString(),
                  resources: await engine.getResourceStats().catch(() => null),
                  video: videoElementState(video),
                };
          if (err instanceof BenchmarkRunError && err.partial) results.push({ ...err.partial, failure });
          console.error("[Vertix bench] run failed", failure);
          setError(failureSummary(failure));
        }
        if (results.length > 0 || failure) {
          const partial = buildBenchmarkReport(config, environment, comparison, results, lookaheadComparison, failure);
          setReport(partial);
          window.vertixBenchmarkReport = partial;
        }
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

    void run(comparison, { order: "off-first-per-clip" }, async (engine, video, signal, results, enterStep) => {
      for (const [index, step] of steps.entries()) {
        const clip = BENCHMARK_CLIPS[step.clipIndex];
        const loadSource = () => load(clip.url);

        if (step.kind === "warmup") {
          const label = `Switch to the ${step.build.variant} build, warm-up (${config.wasmWarmupSec}s of ${clip.file}, not recorded)`;
          enterStep({
            step: { index, total: steps.length, kind: step.kind, label },
            clip: clip.file,
            build: step.build.variant,
            lookahead: true,
            mode: "9:16",
          });
          setStage({ label, index, total: steps.length, kinds, stopAtSec: config.wasmWarmupSec });
          await switchWasmBuild(step.build);
          await runUnrecordedWarmup(engine, video, {
            mode: "9:16",
            lookahead: true,
            loadSource,
            seconds: config.wasmWarmupSec,
            signal,
          });
          continue;
        }

        await delay(SETTLE_BETWEEN_CLIPS_MS, signal);
        const reframed = step.kind === "clip";
        const runOrder = reframed ? step.build.runOrder : null;
        const lookahead = reframed ? step.lookahead : true;
        const label = reframed
          ? `Clip ${step.clipIndex + 1}/${BENCHMARK_CLIPS.length}: ${clip.file} (9:16, ${step.build.variant} build, lookahead ${
              lookahead ? "on" : "off"
            }${runOrder ? `, run ${runOrder.position}/${runOrder.sequence.length}` : ""})`
          : `Baseline: ${clip.file} (16:9, no detection)`;
        enterStep({
          step: { index, total: steps.length, kind: step.kind, label },
          clip: clip.file,
          build: reframed ? step.build.variant : getActiveWasmBuild().variant,
          lookahead,
          mode: reframed ? "9:16" : "16:9",
        });
        setStage({ label, index, total: steps.length, kinds, stopAtSec: null });
        results.push(
          await runBenchmarkClip(engine, video, {
            clipName: clip.file,
            mode: reframed ? "9:16" : "16:9",
            nominalFps: clip.nominalFps,
            knownCutsSec: clip.knownCutsSec,
            stopAtSec: clip.stopAtSec,
            warmupSec: config.clipWarmupSec,
            lookahead,
            loadSource,
            wasmBuild: reframed ? step.build : { ...getActiveWasmBuild(), runOrder: null },
            signal,
          })
        );
      }
    });
  }, [config, load, run]);

  const runCurrentClip = useCallback(() => {
    const build = getActiveWasmBuild();
    const comparison: WasmBuildComparison = { builds: [build.variant], order: null, simdSkippedReason: null };
    void run(comparison, { order: null }, async (engine, video, signal, results) => {
      const clipName = currentClipName(video);
      const sample = BENCHMARK_CLIPS.find((clip) => clip.file === clipName);
      setStage({
        label: `${clipName} (9:16, ${build.variant} build, rewound and replayed)`,
        index: 0,
        total: 1,
        kinds: ["clip"],
        stopAtSec: null,
      });
      results.push(
        await runBenchmarkClip(engine, video, {
          clipName,
          mode: "9:16",
          nominalFps: sample?.nominalFps ?? null,
          knownCutsSec: sample?.knownCutsSec,
          warmupSec: config.clipWarmupSec,
          wasmBuild: { ...build, runOrder: null },
          signal,
        })
      );
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
