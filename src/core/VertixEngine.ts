import { AudioActivityMonitor } from "./audioActivity";
import { ActiveSpeakerResolver, PersonCountDebouncer } from "./speakerTracking";
import {
  computeSpeakerLayout,
  faceVisibleFraction,
  lerpPaneRectInto,
  paneSmoothingAlpha,
  NO_SCENE_CUT,
  unpackDetections,
  unpackSceneCutScores,
  type FaceBox,
  type PaneRect,
  type PaneTarget,
  type SceneCutScores,
} from "./layoutEngine";
import type { BenchmarkProbe } from "./bench/BenchmarkRecorder";
import {
  defaultWasmBuild,
  importWasmBindings,
  type WasmBindings,
  type WasmBuildSelection,
  type WasmBuildVariant,
} from "./wasmBuild";

/**
 * Vertix's headless reframe engine — face detection (WASM/ONNX), the
 * multi-speaker layout decision, and the canvas render loop, with zero
 * dependency on React or any other UI framework.
 *
 * Usage: `const engine = new VertixEngine(); engine.attach(video, canvas);`
 * — `video` can be any already-configured `HTMLVideoElement`, including one
 * owned by a media framework (Shaka Player, hls.js, Video.js, ...). The
 * engine only ever *reads* from it (`requestVideoFrameCallback`) and
 * listens to its native `play`/`seeking`/`loadedmetadata` events — it never
 * sets `.src`, calls `.play()`/`.pause()`, or otherwise takes over playback
 * control, so it doesn't fight whatever already owns the element. See
 * `docs/player-integration.md` for a worked integration example.
 */

export type VertixMode = "16:9" | "9:16";

export interface VertixMeta {
  width: number;
  height: number;
  cropWidth: number;
  cropHeight: number;
}

export interface VertixMetrics {
  /** requestVideoFrameCallback calls per second: 1000 / (interval between consecutive callbacks' `now`), EMA-smoothed (alpha 0.15). Not the source frame rate, and not render cost. */
  fps: number;
  /** Interval between consecutive requestVideoFrameCallback calls, in ms, EMA-smoothed (alpha 0.15). Not render latency: it reads ~40ms at 25fps however cheap rendering is. */
  frameTimeMs: number;
  /** Bounding-box size (% of frame, max of width/height) of each current valid speaker face. */
  faceSizes: number[];
  /** Average of (source height / pane crop height) across active panes — how many times "zoomed in" the crop is. Null when there's no crop (B-roll/16:9). */
  cropScaleFactor: number | null;
  /** Highest current per-face mouth-motion score among valid speakers — a raw activity level, not a calibrated probability. Null with no valid faces. */
  motionScore: number | null;
  /** Average detector confidence (0-1) across current valid faces. Already thresholded upstream, so stays in a fairly narrow high band. Null with no valid faces. */
  faceConfidence: number | null;
  /** Whether the audio-activity monitor could read real samples from this source at all — false for every bundled sample clip (no audio track) and for some cross-origin sources without CORS headers. Independent of whether anyone's currently talking. */
  audioAvailable: boolean;
  /** Current voice-activity energy (0-1 RMS) from the audio track, or null when audioAvailable is false. Only meaningful once ACTIVE_SPEAKER_THRESHOLD (3) or more raw faces are detected. */
  audioEnergy: number | null;
  /** performance.now() timestamp the current layout was committed at, for computing "stable for Ns" live. */
  layoutCommittedAt: number | null;
  /** How many times the layout has actually changed this session. */
  sceneSwitchCount: number;
  /** Hard cuts in the source video detected since this source was loaded (seeks don't reset it). 9:16 mode only. */
  sceneCutCount: number;
  /** Recent samples (oldest first) for trend charts — roughly the last 10-15s, sampling rate varies per metric. */
  fpsHistory: number[];
  frameTimeHistory: number[];
  motionHistory: number[];
  confidenceHistory: number[];
  /** Detections the WASM skin-tone filter rejected since this source was loaded (seeks don't reset it). For judging that filter, not used by the layout. */
  skinRejectedTotal: number;
  /** The part of skinRejectedTotal that would also have passed the size/visibility filter — the ones that could have been a real speaker. */
  skinRejectedSpeakerSized: number;
  /** Completed detections per media-time second, EMA-smoothed (alpha 0.2). Lower than fps / 5 when detections are skipped because the previous one is still running. Null before the second detection. */
  detectionRateHz: number | null;
  /** Whether the last detection tick ran in the shared worker or fell back to the main thread. Null before the first tick. */
  detectionMode: "worker" | "main-thread" | null;
  /** How long the last detection call itself took (WASM inference only, not the surrounding postMessage/bitmap overhead), in ms. Null before the first tick. */
  workerInferenceMs: number | null;
  workerInferenceHistory: number[];
  /** Whether this browser supports the Long Tasks API (Chromium-only as of writing) — the main-thread-stall numbers below are meaningless if this is false. */
  longTasksSupported: boolean;
  /** Total main-thread time (ms) spent in tasks over 50ms, in the last few seconds. */
  longTaskMs: number;
  longTaskHistory: number[];
}

export interface VertixState {
  wasmReady: boolean;
  mode: VertixMode;
  meta: VertixMeta | null;
  /** Number of valid (large-enough, unclipped) speakers in the current committed layout — 0 means B-roll/no-crop. */
  speakerCount: number;
  /** Whether a layout cross-dissolve is currently in progress. */
  isTransitioning: boolean;
}

// Exported so useWasmReframe.ts's own pre-attach placeholder state matches
// this exactly, instead of keeping a second copy that has to be updated by
// hand every time a metric is added here (the old failure mode: a new
// field forgotten in one of the two spots).
export const INITIAL_METRICS: VertixMetrics = {
  fps: 0,
  frameTimeMs: 0,
  faceSizes: [],
  cropScaleFactor: null,
  motionScore: null,
  faceConfidence: null,
  audioAvailable: false,
  audioEnergy: null,
  layoutCommittedAt: null,
  sceneSwitchCount: 0,
  sceneCutCount: 0,
  fpsHistory: [],
  frameTimeHistory: [],
  motionHistory: [],
  confidenceHistory: [],
  skinRejectedTotal: 0,
  skinRejectedSpeakerSized: 0,
  detectionRateHz: null,
  detectionMode: null,
  workerInferenceMs: null,
  workerInferenceHistory: [],
  longTasksSupported: false,
  longTaskMs: 0,
  longTaskHistory: [],
};

