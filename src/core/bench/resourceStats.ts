/** Workers of one kind: created since the page loaded, and still running. */
export interface WorkerCount {
  created: number;
  live: number;
}

/**
 * What the engine holds at one moment, for finding something that builds
 * up across runs or WASM build switches (benchmark diagnostics).
 */
export interface ResourceSnapshot {
  /** performance.now() when taken. */
  atMs: number;
  workers: {
    detection: WorkerCount;
    cutTrigger: WorkerCount;
  };
  /** WASM linear memory, in bytes: the detection worker's (null when it did not answer), and each build loaded on the main thread (fallback). */
  wasmMemoryBytes: {
    detectionWorker: number | null;
    mainThread: Partial<Record<"simd" | "scalar", number>>;
  };
  /** performance.memory (Chromium only), else null. */
  jsHeap: { usedBytes: number; totalBytes: number; limitBytes: number } | null;
  engine: {
    detectionInFlight: boolean;
    pendingDetections: number;
    queuedDecisions: number;
    tracks: number;
    frameBufferSlots: number;
    frameBufferBytes: number;
    /** Media time of the last detection result, or null. */
    lastDetectionMediaTimeSec: number | null;
    /** performance.now() of the last detection result, or null. */
    lastDetectionAtMs: number | null;
  };
}

interface PerformanceWithMemory extends Performance {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
}

export function jsHeapSnapshot(): ResourceSnapshot["jsHeap"] {
  const memory = (performance as PerformanceWithMemory).memory;
  return memory
    ? { usedBytes: memory.usedJSHeapSize, totalBytes: memory.totalJSHeapSize, limitBytes: memory.jsHeapSizeLimit }
    : null;
}

/** The video element at the moment of a failure. */
export interface VideoElementState {
  currentTimeSec: number;
  durationSec: number;
  readyState: number;
  networkState: number;
  paused: boolean;
  ended: boolean;
  /** MediaError code and message, when the element reports one. */
  errorCode: number | null;
  errorMessage: string | null;
}

export function videoElementState(video: HTMLVideoElement): VideoElementState {
  return {
    currentTimeSec: video.currentTime,
    durationSec: video.duration,
    readyState: video.readyState,
    networkState: video.networkState,
    paused: video.paused,
    ended: video.ended,
    errorCode: video.error?.code ?? null,
    errorMessage: video.error?.message || null,
  };
}

/** Why a run or the suite stopped (schema v6). */
export interface BenchmarkFailure {
  name: string;
  message: string;
  stack: string | null;
  /** The suite step that failed, when known. */
  step: { index: number; total: number; kind: string; label: string } | null;
  clip: string | null;
  build: string | null;
  lookahead: boolean | null;
  mode: "9:16" | "16:9" | null;
  failedAt: string;
  /** Includes the last detection's media time and wall time (engine.lastDetection*). */
  resources: ResourceSnapshot | null;
  video: VideoElementState | null;
}

/** Plain fields of any thrown value. */
export function describeError(error: unknown): Pick<BenchmarkFailure, "name" | "message" | "stack"> {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack ?? null };
  return { name: "Error", message: String(error), stack: null };
}
