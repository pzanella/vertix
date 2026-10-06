import { useCallback, useRef, useState } from "react";
import {
  benchmarkReportToCsv,
  benchmarkSummaryRows,
  buildBenchmarkReport,
  collectBenchmarkEnvironment,
  runBenchmarkClip,
  runUnrecordedWarmup,
  type BenchmarkClipResult,
  type BenchmarkConfig,
  type BenchmarkReport,
  type VertixEngine,
} from "../core";
import { SAMPLE_CLIPS, sampleClipUrl } from "../components/Player/sampleClips";

export type BenchmarkStatus = "idle" | "running" | "done" | "cancelled" | "error";

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
  report: BenchmarkReport | null;
  error: string | null;
  runSuite: () => void;
  runCurrentClip: () => void;
  cancel: () => void;
  downloadJson: () => void;
  downloadCsv: () => void;
}

// Idle gap between clips so teardown of the previous source (decoder,
// Shaka, GC) does not land inside the next clip's measurements.
const SETTLE_BETWEEN_CLIPS_MS = 1000;

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
  const [step, setStep] = useState<string | null>(null);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (
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
        const finished = buildBenchmarkReport(config, environment, results);
        setReport(finished);
        setStatus("done");
        publishReport(finished);
      } catch (err) {
        const cancelled = err instanceof DOMException && err.name === "AbortError";
        setStatus(cancelled ? "cancelled" : "error");
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        if (results.length > 0) setReport(buildBenchmarkReport(config, environment, results));
      } finally {
        engine.setMode("9:16");
        abortRef.current = null;
        setStep(null);
      }
    },
    [config, getEngine, videoRef]
  );

  const runSuite = useCallback(() => {
    void run(async (engine, video, signal, results) => {
      const [firstClip] = SAMPLE_CLIPS;
      const loadClip = (file: string) => () => load(sampleClipUrl(file));

      setStep(`WASM warm-up (${config.wasmWarmupSec}s of ${firstClip.file}, not recorded)`);
      await runUnrecordedWarmup(engine, video, {
        mode: "9:16",
        loadSource: loadClip(firstClip.file),
        seconds: config.wasmWarmupSec,
        signal,
      });

      for (const [index, clip] of SAMPLE_CLIPS.entries()) {
        await delay(SETTLE_BETWEEN_CLIPS_MS, signal);
        setStep(`Clip ${index + 1}/${SAMPLE_CLIPS.length}: ${clip.file} (9:16)`);
        results.push(
          await runBenchmarkClip(engine, video, {
            clipName: clip.file,
            mode: "9:16",
            nominalFps: clip.nominalFps,
            warmupSec: config.clipWarmupSec,
            loadSource: loadClip(clip.file),
            signal,
          })
        );
      }

      if (config.baseline) {
        await delay(SETTLE_BETWEEN_CLIPS_MS, signal);
        setStep(`Baseline: ${firstClip.file} (16:9, no detection)`);
        results.push(
          await runBenchmarkClip(engine, video, {
            clipName: firstClip.file,
            mode: "16:9",
            nominalFps: firstClip.nominalFps,
            warmupSec: config.clipWarmupSec,
            loadSource: loadClip(firstClip.file),
            signal,
          })
        );
      }
    });
  }, [config, load, run]);

  const runCurrentClip = useCallback(() => {
    void run(async (engine, video, signal, results) => {
      const clipName = currentClipName(video);
      const sample = SAMPLE_CLIPS.find((clip) => clip.file === clipName);
      setStep(`${clipName} (9:16, rewound and replayed)`);
      results.push(
        await runBenchmarkClip(engine, video, {
          clipName,
          mode: "9:16",
          nominalFps: sample?.nominalFps ?? null,
          warmupSec: config.clipWarmupSec,
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

  return { status, step, report, error, runSuite, runCurrentClip, cancel, downloadJson, downloadCsv };
}