// Cap on trend-chart history length — at this round's sampling rates (a
// detection tick every ~250-350ms, an FPS sample every 300ms) this holds
// roughly 10-15 seconds per metric.
const HISTORY_MAX_SAMPLES = 50;

function appendCapped(arr: number[], value: number): number[] {
  const next = arr.length >= HISTORY_MAX_SAMPLES ? arr.slice(arr.length - HISTORY_MAX_SAMPLES + 1) : arr.slice();
  next.push(value);
  return next;
}

// How far back to sum blocked main-thread time for the "Main Thread"
// dashboard reading — long enough to smooth out one-off spikes, short
// enough to still feel live.
const LONG_TASK_WINDOW_MS = 3000;

/** Cubic ease-in-out (gentle start, gentle finish) — shapes the layout cross-dissolve so it reads as a smooth reveal, not a snap. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Detection frame size — a plain stretch fill (not letterboxed), so a
// detected face's position maps directly onto the same fraction of the
// source frame.
const FACE_W = 320;
const FACE_H = 240;
// Detection doesn't run on every frame, only every Nth one — rendering and
// pane smoothing still do.
const FACE_DETECT_INTERVAL = 5;
// How long to wait for the detection worker to report ready before giving
// up and falling back to running WASM on the main thread instead.
const WORKER_READY_TIMEOUT_MS = 4000;

// --- Shared detection worker ------------------------------------------
// One worker for the whole page rather than one per VertixEngine instance.
// Two instances racing to create their own worker at the same time used to
// leave one of them stuck forever with no error — going through this
// single shared instance avoids that regardless of how many engines end up
// constructed (React StrictMode always creates at least two in dev).
let sharedWorker: Worker | null = null;
let sharedWorkerReady = false;
// True while a worker is starting up. Detection ticks are skipped then
// instead of falling back to the main thread, which would download the
// other copy of the .wasm binary for nothing.
let sharedWorkerLoading = false;
let sharedWorkerLoadPromise: Promise<boolean> | null = null;
let disposeSharedWorker: (() => void) | null = null;
let nextDetectionRequestId = 0;

interface PendingDetection {
  onResult: (facesFlat: Float64Array, cutScoresFlat: Float64Array, tookMs: number, readbackMs: number) => void;
  /** Called instead of onResult when the worker is replaced before it answers. */
  onCancel: () => void;
}
const pendingDetections = new Map<number, PendingDetection>();

let activeWasmBuild: WasmBuildSelection | null = null;

/** The WASM build the worker and the main-thread fallback load: the default from the SIMD probe unless the benchmark suite switched it. */
export function getActiveWasmBuild(): WasmBuildSelection {
  activeWasmBuild ??= defaultWasmBuild();
  return activeWasmBuild;
}

/**
 * Benchmark suite only: replaces the shared worker with a new one running
 * `selection`'s build. Main-thread fallback instances reload lazily on
 * their next detection tick. Requests still pending in the old worker are
 * cancelled. Resolves like getSharedDetectionWorker.
 */
export function switchWasmBuild(selection: WasmBuildSelection): Promise<boolean> {
  activeWasmBuild = selection;
  disposeSharedWorker?.();
  for (const pending of pendingDetections.values()) pending.onCancel();
  pendingDetections.clear();
  return getSharedDetectionWorker();
}

/**
 * Creates the shared worker on first call and waits for it to report
 * ready. Later calls (from any VertixEngine instance) just get the same
 * result instead of creating another worker. Resolves false if it can't
 * be built, errors, or times out — callers fall back to running WASM on
 * the main thread instead (see dispatchDetection). A crash discovered
 * later, after this already resolved true, is handled the same way —
 * sharedWorkerReady just flips back off and dispatchDetection's fallback
 * branch takes over on its own next tick, no need to call this again.
 */
function getSharedDetectionWorker(): Promise<boolean> {
  if (sharedWorkerLoadPromise) return sharedWorkerLoadPromise;

  const build = getActiveWasmBuild().variant;
  sharedWorkerLoading = true;
  sharedWorkerLoadPromise = new Promise((resolve) => {
    let worker: Worker;
    try {
      // Respects Vite's base path (root in dev, a subpath on GitHub
      // Pages). No `type: "module"` — the bundle is built classic, see
      // scripts/build-worker.mjs.
      worker = new Worker(`${import.meta.env.BASE_URL}workers/faceDetectionWorker.js`);
    } catch (err) {
      console.error(
        "[Vertix] Couldn't construct the detection worker; falling back to running WASM on the main thread.",
        err
      );
      sharedWorkerLoading = false;
      resolve(false);
      return;
    }

    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sharedWorkerLoading = false;
      clearTimeout(timeout);
      resolve(ok);
    };
    const release = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      if (sharedWorker === worker) {
        sharedWorker = null;
        sharedWorkerReady = false;
      }
    };
    // Also the recovery path for a crash discovered well after startup, not
    // just an initial-load failure — always tears the worker down and flips
    // sharedWorkerReady off, but only resolves/clears the timeout once
    // (a promise can't settle twice). dispatchDetection's fallback branch
    // calls ensureWasm() lazily on its own next tick once sharedWorkerReady
    // is false, so nothing else needs to be notified explicitly.
    const fail = (reason: string) => {
      console.error(
        `[Vertix] Detection worker unavailable (${reason}); falling back to running WASM on the main thread.`
      );
      release();
      settle(false);
    };

    const timeout = setTimeout(() => fail(`no "ready" within ${WORKER_READY_TIMEOUT_MS}ms`), WORKER_READY_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as {
        type: string;
        requestId?: number;
        faces?: ArrayBuffer;
        cutScores?: ArrayBuffer;
        tookMs?: number;
        readbackMs?: number;
        message?: string;
        build?: WasmBuildVariant;
      };
      if (msg.type === "ready") {
        if (settled) return;
        if (msg.build !== build) {
          fail(`loaded the ${msg.build} WASM build instead of ${build}`);
          return;
        }
        sharedWorkerReady = true;
        settle(true);
        return;
      }
      if (msg.type === "error") {
        fail(msg.message ?? "unknown error");
        return;
      }
      if (msg.type === "result" && msg.requestId !== undefined) {
        const pending = pendingDetections.get(msg.requestId);
        pendingDetections.delete(msg.requestId);
        pending?.onResult(
          new Float64Array(msg.faces!),
          new Float64Array(msg.cutScores ?? []),
          msg.tookMs ?? 0,
          msg.readbackMs ?? 0
        );
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      fail(e.message);
    };

    sharedWorker = worker;
    disposeSharedWorker = () => {
      release();
      settle(false);
      sharedWorkerLoadPromise = null;
      disposeSharedWorker = null;
    };
    worker.postMessage({ type: "init", build });
  });

  return sharedWorkerLoadPromise;
}

