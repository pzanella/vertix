import type { VertixEngine, VertixMode } from "../VertixEngine";
import { BenchmarkRecorder, type BenchmarkClipResult, type BenchmarkLookahead } from "./BenchmarkRecorder";
import type { BenchmarkWasmBuild } from "./suitePlan";
import { describeError, videoElementState, type BenchmarkFailure, type ResourceSnapshot } from "./resourceStats";

/**
 * A run that stopped with an error. `failure` says why; `partial` is what
 * was recorded until then (null if recording had not started).
 */
export class BenchmarkRunError extends Error {
  constructor(
    readonly failure: BenchmarkFailure,
    readonly partial: BenchmarkClipResult | null,
    readonly original: unknown
  ) {
    super(failure.message);
    this.name = failure.name;
  }
}

/** Never lets a diagnostics failure become the run's failure. */
async function resourceSnapshot(engine: VertixEngine): Promise<ResourceSnapshot | null> {
  try {
    return await engine.getResourceStats();
  } catch {
    return null;
  }
}

export interface ClipPlaybackOptions {
  mode: VertixMode;
  /** Switches lookahead on or off before the clip starts; left as it is when omitted. */
  lookahead?: boolean;
  /**
   * Loads a new source into the video and starts playback (the host's own
   * loader, e.g. a Shaka-based one). When omitted, the source already in the
   * video is rewound to 0 and played again.
   */
  loadSource?: () => void;
  signal?: AbortSignal;
}

/**
 * Host measurements recorded alongside a run (e.g. a demo overlay). The
 * engine knows nothing about them: the runner calls start() when recording
 * starts and stores what finish() returns under `key` in the result's
 * `extensions` (schema v7).
 */
export interface BenchmarkClipExtension {
  key: string;
  start(context: { warmupSec: number }): void;
  /** The block for this run, or null to leave it out. */
  finish(): Promise<unknown>;
}

export interface BenchmarkClipOptions extends ClipPlaybackOptions {
  clipName: string;
  nominalFps: number | null;
  warmupSec: number;
  wasmBuild: BenchmarkWasmBuild;
  /** Real hard cuts of the clip, when known (test clips), for frames-late per cut. */
  knownCutsSec?: readonly number[];
  /** Stops playback at this media time instead of at the end (long streams). */
  stopAtSec?: number;
  extension?: BenchmarkClipExtension | null;
}

// A clip that has not ended after duration × this (+ grace) is treated as stuck.
const TIMEOUT_DURATION_FACTOR = 3;
const TIMEOUT_GRACE_SEC = 30;
const FALLBACK_DURATION_SEC = 600;
// A source that has not loaded (no loadedmetadata, or no seek back to 0)
// within this long fails the run instead of waiting forever.
export const SOURCE_LOAD_TIMEOUT_MS = 30_000;

function abortError(): DOMException {
  return new DOMException("Benchmark cancelled", "AbortError");
}

interface PlaybackHandlers {
  /** Called once the source is loaded and positioned at its start, before the first frame plays. */
  onReady: () => void;
  /** Called on every timeupdate; return true to stop playback early and resolve. */
  shouldStop?: () => boolean;
}

/** Plays a clip from its start until `ended` (or until `shouldStop`), resolving once it stops. */
function playClip(
  engine: VertixEngine,
  video: HTMLVideoElement,
  options: ClipPlaybackOptions,
  handlers: PlaybackHandlers
) {
  return new Promise<void>((resolve, reject) => {
    const { signal, loadSource } = options;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(loadTimeout);
      video.removeEventListener("loadedmetadata", onSourceReady);
      video.removeEventListener("seeked", onRewound);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const succeed = () => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      cleanup();
      video.pause();
      reject(error);
    };
    const loadTimeout = setTimeout(
      () => fail(new Error(`Source did not load within ${SOURCE_LOAD_TIMEOUT_MS / 1000} s`)),
      SOURCE_LOAD_TIMEOUT_MS
    );
    const armTimeout = () => {
      const durationSec = Number.isFinite(video.duration) ? video.duration : FALLBACK_DURATION_SEC;
      const timeoutMs = (durationSec * TIMEOUT_DURATION_FACTOR + TIMEOUT_GRACE_SEC) * 1000;
      timeout = setTimeout(() => fail(new Error("Benchmark clip did not finish in time")), timeoutMs);
    };
    const onSourceReady = () => {
      clearTimeout(loadTimeout);
      handlers.onReady();
      armTimeout();
    };
    const onRewound = () => {
      onSourceReady();
      video
        .play()
        .catch(() => {
          video.muted = true;
          return video.play();
        })
        .catch(fail);
    };
    const onTimeUpdate = () => {
      if (handlers.shouldStop?.()) {
        video.pause();
        succeed();
      }
    };
    const onEnded = () => succeed();
    const onError = () => fail(new Error("Video error during benchmark"));
    const onAbort = () => fail(abortError());

    engine.setMode(options.mode);
    if (options.lookahead !== undefined) engine.setLookaheadEnabled(options.lookahead);

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort);

    if (loadSource) {
      // loadedmetadata fires before the host's autoplay resolves, so the
      // recorder is attached before the first frame is rendered.
      video.addEventListener("loadedmetadata", onSourceReady, { once: true });
      loadSource();
    } else {
      video.pause();
      video.addEventListener("seeked", onRewound, { once: true });
      video.currentTime = 0;
    }
  });
}

