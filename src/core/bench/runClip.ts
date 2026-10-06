import type { VertixEngine, VertixMode } from "../VertixEngine";
import { BenchmarkRecorder, type BenchmarkClipResult } from "./BenchmarkRecorder";

export interface ClipPlaybackOptions {
  mode: VertixMode;
  /**
   * Loads a new source into the video and starts playback (the host's own
   * loader, e.g. a Shaka-based one). When omitted, the source already in the
   * video is rewound to 0 and played again.
   */
  loadSource?: () => void;
  signal?: AbortSignal;
}

export interface BenchmarkClipOptions extends ClipPlaybackOptions {
  clipName: string;
  nominalFps: number | null;
  warmupSec: number;
}

// A clip that has not ended after duration × this (+ grace) is treated as stuck.
const TIMEOUT_DURATION_FACTOR = 3;
const TIMEOUT_GRACE_SEC = 30;
const FALLBACK_DURATION_SEC = 600;

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
    const armTimeout = () => {
      const durationSec = Number.isFinite(video.duration) ? video.duration : FALLBACK_DURATION_SEC;
      const timeoutMs = (durationSec * TIMEOUT_DURATION_FACTOR + TIMEOUT_GRACE_SEC) * 1000;
      timeout = setTimeout(() => fail(new Error("Benchmark clip did not finish in time")), timeoutMs);
    };
    const onSourceReady = () => {
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
  try {
    await playClip(engine, video, options, {
      onReady: () => {
        recorder = new BenchmarkRecorder({
          clipName: options.clipName,
          video,
          warmupSec: options.warmupSec,
          nominalFps: options.nominalFps,
        });
        engine.setBenchmarkProbe(recorder);
      },
    });
  } catch (error) {
    (recorder as BenchmarkRecorder | null)?.finish(options.mode);
    throw error;
  } finally {
    engine.setBenchmarkProbe(null);
  }
  const finished = recorder as BenchmarkRecorder | null;
  if (!finished) throw new Error("Benchmark clip ended before it started");
  return finished.finish(options.mode);
}