// A face only counts toward the layout if it's at least this tall or wide
// (fraction of frame) — filters out background people the model still
// happily detects (crowd, players on a pitch) that aren't a real subject.
const MIN_SPEAKER_FACE_SIZE = 0.12;
// A face must be at least this visible within the frame (not cropped off
// at an edge) to count — see faceVisibleFraction.
const MIN_FACE_VISIBLE_FRACTION = 0.8;

// Background people (crowd, players on a pitch) still get detected by the
// model — only close-up, unclipped faces count as an actual speaker.
function isSpeakerSized(f: FaceBox): boolean {
  return (
    (f.h >= MIN_SPEAKER_FACE_SIZE || f.w >= MIN_SPEAKER_FACE_SIZE) &&
    faceVisibleFraction(f) >= MIN_FACE_VISIBLE_FRACTION
  );
}

// A face must drift more than this (a fraction of frame width/height) from
// where its pane's crop was last aimed before the crop moves at all.
const DEADZONE_FRACTION = 0.04;

// Skin-rejection overlay style: dashed, so it can't be mistaken for a crop.
const SKIN_REJECTED_STROKE = "#f97316";
const SKIN_REJECTED_LINE_WIDTH = 3;
const SKIN_REJECTED_DASH = [10, 6];

// How long a layout change (0 -> 2 speakers, 2 -> 3, etc.) takes to
// cross-dissolve from the old framing into the new one, instead of cutting
// instantly.
const LAYOUT_TRANSITION_MS = 250;

/**
 * A framing change that must not glide: "snap" after a hard cut in the
 * source (the viewer already saw a cut), "dissolve" when the active
 * speaker switches to someone else within the same shot.
 */
type Reframe = "snap" | "dissolve";

/**
 * Full, un-cropped frame centered in the output canvas with a softly
 * blurred cover-scaled backdrop filling the rest — no tracking, no crop
 * math, just "show everything". Used for the no-faces (B-roll) fallback.
 * The backdrop is blurred at half resolution then scaled back up (a real
 * `filter: blur()`, just on a quarter as many pixels) to keep this cheap
 * without looking blocky.
 */
function drawFitFrame(
  ctx: CanvasRenderingContext2D,
  blurCanvas: OffscreenCanvas,
  video: HTMLVideoElement,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
) {
  const coverScale = Math.max(outW / srcW, outH / srcH);
  const bgW = Math.round(srcW * coverScale);
  const bgH = Math.round(srcH * coverScale);

  const halfW = Math.max(1, Math.round(bgW / 2));
  const halfH = Math.max(1, Math.round(bgH / 2));
  if (blurCanvas.width !== halfW || blurCanvas.height !== halfH) {
    blurCanvas.width = halfW;
    blurCanvas.height = halfH;
  }
  const blurCtx = blurCanvas.getContext("2d")!;
  blurCtx.filter = "blur(15px)";
  blurCtx.drawImage(video, 0, 0, halfW, halfH);
  blurCtx.filter = "none";
  ctx.drawImage(blurCanvas, Math.round((outW - bgW) / 2), Math.round((outH - bgH) / 2), bgW, bgH);

  const fitScale = outW / srcW;
  const fgH = Math.round(srcH * fitScale);
  ctx.drawImage(video, 0, Math.round((outH - fgH) / 2), outW, fgH);
}

type MetricsListener = (metrics: VertixMetrics) => void;
type StateListener = (state: VertixState) => void;

export class VertixEngine {
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private outputCtx: CanvasRenderingContext2D | null = null;

  // Face detection normally runs in the shared worker above. `engine` (a
  // main-thread WASM instance) only exists as a fallback if the worker
  // can't be used.
  private engine: InstanceType<WasmBindings["ReframeEngine"]> | null = null;
  private engineBuild: WasmBuildVariant | null = null;
  private wasmReady = false;
  private wasmLoading: Promise<void> | null = null;

  private detectionInFlight = false;
  // Bumped on every reset (seek, mode change) so a shared-worker result
  // already in flight gets discarded instead of landing on top of
  // freshly-cleared tracking state.
  private detectionRequestGeneration = 0;

  private faceCanvas: OffscreenCanvas;
  private faceCtx: OffscreenCanvasRenderingContext2D;
  private blurCanvas: OffscreenCanvas;
  private frameCounter = 0;
  private running = false;
  // The one pending requestVideoFrameCallback of the render loop. detach()
  // cancels it: otherwise a callback registered before a re-attach (e.g.
  // after "Change source" mounts a new canvas) would keep firing next to
  // the new loop's, drawing every frame twice and doubling detection.
  private frameCallbackId: number | null = null;

  private mode: VertixMode = "9:16";
  private meta: VertixMeta | null = null;
  private metrics: VertixMetrics = INITIAL_METRICS;

