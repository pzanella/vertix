import initWasm, { ReframeEngine } from "./wasm/wasm.js";
import { AudioActivityMonitor } from "./audioActivity";
import {
  computeSpeakerLayout,
  faceVisibleFraction,
  lerpPaneRectInto,
  unpackFaces,
  type FaceBox,
  type PaneRect,
  type PaneTarget,
} from "./layoutEngine";

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
  /** Smoothed frames-per-second, measured from actual decoded-frame timestamps. */
  fps: number;
  /** Smoothed per-frame render latency, in ms. */
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
  /** Current voice-activity energy (0-1 RMS) from the audio track, or null when audioAvailable is false. Only meaningful once ACTIVE_SPEAKER_THRESHOLD (2) or more raw faces are detected. */
  audioEnergy: number | null;
  /** performance.now() timestamp the current layout was committed at, for computing "stable for Ns" live. */
  layoutCommittedAt: number | null;
  /** How many times the layout has actually changed this session. */
  sceneSwitchCount: number;
  /** Recent samples (oldest first) for trend charts — roughly the last 10-15s, sampling rate varies per metric. */
  fpsHistory: number[];
  frameTimeHistory: number[];
  motionHistory: number[];
  confidenceHistory: number[];
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
  fpsHistory: [],
  frameTimeHistory: [],
  motionHistory: [],
  confidenceHistory: [],
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
let sharedWorkerLoadPromise: Promise<boolean> | null = null;
let nextDetectionRequestId = 0;
const pendingDetectionCallbacks = new Map<number, (facesFlat: Float64Array, tookMs: number) => void>();

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
      resolve(false);
      return;
    }

    let settled = false;
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
      worker.terminate();
      sharedWorker = null;
      sharedWorkerReady = false;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(false);
      }
    };

    const timeout = setTimeout(() => fail(`no "ready" within ${WORKER_READY_TIMEOUT_MS}ms`), WORKER_READY_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as {
        type: string;
        requestId?: number;
        faces?: ArrayBuffer;
        tookMs?: number;
        message?: string;
      };
      if (msg.type === "ready") {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        sharedWorkerReady = true;
        resolve(true);
        return;
      }
      if (msg.type === "error") {
        fail(msg.message ?? "unknown error");
        return;
      }
      if (msg.type === "result" && msg.requestId !== undefined) {
        const callback = pendingDetectionCallbacks.get(msg.requestId);
        pendingDetectionCallbacks.delete(msg.requestId);
        callback?.(new Float64Array(msg.faces!), msg.tookMs ?? 0);
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      fail(e.message);
    };

    sharedWorker = worker;
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

// A person-count change only takes effect once this many consecutive
// ticks agree, so a single misdetection doesn't flip the layout and back.
// Three cases: the very first commit (nothing on screen yet, safe to be
// fast), a normal count change (needs more confirmation), and dropping to
// 0/B-roll (faster than a normal change, but not instant either).
const PERSON_COUNT_STABLE_TICKS_INITIAL = 2;
const PERSON_COUNT_STABLE_TICKS = 6;
const PERSON_COUNT_DROP_TO_ZERO_TICKS = 2;

// --- Active-speaker resolution ----------------------------------------
// From this many raw faces up, a plain split/grid stops being a safe
// default — it could be a genuine multi-person conversation, or just one
// person talking with a silent bystander close enough to camera to pass
// the filters (an interview subject with a reporter's face/mic arm in
// frame, a press scrum). See resolveLayoutFaces for how it tells them apart.
const ACTIVE_SPEAKER_THRESHOLD = 2;
// At this face count or below, a scene resolveLayoutFaces can't confidently
// read falls back to the ordinary split/grid instead of showing nothing —
// this is what keeps genuine 2- and 3-person conversations looking normal
// whenever nobody's clearly dominant. Above it, an unresolved scene is
// assumed too crowded to guess at and shows no crop instead.
const AMBIGUOUS_GRID_FALLBACK_FACES = 3;
// RMS energy below which the audio track counts as silence, not speech.
// A rough starting value — hasn't been tuned against real broadcast audio.
const AUDIO_ACTIVE_ENERGY = 0.02;
// A face's mouth-motion score must beat the runner-up by this multiple to
// count as a clear active speaker, once audio has confirmed someone's
// actually talking.
const ACTIVE_SPEAKER_MARGIN = 1.5;
// Same idea, used when audio can't confirm anyone's speaking — which in
// practice is most playback: no audio track at all, muted until the
// viewer unmutes, or silent on cross-origin sources without CORS. Motion
// still gets tried, just held to a stricter margin to make up for the
// missing confirmation.
const ACTIVE_SPEAKER_MARGIN_NO_AUDIO = 2.2;
// A face's size must beat the next-largest by this multiple to count as
// clearly the foregrounded subject — checked before motion, and without
// needing audio. Camera shake reads as motion on every face in a scene;
// framing size doesn't have that problem, and interview subjects are
// usually shot larger than bystanders. Tuned against a real press scrum
// where the actual speaker's face measured about 2x the next-largest.
const FACE_SIZE_DOMINANCE_MARGIN = 1.4;
// How many consecutive ticks a new candidate has to keep winning before
// the engine actually locks onto them — same idea as
// PERSON_COUNT_STABLE_TICKS, applied to who's framed instead of how many.
const ACTIVE_SPEAKER_LOCK_TICKS = 5;
// Two face positions within this distance (fraction of frame) count as
// "the same person" from one tick to the next.
const SAME_PERSON_DISTANCE = 0.08;

// How much each pane's crop glides toward its subject's latest detected
// position per rendered frame (0-1) — gentle camera-follow *within* an
// already-stable layout (same face count), not a trigger for changing the
// layout itself. Lower = slower, calmer follow.
const PANE_SMOOTHING_ALPHA = 0.06;

// A face must drift more than this (a fraction of frame width/height) from
// where its pane's crop was last aimed before the crop moves at all.
const DEADZONE_FRACTION = 0.04;

// How long a layout change (0 -> 2 speakers, 2 -> 3, etc.) takes to
// cross-dissolve from the old framing into the new one, instead of cutting
// instantly.
const LAYOUT_TRANSITION_MS = 250;

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

/** The single face whose score clearly stands out from the rest by at least `margin`×, or null if the top two are too close to call (or there's only a zero-scoring "winner", which isn't one). */
function dominantBy(faces: FaceBox[], scoreOf: (f: FaceBox) => number, margin: number): FaceBox | null {
  const sorted = [...faces].sort((a, b) => scoreOf(b) - scoreOf(a));
  const top = sorted[0];
  const topScore = scoreOf(top);
  if (topScore <= 0) return null;
  const runnerUp = sorted[1];
  if (runnerUp !== undefined && topScore <= scoreOf(runnerUp) * margin) return null;
  return top;
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
  private engine: InstanceType<typeof ReframeEngine> | null = null;
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

  private mode: VertixMode = "9:16";
  private meta: VertixMeta | null = null;
  private metrics: VertixMetrics = INITIAL_METRICS;

  private metricsListeners = new Set<MetricsListener>();
  private stateListeners = new Set<StateListener>();

  // FPS/frame-time measurement.
  private lastFrameTime: number | null = null;
  private fpsEma = 0;
  private frameTimeEma = 0;
  private lastMetricsPush = 0;
  private sceneSwitchCount = 0;

  // Main-thread stall tracking (Long Tasks API — Chromium only). Raw
  // entries land here as they're observed; onVideoFrame's own metrics-push
  // tick (same 300ms cadence as FPS) reduces them down to "ms blocked in
  // the last LONG_TASK_WINDOW_MS" for the dashboard.
  private longTaskObserver: PerformanceObserver | null = null;
  private recentLongTasks: { time: number; duration: number }[] = [];

  private srcDims = { w: 0, h: 0, cropW: 0, cropH: 0 };
  private srcDimsInitialized = false;

  private lastFaces: FaceBox[] = [];
  private lastResolvedFaces: FaceBox[] = [];
  private stablePersonCount = 0;
  private pendingPersonCount = 0;
  private pendingPersonCountStreak = 0;

  private audioMonitor = new AudioActivityMonitor();
  private lockedActiveSpeakerPos: { cx: number; cy: number } | null = null;
  private pendingActiveSpeakerPos: { cx: number; cy: number } | null = null;
  private pendingActiveSpeakerStreak = 0;

  private targetPanes: PaneTarget[] = [];
  private smoothedPanes: PaneRect[] = [];

  private layoutSignature = "";
  private transitionSnapshotCanvas: OffscreenCanvas | null = null;
  private transitionStart: number | null = null;

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
      speakerCount: this.stablePersonCount,
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
    if (this.wasmReady || this.wasmLoading) return;
    this.wasmLoading = initWasm().then(() => {
      this.engine = new ReframeEngine();
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
    this.lastResolvedFaces = [];
    this.stablePersonCount = 0;
    this.pendingPersonCount = 0;
    this.pendingPersonCountStreak = 0;
    this.lockedActiveSpeakerPos = null;
    this.pendingActiveSpeakerPos = null;
    this.pendingActiveSpeakerStreak = 0;
    this.smoothedPanes = [];
    this.targetPanes = [];
    this.layoutSignature = "";
    this.transitionStart = null;
    this.metrics = {
      ...this.metrics,
      faceSizes: [],
      motionScore: null,
      faceConfidence: null,
      audioEnergy: null,
      cropScaleFactor: null,
      layoutCommittedAt: null,
    };
    this.emitState();
    this.emitMetrics();
  }

  private startLoop(): void {
    if (this.running || !this.video) return;
    this.running = true;
    this.video.requestVideoFrameCallback(this.boundOnVideoFrame);
  }

  /**
   * Resolves raw detected faces down to what the layout should actually
   * track this tick. Below ACTIVE_SPEAKER_THRESHOLD, faces pass through
   * unchanged.
   *
   * Above it, a plain split/grid isn't trustworthy anymore — it could be a
   * real multi-person conversation, or one person talking with a silent
   * bystander close enough to camera to pass the filters. This looks for a
   * single active speaker: first by framing size (works without audio),
   * then by mouth motion if sizes are too close to call. A winner has to
   * hold for a few ticks before the engine actually locks onto them, so
   * one noisy read doesn't flip the framing.
   *
   * If neither signal is confident, falls back to the raw faces (today's
   * ordinary split/grid) at AMBIGUOUS_GRID_FALLBACK_FACES or below, or to
   * showing nothing above it — better to punt on a scene we can't read
   * than confidently show the wrong crop.
   *
   * `energy` is the audio reading for this same tick, passed in by the
   * caller rather than read again here to avoid re-summing the analyser
   * buffer twice for the same instant.
   */
  private resolveLayoutFaces(rawFaces: FaceBox[], energy: number | null): FaceBox[] {
    if (rawFaces.length < ACTIVE_SPEAKER_THRESHOLD) return rawFaces;
    const ambiguousFallback = rawFaces.length <= AMBIGUOUS_GRID_FALLBACK_FACES ? rawFaces : [];

    // Size doesn't need audio — every video loads muted by default, so a
    // signal that required audio would go unused until someone unmutes.
    let winner = dominantBy(rawFaces, (f) => Math.max(f.w, f.h), FACE_SIZE_DOMINANCE_MARGIN);

    if (winner === null) {
      // Sizes are too close to call — try motion instead, held to a
      // stricter margin if audio hasn't confirmed anyone's actually
      // talking.
      const audioConfirmed = energy !== null && energy >= AUDIO_ACTIVE_ENERGY;
      winner = dominantBy(
        rawFaces,
        (f) => f.motion,
        audioConfirmed ? ACTIVE_SPEAKER_MARGIN : ACTIVE_SPEAKER_MARGIN_NO_AUDIO
      );
    }

    if (winner === null) {
      // No confident winner this tick — don't restart the lock streak,
      // but don't extend it either. Keep showing whoever's already locked
      // on, if anyone.
      this.pendingActiveSpeakerPos = null;
      this.pendingActiveSpeakerStreak = 0;
      return this.lockedActiveSpeakerPos
        ? [this.closestFaceTo(rawFaces, this.lockedActiveSpeakerPos)]
        : ambiguousFallback;
    }

    const candidate = { cx: winner.cx, cy: winner.cy };
    if (this.pendingActiveSpeakerPos && this.isSamePerson(this.pendingActiveSpeakerPos, candidate)) {
      this.pendingActiveSpeakerStreak += 1;
    } else {
      this.pendingActiveSpeakerPos = candidate;
      this.pendingActiveSpeakerStreak = 1;
    }
    if (this.pendingActiveSpeakerStreak >= ACTIVE_SPEAKER_LOCK_TICKS) {
      this.lockedActiveSpeakerPos = candidate;
    }

    return this.lockedActiveSpeakerPos
      ? [this.closestFaceTo(rawFaces, this.lockedActiveSpeakerPos)]
      : ambiguousFallback;
  }

  private isSamePerson(a: { cx: number; cy: number }, b: { cx: number; cy: number }): boolean {
    return Math.abs(a.cx - b.cx) < SAME_PERSON_DISTANCE && Math.abs(a.cy - b.cy) < SAME_PERSON_DISTANCE;
  }

  private closestFaceTo(faces: FaceBox[], pos: { cx: number; cy: number }): FaceBox {
    return faces.reduce((best, f) => {
      const d = (f.cx - pos.cx) ** 2 + (f.cy - pos.cy) ** 2;
      const bd = (best.cx - pos.cx) ** 2 + (best.cy - pos.cy) ** 2;
      return d < bd ? f : best;
    });
  }

  private dispatchDetection(video: HTMLVideoElement, srcW: number, srcH: number, cropW: number, cropH: number): void {
    const audioEnergy = this.audioMonitor.energy();

    if (sharedWorkerReady && sharedWorker) {
      this.detectionInFlight = true;
      const generation = this.detectionRequestGeneration;
      const requestId = nextDetectionRequestId++;
      pendingDetectionCallbacks.set(requestId, (facesFlat, tookMs) => {
        this.detectionInFlight = false;
        // Belongs to a frame from before a reset (seek, mode change) —
        // discard it instead of feeding stale positions into the layout.
        if (generation !== this.detectionRequestGeneration) return;
        this.processDetectionResult(facesFlat, audioEnergy, srcW, srcH, cropW, cropH, "worker", tookMs);
      });
      // Resizing via createImageBitmap instead of drawImage+getImageData
      // here keeps the main thread from doing a synchronous GPU→CPU
      // readback every detection tick — the worker does that part now
      // (see faceDetectionWorker.ts).
      createImageBitmap(video, { resizeWidth: FACE_W, resizeHeight: FACE_H, resizeQuality: "low" })
        .then((bitmap) => {
          if (generation !== this.detectionRequestGeneration || !sharedWorker) {
            bitmap.close();
            return;
          }
          sharedWorker.postMessage({ type: "detect", requestId, bitmap }, [bitmap]);
        })
        .catch(() => {
          this.detectionInFlight = false;
          pendingDetectionCallbacks.delete(requestId);
        });
    } else {
      // The worker either never became usable, or just stopped being one
      // (a runtime crash after reporting ready — see getSharedDetectionWorker's
      // fail()). Either way, this instance may never have needed its own
      // WASM fallback before now; ensureWasm() is a no-op once it's
      // already loading or ready, so it's safe to call on every tick here.
      this.ensureWasm();
      if (!this.engine) return;
      this.faceCtx.drawImage(video, 0, 0, FACE_W, FACE_H);
      const faceImageData = this.faceCtx.getImageData(0, 0, FACE_W, FACE_H);
      const start = performance.now();
      const facesFlat = this.engine.update_faces(new Uint8Array(faceImageData.data.buffer));
      const tookMs = performance.now() - start;
      this.processDetectionResult(facesFlat, audioEnergy, srcW, srcH, cropW, cropH, "main-thread", tookMs);
    }
  }

  private processDetectionResult(
    facesFlat: Float64Array,
    audioEnergy: number | null,
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number,
    detectionMode: "worker" | "main-thread",
    inferenceMs: number
  ): void {
    // Background people (crowd, players on a pitch) still get detected by
    // the model — only close-up, unclipped faces count as an actual speaker.
    this.lastFaces = unpackFaces(facesFlat).filter(
      (f) =>
        (f.h >= MIN_SPEAKER_FACE_SIZE || f.w >= MIN_SPEAKER_FACE_SIZE) &&
        faceVisibleFraction(f) >= MIN_FACE_VISIBLE_FRACTION
    );

    this.lastResolvedFaces = this.resolveLayoutFaces(this.lastFaces, audioEnergy);
    const count = this.lastResolvedFaces.length;
    if (count === this.pendingPersonCount) {
      this.pendingPersonCountStreak += 1;
    } else {
      this.pendingPersonCount = count;
      this.pendingPersonCountStreak = 1;
    }
    const requiredTicks =
      count === 0
        ? PERSON_COUNT_DROP_TO_ZERO_TICKS
        : this.layoutSignature === ""
          ? PERSON_COUNT_STABLE_TICKS_INITIAL
          : PERSON_COUNT_STABLE_TICKS;
    if (this.pendingPersonCountStreak >= requiredTicks) {
      this.stablePersonCount = count;
    }
    this.emitState();

    const faces = this.lastFaces;
    const faceSizes = faces.map((f) => Math.round(Math.max(f.w, f.h) * 1000) / 10);
    const motionScore = faces.length > 0 ? Math.max(...faces.map((f) => f.motion)) : null;
    const faceConfidence = faces.length > 0 ? faces.reduce((s, f) => s + f.confidence, 0) / faces.length : null;
    this.metrics = {
      ...this.metrics,
      faceSizes,
      motionScore,
      faceConfidence,
      audioAvailable: this.audioMonitor.available,
      audioEnergy,
      detectionMode,
      workerInferenceMs: inferenceMs,
      workerInferenceHistory: appendCapped(this.metrics.workerInferenceHistory, inferenceMs),
      motionHistory:
        motionScore !== null ? appendCapped(this.metrics.motionHistory, motionScore) : this.metrics.motionHistory,
      confidenceHistory:
        faceConfidence !== null
          ? appendCapped(this.metrics.confidenceHistory, faceConfidence)
          : this.metrics.confidenceHistory,
    };
    this.emitMetrics();

    // Only refresh the LERP target once the raw count matches the
    // *committed* layout — otherwise, mid-debounce, this could compute a
    // different pane count than what's actually on screen. The deadzone
    // itself lives inside computeSpeakerLayout.
    if (this.stablePersonCount > 0 && count === this.stablePersonCount) {
      this.targetPanes = computeSpeakerLayout(
        this.lastResolvedFaces,
        srcW,
        srcH,
        cropW,
        cropH,
        this.targetPanes,
        DEADZONE_FRACTION
      );
    }
  }

  // Runs on every decoded frame. Rendering happens synchronously here (not
  // through any framework state) so playback stays perfectly in sync with
  // audio.
  private onVideoFrame(now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void {
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
      video.requestVideoFrameCallback(this.boundOnVideoFrame);
      return;
    }

    // FPS/frame-time, from the actual decoded-frame presentation
    // timestamps rVFC provides — smoothed every frame, pushed to
    // subscribers (and sampled into the trend history) only a few times a
    // second.
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
      if (this.frameCounter % FACE_DETECT_INTERVAL === 0 && !this.detectionInFlight) {
        this.dispatchDetection(video, srcW, srcH, cropW, cropH);
      }

      const targetSignature = this.stablePersonCount === 0 ? "broll" : `speakers:${this.stablePersonCount}`;

      if (targetSignature !== this.layoutSignature) {
        // Snapshot the current frame before it's overwritten, so the layout
        // change dissolves in instead of cutting. Skipped on the very first
        // commit — there's no prior frame to fade from.
        if (this.layoutSignature !== "") {
          this.sceneSwitchCount += 1;
          if (this.transitionStart === null) {
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
          } else {
            // Another layout change landed mid-fade. The canvas right now
            // holds a partial blend, not a clean frame — cut straight to
            // the new layout instead of stacking a second fade on top of it.
            this.transitionStart = null;
          }
        }
        this.layoutSignature = targetSignature;

        // A new layout snaps straight to its target instead of gliding in
        // from the old positions.
        this.targetPanes =
          this.stablePersonCount === 0 ? [] : computeSpeakerLayout(this.lastResolvedFaces, srcW, srcH, cropW, cropH);
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
      }

      if (this.stablePersonCount === 0) {
        drawFitFrame(ctx, this.blurCanvas, video, srcW, srcH, cropW, cropH);
      } else {
        // Mutate the already-allocated smoothed rects toward the cached
        // target and draw with integer coordinates (avoids sub-pixel blit
        // interpolation). No new objects, no layout math — that only runs
        // at detection ticks, above.
        for (let i = 0; i < this.targetPanes.length; i++) {
          const target = this.targetPanes[i].pane;
          const smoothed = lerpPaneRectInto(this.smoothedPanes[i], target.source, PANE_SMOOTHING_ALPHA);
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

    video.requestVideoFrameCallback(this.boundOnVideoFrame);
  }
}