/**
 * Plays the first `seconds` of a clip without recording anything — warms up
 * the WASM module, the detection worker and the JIT before measured runs.
 */
export async function runUnrecordedWarmup(
  engine: VertixEngine,
  video: HTMLVideoElement,
  options: ClipPlaybackOptions & { seconds: number }
): Promise<void> {
  if (options.seconds <= 0) return;
  await playClip(engine, video, options, {
    onReady: () => {},
    shouldStop: () => video.currentTime >= options.seconds,
  });
}

/** Plays one clip from start to end at normal speed and records it. */
export async function runBenchmarkClip(
  engine: VertixEngine,
  video: HTMLVideoElement,
  options: BenchmarkClipOptions
): Promise<BenchmarkClipResult> {
  let recorder: BenchmarkRecorder | null = null;
  let lookahead: BenchmarkLookahead | undefined;
  let pageHidden = document.visibilityState !== "visible";
  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") pageHidden = true;
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const start = await resourceSnapshot(engine);
  try {
    await playClip(engine, video, options, {
      onReady: () => {
        recorder = new BenchmarkRecorder({
          clipName: options.clipName,
          video,
          warmupSec: options.warmupSec,
          nominalFps: options.nominalFps,
          knownCutsSec: options.knownCutsSec,
        });
        engine.setBenchmarkProbe(recorder);
        options.extension?.start({ warmupSec: options.warmupSec });
      },
      shouldStop: options.stopAtSec !== undefined ? () => video.currentTime >= options.stopAtSec! : undefined,
    });
    // Read before the next clip loads: buffer counters reset per source.
    lookahead = lookaheadSnapshot(engine);
    const health = engine.getDetectionHealth();
    if (options.mode === "9:16" && health.state === "stopped")
      throw new Error(health.message ?? "Face detection stopped");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      (recorder as BenchmarkRecorder | null)?.finish(options.mode);
      throw error;
    }
    const end = await resourceSnapshot(engine);
    const failure: BenchmarkFailure = {
      ...describeError(error),
      step: null,
      clip: options.clipName,
      build: options.wasmBuild.variant,
      lookahead: options.lookahead ?? null,
      mode: options.mode,
      failedAt: new Date().toISOString(),
      resources: end,
      video: videoElementState(video),
    };
    const stopped = recorder as BenchmarkRecorder | null;
    const partial: BenchmarkClipResult | null = stopped
      ? {
          ...stopped.finish(options.mode),
          pageHiddenDuringRun: pageHidden,
          wasmBuild: options.wasmBuild,
          lookahead: lookaheadSnapshot(engine),
          resources: { start, end },
          failure,
        }
      : null;
    throw new BenchmarkRunError(failure, partial, error);
  } finally {
    engine.setBenchmarkProbe(null);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  const finished = recorder as BenchmarkRecorder | null;
  if (!finished) throw new Error("Benchmark clip ended before it started");
  const recording = finished.finish(options.mode);
  const extensionBlock = options.extension ? await extensionResult(options.extension) : null;
  return {
    ...recording,
    pageHiddenDuringRun: pageHidden,
    wasmBuild: options.wasmBuild,
    lookahead: lookahead ?? lookaheadSnapshot(engine),
    resources: { start, end: await resourceSnapshot(engine) },
    ...(extensionBlock !== null ? { extensions: { [options.extension!.key]: extensionBlock } } : {}),
  };
}

/** Never lets a host extension's failure become the run's failure. */
async function extensionResult(extension: BenchmarkClipExtension): Promise<unknown> {
  try {
    return (await extension.finish()) ?? null;
  } catch (error) {
    return { error: describeError(error).message };
  }
}

function lookaheadSnapshot(engine: VertixEngine): BenchmarkLookahead {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { bufferedFrames, ...lookahead } = engine.getLookaheadStatus();
  return lookahead;
}