  private metricsListeners = new Set<MetricsListener>();
  private stateListeners = new Set<StateListener>();

  // FPS/frame-time measurement.
  private lastFrameTime: number | null = null;
  private lastDetectionMediaTime: number | null = null;
  private detectionIntervalEma = 0;
  private fpsEma = 0;
  private frameTimeEma = 0;
  private lastMetricsPush = 0;
  private sceneSwitchCount = 0;
  private sceneCutCount = 0;

  // Main-thread stall tracking (Long Tasks API — Chromium only). Raw
  // entries land here as they're observed; onVideoFrame's own metrics-push
  // tick (same 300ms cadence as FPS) reduces them down to "ms blocked in
  // the last LONG_TASK_WINDOW_MS" for the dashboard.
  private longTaskObserver: PerformanceObserver | null = null;
  private recentLongTasks: { time: number; duration: number }[] = [];

  private srcDims = { w: 0, h: 0, cropW: 0, cropH: 0 };
  private srcDimsInitialized = false;

  private lastFaces: FaceBox[] = [];
  // Per-detection counts for the benchmark probe, and the boxes for the
  // skin-rejection overlay.
  private lastDetectedFaceCount = 0;
  private lastSkinRejectedFaces: FaceBox[] = [];
  private lastSkinRejectedSpeakerSizedCount = 0;
  private lastSceneCut: SceneCutScores = NO_SCENE_CUT;
  private skinRejectionOverlay: HTMLCanvasElement | null = null;
  private skinRejectionOverlayCtx: CanvasRenderingContext2D | null = null;
  private lastResolvedFaces: FaceBox[] = [];
  private personCount = new PersonCountDebouncer();

  private audioMonitor = new AudioActivityMonitor();
  private activeSpeaker = new ActiveSpeakerResolver();

  private targetPanes: PaneTarget[] = [];
  private smoothedPanes: PaneRect[] = [];

  private layoutSignature = "";
  // Set by a detection, applied (and cleared) by the next rendered frame.
  private pendingReframe: Reframe | null = null;
  private transitionSnapshotCanvas: OffscreenCanvas | null = null;
  private transitionStart: number | null = null;

  // Benchmark mode only (see src/core/bench). Null in normal playback, where
  // every instrumentation point below reduces to a single null check.
  private benchmarkProbe: BenchmarkProbe | null = null;

  private boundOnVideoFrame = this.onVideoFrame.bind(this);
  private boundOnPlay = () => this.startLoop();
  private boundOnSeeking = () => this.resetTrackingState();
  private boundOnLoadedMetadata = () => this.resetForNewSource();

  constructor() {
    const fc = new OffscreenCanvas(FACE_W, FACE_H);
    this.faceCanvas = fc;
    this.faceCtx = fc.getContext("2d", { willReadFrequently: true })!;
    this.blurCanvas = new OffscreenCanvas(1, 1);
    // Starts loading right away, not on first attach — a host usually
    // constructs the engine before it has a video to attach to (e.g. while
    // the user's still picking a file), and that's exactly the dead time
    // to hide this latency in. Shared across instances, so only the first
    // call actually creates anything.
    void getSharedDetectionWorker().then((ok) => {
      if (!ok) this.ensureWasm();
      else this.emitState();
    });

    // Long Tasks isn't in every browser (Chromium only, as of writing) —
    // observe() throws for an unsupported entry type, so this just leaves
    // longTasksSupported false instead of failing the whole constructor.
    try {
      this.longTaskObserver = new PerformanceObserver((list) => {
        const now = performance.now();
        for (const entry of list.getEntries()) {
          this.recentLongTasks.push({ time: now, duration: entry.duration });
        }
      });
      this.longTaskObserver.observe({ entryTypes: ["longtask"] });
      this.metrics = { ...this.metrics, longTasksSupported: true };
    } catch {
      this.longTaskObserver = null;
    }
  }

  /** Attaches to a video/canvas pair. Safe to call again with a different pair — the previous one is detached first. */
  attach(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
    if (this.video) this.detach();

    this.video = video;
    this.canvas = canvas;
    this.outputCtx = null;
    this.audioMonitor.attach(video);
    this.resetForNewSource();

    video.addEventListener("play", this.boundOnPlay);
    video.addEventListener("seeking", this.boundOnSeeking);
    video.addEventListener("loadedmetadata", this.boundOnLoadedMetadata);

    if (!video.paused) this.startLoop();
  }

  /** Stops rendering and removes all listeners from the current video. Keeps the WASM engine warm for a future `attach`. */
  detach(): void {
    if (!this.video) return;
    this.video.removeEventListener("play", this.boundOnPlay);
    this.video.removeEventListener("seeking", this.boundOnSeeking);
    this.video.removeEventListener("loadedmetadata", this.boundOnLoadedMetadata);
    if (this.frameCallbackId !== null) this.video.cancelVideoFrameCallback(this.frameCallbackId);
    this.frameCallbackId = null;
    this.running = false;
    this.video = null;
    this.canvas = null;
    this.outputCtx = null;
  }

  /**
   * Tears this instance down for good — construct a new one to reuse.
   * Doesn't touch the shared detection worker; other instances may still
   * be using it.
   */
  destroy(): void {
    this.detach();
    this.audioMonitor.detach();
    this.longTaskObserver?.disconnect();
    this.engine?.free();
    this.engine = null;
    this.metricsListeners.clear();
    this.stateListeners.clear();
  }

  setMode(mode: VertixMode): void {
    this.mode = mode;
    if (this.outputCtx) this.outputCtx = this.canvas?.getContext("2d") ?? null;
    this.engine?.reset();
    this.resetTrackingState();
    this.emitState();
  }

  /**
   * Draws detections the skin-tone filter rejected as dashed boxes on
   * `canvas`, which the host lays exactly over the output canvas. They are
   * never drawn on the output itself, so they can't leak into the video or
   * a layout-change snapshot. Pass null to stop.
   */
  setSkinRejectionOverlay(canvas: HTMLCanvasElement | null): void {
    this.skinRejectionOverlay = canvas;
    this.skinRejectionOverlayCtx = null;
  }

