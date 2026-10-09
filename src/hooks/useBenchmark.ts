import { useCallback, useRef, useState } from "react";
import {
  benchmarkReportToCsv,
  benchmarkSummaryRows,
  buildBenchmarkReport,
  buildSuitePlan,
  collectBenchmarkEnvironment,
  defaultWasmBuild,
  getActiveWasmBuild,
  isWasmSimdSupported,
  runBenchmarkClip,
  runUnrecordedWarmup,
  switchWasmBuild,
  type BenchmarkClipResult,
  type BenchmarkConfig,
  type BenchmarkReport,
  type SuiteStep,
  type VertixEngine,
  type WasmBuildComparison,
} from "../core";
import { SAMPLE_CLIPS, sampleClipUrl } from "../components/Player/sampleClips";
import { SETTLE_BETWEEN_CLIPS_MS } from "../components/Benchmark/benchmarkConfig";

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
      plan: (
        engine: VertixEngine,
        video: HTMLVideoElement,
        signal: AbortSignal,
        results: BenchmarkClipResult[]
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
      try {
        await plan(engine, video, controller.signal, results);
        const finished = buildBenchmarkReport(config, environment, comparison, results);
        setReport(finished);
        setStatus("done");
        publishReport(finished);
      } catch (err) {
        const cancelled = err instanceof DOMException && err.name === "AbortError";
        setStatus(cancelled ? "cancelled" : "error");
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        if (results.length > 0) setReport(buildBenchmarkReport(config, environment, comparison, results));
      } finally {
        engine.setMode("9:16");
        restoreDefaultWasmBuild();
        abortRef.current = null;
        setStage(null);
      }
    },
    [config, getEngine, videoRef]
  );

  const runSuite = useCallback(() => {
    const simdSupported = isWasmSimdSupported();
    const steps = buildSuitePlan(SAMPLE_CLIPS.length, config.baseline, simdSupported);
    const kinds = steps.map((step) => step.kind);
    const comparison: WasmBuildComparison = simdSupported
      ? { builds: ["simd", "scalar"], order: "alternating-per-clip", simdSkippedReason: null }
      : { builds: ["scalar"], order: null, simdSkippedReason: "not-supported" };

    void run(comparison, async (engine, video, signal, results) => {
      for (const [index, step] of steps.entries()) {
        const clip = SAMPLE_CLIPS[step.clipIndex];
        const loadSource = () => load(sampleClipUrl(clip.file));

        if (step.kind === "warmup") {
          setStage({
            label: `Switch to the ${step.build.variant} build, warm-up (${config.wasmWarmupSec}s of ${clip.file}, not recorded)`,
            index,
            total: steps.length,
            kinds,
            stopAtSec: config.wasmWarmupSec,
          });
          await switchWasmBuild(step.build);
          await runUnrecordedWarmup(engine, video, { mode: "9:16", loadSource, seconds: config.wasmWarmupSec, signal });
          continue;
        }

        await delay(SETTLE_BETWEEN_CLIPS_MS, signal);
        const reframed = step.kind === "clip";
        const runOrder = reframed ? step.build.runOrder : null;
        setStage({
          label: reframed
            ? `Clip ${step.clipIndex + 1}/${SAMPLE_CLIPS.length}: ${clip.file} (9:16, ${step.build.variant} build${
                runOrder ? `, run ${runOrder.position}/${runOrder.sequence.length}` : ""
              })`
            : `Baseline: ${clip.file} (16:9, no detection)`,
          index,
          total: steps.length,
          kinds,
          stopAtSec: null,
        });
        results.push(
          await runBenchmarkClip(engine, video, {
            clipName: clip.file,
            mode: reframed ? "9:16" : "16:9",
            nominalFps: clip.nominalFps,
            warmupSec: config.clipWarmupSec,
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
    void run(comparison, async (engine, video, signal, results) => {
      const clipName = currentClipName(video);
      const sample = SAMPLE_CLIPS.find((clip) => clip.file === clipName);
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