  /** Starts (or, with null, stops) reporting per-frame and per-detection timings to `probe`. Does not change rendering or detection. */
  setBenchmarkProbe(probe: BenchmarkProbe | null): void {
    this.benchmarkProbe = probe;
  }

  getMode(): VertixMode {
    return this.mode;
  }

  getMetrics(): VertixMetrics {
    return this.metrics;
  }

  getState(): VertixState {
    return {
      wasmReady: sharedWorkerReady || this.wasmReady,
      mode: this.mode,
      meta: this.meta,
      speakerCount: this.personCount.stableCount,
      isTransitioning: this.transitionStart !== null,
    };
  }

  /**
   * Subscribes to metrics updates (a few times a second). Calls `listener`
   * once immediately with the current snapshot, then again on every future
   * update, so a subscriber never has to separately call `getMetrics()`
   * just to avoid missing whatever happened before it subscribed. Returns
   * an unsubscribe function.
   */
  onMetricsUpdate(listener: MetricsListener): () => void {
    this.metricsListeners.add(listener);
    listener(this.metrics);
    return () => this.metricsListeners.delete(listener);
  }

  /** Same contract as `onMetricsUpdate`, for everything except metrics (mode, meta, speaker count, transition state, wasm readiness). */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  private emitMetrics() {
    for (const l of this.metricsListeners) l(this.metrics);
  }

  private emitState() {
    const state = this.getState();
    for (const l of this.stateListeners) l(state);
  }

  private ensureWasm(): void {
    const build = getActiveWasmBuild().variant;
    if (this.engineBuild !== build) {
      this.engine?.free();
      this.engine = null;
      this.wasmReady = false;
      this.wasmLoading = null;
    }
    if (this.wasmReady || this.wasmLoading) return;
    this.engineBuild = build;
    this.wasmLoading = importWasmBindings(build).then(async (bindings) => {
      await bindings.default();
      if (this.engineBuild !== build) return;
      this.engine = new bindings.ReframeEngine();
      this.wasmReady = true;
      this.emitState();
    });
  }

  private resetForNewSource(): void {
    this.srcDimsInitialized = false;
    this.frameCounter = 0;
    this.meta = null;
    this.lastFrameTime = null;
    this.fpsEma = 0;
    this.frameTimeEma = 0;
    this.lastMetricsPush = 0;
    this.sceneSwitchCount = 0;
    this.sceneCutCount = 0;
    // Browser capability, not a per-source reading — INITIAL_METRICS always
    // has this false, so it'd get wiped out on every source load otherwise.
    this.metrics = { ...INITIAL_METRICS, longTasksSupported: this.longTaskObserver !== null };
    this.resetTrackingState();
    this.emitState();
    this.emitMetrics();
  }

  /** Clears face-tracking/layout state without touching video dimensions or WASM readiness — used on seek and mode changes. */
  private resetTrackingState(): void {
    this.engine?.reset();
    // Resets the worker's own tracker too — mouth motion needs a previous
    // frame to diff against, and a seek just invalidated it. This affects
    // every instance sharing the worker, which is fine since the app only
    // ever has one video actually playing at a time.
    sharedWorker?.postMessage({ type: "reset" });
    // Whatever's in flight belongs to a frame from before this reset —
    // discard it instead of feeding it into the state we're about to clear.
    this.detectionInFlight = false;
    this.detectionRequestGeneration += 1;
    this.lastFaces = [];
    this.lastSkinRejectedFaces = [];
    this.lastResolvedFaces = [];
    this.lastDetectionMediaTime = null;
    this.detectionIntervalEma = 0;
    this.personCount.reset();
    this.activeSpeaker.reset();
    this.smoothedPanes = [];
    this.targetPanes = [];
    this.layoutSignature = "";
    this.pendingReframe = null;
    this.transitionStart = null;
    this.metrics = {
      ...this.metrics,
      faceSizes: [],
      motionScore: null,
      faceConfidence: null,
      audioEnergy: null,
      cropScaleFactor: null,
      layoutCommittedAt: null,
      detectionRateHz: null,
    };
    this.emitState();
    this.emitMetrics();
  }

  private startLoop(): void {
    if (this.running || !this.video) return;
    this.running = true;
    this.scheduleNextFrame(this.video);
  }

  private scheduleNextFrame(video: HTMLVideoElement): void {
    this.frameCallbackId = video.requestVideoFrameCallback(this.boundOnVideoFrame);
  }

  /** Maps each skin-rejected box through what is on screen now: every pane's current crop, or the fitted full frame in B-roll. */
  private drawSkinRejectionOverlay(overlay: HTMLCanvasElement, outW: number, outH: number): void {
    if (overlay.width !== outW || overlay.height !== outH) {
      overlay.width = outW;
      overlay.height = outH;
      this.skinRejectionOverlayCtx = null;
    }
    this.skinRejectionOverlayCtx ??= overlay.getContext("2d");
    const ctx = this.skinRejectionOverlayCtx;
    if (!ctx) return;
    ctx.clearRect(0, 0, outW, outH);
    const faces = this.lastSkinRejectedFaces;
    if (faces.length === 0 || this.mode === "16:9") return;

    const { w: srcW, h: srcH } = this.srcDims;
    const fittedHeight = Math.round(srcH * (outW / srcW));
    const views: { source: PaneRect; dest: PaneRect }[] =
      this.personCount.stableCount === 0
        ? [
            {
              source: { x: 0, y: 0, w: srcW, h: srcH },
              dest: { x: 0, y: Math.round((outH - fittedHeight) / 2), w: outW, h: fittedHeight },
            },
          ]
        : this.targetPanes.map((p, i) => ({ source: this.smoothedPanes[i], dest: p.pane.dest }));

    ctx.strokeStyle = SKIN_REJECTED_STROKE;
    ctx.lineWidth = SKIN_REJECTED_LINE_WIDTH;
    ctx.setLineDash(SKIN_REJECTED_DASH);
    for (const { source, dest } of views) {
      const scaleX = dest.w / source.w;
      const scaleY = dest.h / source.h;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dest.x, dest.y, dest.w, dest.h);
      ctx.clip();
      for (const f of faces) {
        ctx.strokeRect(
          dest.x + ((f.cx - f.w / 2) * srcW - source.x) * scaleX,
          dest.y + ((f.cy - f.h / 2) * srcH - source.y) * scaleY,
          f.w * srcW * scaleX,
          f.h * srcH * scaleY
        );
      }
      ctx.restore();
    }
  }

  private dispatchDetection(
    video: HTMLVideoElement,
    mediaTimeSec: number,
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number
  ): void {
    const probe = this.benchmarkProbe;
    const dispatchedAt = probe ? performance.now() : 0;
    const audioEnergy = this.audioMonitor.energy();

    if (sharedWorkerReady && sharedWorker) {
      this.detectionInFlight = true;
      const generation = this.detectionRequestGeneration;
      const requestId = nextDetectionRequestId++;
      let bitmapReadyAt = 0;
      const onResult = (facesFlat: Float64Array, cutScoresFlat: Float64Array, tookMs: number, readbackMs: number) => {
        this.detectionInFlight = false;
        // Belongs to a frame from before a reset (seek, mode change) —
        // discard it instead of feeding stale positions into the layout.
        if (generation !== this.detectionRequestGeneration) return;
        const postStart = probe ? performance.now() : 0;
        this.processDetectionResult(
          facesFlat,
          unpackSceneCutScores(cutScoresFlat),
          audioEnergy,
          mediaTimeSec,
          srcW,
          srcH,
          cropW,
          cropH,
          "worker",
          tookMs
        );
        if (probe) {
          const end = performance.now();
          probe.recordDetection(
            "worker",
            bitmapReadyAt - dispatchedAt,
            readbackMs,
            tookMs,
            end - postStart,
            end - dispatchedAt,
            this.lastDetectedFaceCount,
            this.lastFaces.length,
            this.lastSkinRejectedFaces.length,
            this.lastSkinRejectedSpeakerSizedCount,
            mediaTimeSec,
            this.lastSceneCut.hist,
            this.lastSceneCut.grid,
            this.lastSceneCut.isCut
          );
        }
      };
      pendingDetections.set(requestId, { onResult, onCancel: () => (this.detectionInFlight = false) });
      // Resizing via createImageBitmap instead of drawImage+getImageData
      // here keeps the main thread from doing a synchronous GPU→CPU
      // readback every detection tick — the worker does that part now
      // (see faceDetectionWorker.ts).
      createImageBitmap(video, { resizeWidth: FACE_W, resizeHeight: FACE_H, resizeQuality: "low" })
        .then((bitmap) => {
          if (probe) bitmapReadyAt = performance.now();
          if (generation !== this.detectionRequestGeneration || !sharedWorker) {
            bitmap.close();
            return;
          }
          sharedWorker.postMessage(
            { type: "detect", requestId, bitmap, mediaTimeSec, measureReadback: probe !== null },
            [bitmap]
          );
        })
        .catch(() => {
          this.detectionInFlight = false;
          pendingDetections.delete(requestId);
        });
    } else if (sharedWorkerLoading) {
      return;
    } else {
      // The worker either never became usable, or just stopped being one
      // (a runtime crash after reporting ready — see getSharedDetectionWorker's
      // fail()). Either way, this instance may never have needed its own
      // WASM fallback before now; ensureWasm() is a no-op once it's
      // already loading or ready, so it's safe to call on every tick here.
      this.ensureWasm();
      if (!this.engine) return;
      this.faceCtx.drawImage(video, 0, 0, FACE_W, FACE_H);
      const drawnAt = probe ? performance.now() : 0;
      const faceImageData = this.faceCtx.getImageData(0, 0, FACE_W, FACE_H);
      const start = performance.now();
      const facesFlat = this.engine.update_faces(new Uint8Array(faceImageData.data.buffer), mediaTimeSec);
      const tookMs = performance.now() - start;
      this.processDetectionResult(
        facesFlat,
        unpackSceneCutScores(this.engine.last_cut_scores()),
        audioEnergy,
        mediaTimeSec,
        srcW,
        srcH,
        cropW,
        cropH,
        "main-thread",
        tookMs
      );
      if (probe) {
        const end = performance.now();
        probe.recordDetection(
          "main-thread",
          drawnAt - dispatchedAt,
          start - drawnAt,
          tookMs,
          end - start - tookMs,
          end - dispatchedAt,
          this.lastDetectedFaceCount,
          this.lastFaces.length,
          this.lastSkinRejectedFaces.length,
          this.lastSkinRejectedSpeakerSizedCount,
          mediaTimeSec,
          this.lastSceneCut.hist,
          this.lastSceneCut.grid,
          this.lastSceneCut.isCut
        );
      }
    }
  }

  private processDetectionResult(
    facesFlat: Float64Array,
    sceneCut: SceneCutScores,
    audioEnergy: number | null,
    mediaTimeSec: number,
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number,
    detectionMode: "worker" | "main-thread",
    inferenceMs: number
  ): void {
    const detections = unpackDetections(facesFlat);
    this.lastSceneCut = sceneCut;
    this.lastDetectedFaceCount = detections.faces.length;
    this.lastFaces = detections.faces.filter(isSpeakerSized);
    this.lastSkinRejectedFaces = detections.skinRejected;
    this.lastSkinRejectedSpeakerSizedCount = detections.skinRejected.filter(isSpeakerSized).length;

    // A hard cut makes everything learned from the previous shot stale:
    // who holds the lock, the agreement streaks, the committed count.
    if (sceneCut.isCut) {
      this.sceneCutCount += 1;
      this.activeSpeaker.reset();
    }
    this.lastResolvedFaces = this.activeSpeaker.resolve(this.lastFaces, audioEnergy, mediaTimeSec);
    const count = this.lastResolvedFaces.length;
    const stablePersonCount = sceneCut.isCut
      ? this.personCount.commitNow(count, mediaTimeSec)
      : this.personCount.observe(count, this.layoutSignature !== "", mediaTimeSec);
    if (sceneCut.isCut) this.pendingReframe = "snap";
    this.emitState();

    if (this.lastDetectionMediaTime !== null && mediaTimeSec > this.lastDetectionMediaTime) {
      const interval = mediaTimeSec - this.lastDetectionMediaTime;
      this.detectionIntervalEma =
        this.detectionIntervalEma === 0
          ? interval
          : this.detectionIntervalEma + (interval - this.detectionIntervalEma) * 0.2;
    }
    this.lastDetectionMediaTime = mediaTimeSec;

    const faces = this.lastFaces;
    const faceSizes = faces.map((f) => Math.round(Math.max(f.w, f.h) * 1000) / 10);
    const motionScore = faces.length > 0 ? Math.max(...faces.map((f) => f.motion)) : null;
    const faceConfidence = faces.length > 0 ? faces.reduce((s, f) => s + f.confidence, 0) / faces.length : null;
    this.metrics = {
      ...this.metrics,
      faceSizes,
      motionScore,
      faceConfidence,
      skinRejectedTotal: this.metrics.skinRejectedTotal + this.lastSkinRejectedFaces.length,
      skinRejectedSpeakerSized: this.metrics.skinRejectedSpeakerSized + this.lastSkinRejectedSpeakerSizedCount,
      sceneCutCount: this.sceneCutCount,
      detectionRateHz: this.detectionIntervalEma > 0 ? 1 / this.detectionIntervalEma : null,
      audioAvailable: this.audioMonitor.available,
      audioEnergy,
      detectionMode,
      workerInferenceMs: inferenceMs,
      workerInferenceHistory: appendCapped(this.metrics.workerInferenceHistory, inferenceMs),
      // The cut frame's motion compares against another shot; Rust zeroes it.
      motionHistory:
        motionScore !== null && !sceneCut.isCut
          ? appendCapped(this.metrics.motionHistory, motionScore)
          : this.metrics.motionHistory,
      confidenceHistory:
        faceConfidence !== null
          ? appendCapped(this.metrics.confidenceHistory, faceConfidence)
          : this.metrics.confidenceHistory,
    };
    this.emitMetrics();

    // Only refresh the LERP target once the raw count matches the
    // *committed* layout — otherwise, mid-debounce, this could compute a
    // different pane count than what's actually on screen. The deadzone
    // itself lives inside computeSpeakerLayout. A pending reframe aims
    // straight at the new faces, without the deadzone.
    if (stablePersonCount > 0 && count === stablePersonCount) {
      if (this.activeSpeaker.switchedSpeaker) this.pendingReframe ??= "dissolve";
      this.targetPanes =
        this.pendingReframe !== null
          ? computeSpeakerLayout(this.lastResolvedFaces, srcW, srcH, cropW, cropH)
          : computeSpeakerLayout(this.lastResolvedFaces, srcW, srcH, cropW, cropH, this.targetPanes, DEADZONE_FRACTION);
    }
  }

  /**
   * Snapshots the current output so the next framing cross-dissolves in
   * over LAYOUT_TRANSITION_MS. If a fade is already running, the canvas
   * holds a partial blend, not a clean frame, so this cuts straight to the
   * new framing instead of stacking a second fade on top of it.
   */
  private startLayoutDissolve(canvas: HTMLCanvasElement, cropW: number, cropH: number, now: number): void {
    if (this.transitionStart !== null) {
      this.transitionStart = null;
      return;
    }
    if (
      !this.transitionSnapshotCanvas ||
      this.transitionSnapshotCanvas.width !== cropW ||
      this.transitionSnapshotCanvas.height !== cropH
    ) {
      this.transitionSnapshotCanvas = new OffscreenCanvas(cropW, cropH);
    }
    const snapCtx = this.transitionSnapshotCanvas.getContext("2d")!;
    snapCtx.clearRect(0, 0, cropW, cropH);
    snapCtx.drawImage(canvas, 0, 0);
    this.transitionStart = now;
  }

  // Runs on every decoded frame. Rendering happens synchronously here (not
  // through any framework state) so playback stays perfectly in sync with
  // audio.
  private onVideoFrame(now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void {
    this.frameCallbackId = null;
    const video = this.video;
    const canvas = this.canvas;
    if (!video || !canvas) {
      // detach()/destroy() already cleared these — nothing left to render.
      this.running = false;
      return;
    }
    if (video.paused || video.ended) {
      // Don't give up — just wait for the next real frame. `ended` can
      // still read true for a tick right after playback actually resumes
      // (replaying seeks back to 0 internally, which isn't perfectly
      // synchronous with the "play" event) — treating that as a final
      // stop used to leave this loop off for good while the video kept
      // playing fine, a canvas freeze that looked like a real hang.
      this.scheduleNextFrame(video);
      return;
    }

    const probe = this.benchmarkProbe;
    const workStart = probe ? performance.now() : 0;

    // Callback rate and interval, from the `now` timestamp rVFC passes to
    // each callback (when the callback runs, not the frame's media time) —
    // EMA-smoothed every frame, pushed to subscribers (and sampled into the
    // trend history) only a few times a second.
    const frameDtSec = this.lastFrameTime !== null ? Math.max(0, now - this.lastFrameTime) / 1000 : 0;
    if (this.lastFrameTime !== null) {
      const dt = now - this.lastFrameTime;
      if (dt > 0) {
        const instFps = 1000 / dt;
        this.fpsEma = this.fpsEma === 0 ? instFps : this.fpsEma + (instFps - this.fpsEma) * 0.15;
        this.frameTimeEma = this.frameTimeEma === 0 ? dt : this.frameTimeEma + (dt - this.frameTimeEma) * 0.15;
      }
    }
    this.lastFrameTime = now;
    if (now - this.lastMetricsPush > 300) {
      this.lastMetricsPush = now;
      // Drop long-task entries that have aged out of the window, then sum
      // what's left.
      this.recentLongTasks = this.recentLongTasks.filter((t) => now - t.time <= LONG_TASK_WINDOW_MS);
      const longTaskMs = this.recentLongTasks.reduce((sum, t) => sum + t.duration, 0);
      this.metrics = {
        ...this.metrics,
        fps: this.fpsEma,
        frameTimeMs: this.frameTimeEma,
        fpsHistory: appendCapped(this.metrics.fpsHistory, this.fpsEma),
        frameTimeHistory: appendCapped(this.metrics.frameTimeHistory, this.frameTimeEma),
        longTaskMs,
        longTaskHistory: appendCapped(this.metrics.longTaskHistory, longTaskMs),
      };
      this.emitMetrics();
    }

    if (!this.srcDimsInitialized) {
      const w = metadata.width ?? video.videoWidth;
      const h = metadata.height ?? video.videoHeight;
      const cropH = h;
      const cropW = Math.round((h * 9) / 16);

      this.srcDims = { w, h, cropW, cropH };
      this.srcDimsInitialized = true;

      this.meta = { width: w, height: h, cropWidth: cropW, cropHeight: cropH };
      this.emitState();
    }

    const { w: srcW, h: srcH, cropW, cropH } = this.srcDims;
    const currentMode = this.mode;

    const targetW = currentMode === "16:9" ? srcW : cropW;
    const targetH = currentMode === "16:9" ? srcH : cropH;
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    if (!this.outputCtx) this.outputCtx = canvas.getContext("2d");
    const ctx = this.outputCtx!;

    if (currentMode === "16:9") {
      ctx.drawImage(video, 0, 0, srcW, srcH);
    } else {
      // "9:16" mode: 0 faces -> full frame, no crop; N>=1 -> N panes, each a
      // cover-crop following its face. The layout (pane count/positions) is
      // committed once per debounced face-count change and held fixed;
      // within it, each pane's crop only drifts smoothly toward its target.
      this.frameCounter += 1;
      if (this.frameCounter % FACE_DETECT_INTERVAL === 0) {
        if (!this.detectionInFlight) this.dispatchDetection(video, metadata.mediaTime, srcW, srcH, cropW, cropH);
        else probe?.recordSkippedDetection();
      }

      const speakerCount = this.personCount.stableCount;
      const targetSignature = speakerCount === 0 ? "broll" : `speakers:${speakerCount}`;

      const reframe = this.pendingReframe;
      this.pendingReframe = null;
      // After a source cut, the old frame shows the previous shot: never
      // fade from it, and stop any fade still running.
      if (reframe === "snap") this.transitionStart = null;

      if (targetSignature !== this.layoutSignature) {
        // Skipped on the very first commit — there's no prior frame to fade from.
        if (this.layoutSignature !== "") {
          this.sceneSwitchCount += 1;
          probe?.recordLayoutChange(now);
          if (reframe !== "snap") this.startLayoutDissolve(canvas, cropW, cropH, now);
        }
        this.layoutSignature = targetSignature;

        // A new layout snaps straight to its target instead of gliding in
        // from the old positions.
        this.targetPanes =
          speakerCount === 0 ? [] : computeSpeakerLayout(this.lastResolvedFaces, srcW, srcH, cropW, cropH);
        this.smoothedPanes = this.targetPanes.map((p) => ({ ...p.pane.source }));

        const cropScaleFactor =
          this.targetPanes.length > 0
            ? this.targetPanes.reduce((sum, p) => sum + srcH / p.pane.source.h, 0) / this.targetPanes.length
            : null;
        this.metrics = {
          ...this.metrics,
          layoutCommittedAt: now,
          sceneSwitchCount: this.sceneSwitchCount,
          cropScaleFactor,
        };
        this.emitMetrics();
        this.emitState();
      } else if (reframe !== null && speakerCount > 0) {
        // Same pane count, new framing (a cut, or another speaker): jump
        // to the target instead of gliding across the frame.
        if (reframe === "dissolve") this.startLayoutDissolve(canvas, cropW, cropH, now);
        this.smoothedPanes = this.targetPanes.map((p) => ({ ...p.pane.source }));
      }

      if (speakerCount === 0) {
        drawFitFrame(ctx, this.blurCanvas, video, srcW, srcH, cropW, cropH);
      } else {
        // Mutate the already-allocated smoothed rects toward the cached
        // target and draw with integer coordinates (avoids sub-pixel blit
        // interpolation). No new objects, no layout math — that only runs
        // at detection ticks, above.
        const smoothingAlpha = paneSmoothingAlpha(frameDtSec);
        for (let i = 0; i < this.targetPanes.length; i++) {
          const target = this.targetPanes[i].pane;
          const smoothed = lerpPaneRectInto(this.smoothedPanes[i], target.source, smoothingAlpha);
          ctx.drawImage(
            video,
            Math.round(smoothed.x),
            Math.round(smoothed.y),
            Math.round(smoothed.w),
            Math.round(smoothed.h),
            Math.round(target.dest.x),
            Math.round(target.dest.y),
            Math.round(target.dest.w),
            Math.round(target.dest.h)
          );
        }
      }

      if (this.transitionStart !== null) {
        const t = Math.min(1, (now - this.transitionStart) / LAYOUT_TRANSITION_MS);
        // Ease-in-out: the old frame dissolves away gradually at both ends
        // of the transition instead of snapping out almost immediately, so
        // a speaker coming into focus reads as a smooth reveal.
        ctx.globalAlpha = 1 - easeInOutCubic(t);
        ctx.drawImage(this.transitionSnapshotCanvas!, 0, 0);
        ctx.globalAlpha = 1;
        if (t >= 1) {
          this.transitionStart = null;
          this.emitState();
        }
      }
    }

    if (this.skinRejectionOverlay) this.drawSkinRejectionOverlay(this.skinRejectionOverlay, targetW, targetH);

    if (probe) probe.recordFrame(now, performance.now() - workStart, metadata.mediaTime, metadata.presentedFrames);
    this.scheduleNextFrame(video);
  }
}
