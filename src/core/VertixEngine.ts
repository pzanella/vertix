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
import { DecisionTimeline, mergeDecisions, type LayoutDecision, type Reframe } from "./lookahead/decisionTimeline";
import { FrameRingBuffer, type BufferedFrame } from "./lookahead/frameRingBuffer";
import { TRIGGER_H, TRIGGER_W, locateCut, type ScoredFrame } from "./lookahead/cutTrigger";
import {
  DEFAULT_DETECTION_P95_MS,
  DEFAULT_FRAME_INTERVAL_MS,
  DEFAULT_TRIGGER_P95_MS,
  RollingP95,
  chooseSlotSize,
  detectDeviceClass,
  loadStoredDetectionP95,
  lookaheadLengthMs,
  storeDetectionP95,
  type SlotSize,
} from "./lookahead/lookaheadSizing";
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
  /** Media time of the frame currently on screen (behind `video.currentTime` by the lookahead while playing). Null before the first frame, and right after a seek until a new frame is shown. */
  displayedMediaTimeSec: number | null;
  lookahead: LookaheadStatus;
}

/** Why lookahead is forced off although switched on. */
export type LookaheadUnavailableReason =
  /** The Web Audio graph could not be built: the element plays its own audio, which cannot be delayed. */
  | "no-audio-graph"
  /** Cross-origin source without CORS: frames can't be read and the graph only carries silence. */
  | "cross-origin"
  /** The graph carries exact silence while the element plays unmuted audio (same cause, detected from the audio side). */
  | "silent-audio-path";

export interface LookaheadStatus {
  /** The switch: lookahead wanted. */
  enabled: boolean;
  /** Set when lookahead is wanted but forced off. */
  unavailableReason: LookaheadUnavailableReason | null;
  /** How far behind the decoded frame the output (and audio) is shown, in ms. 0 when off. */
  lengthMs: number;
  /** Size of one buffered frame, null until the first frame is buffered. */
  slotWidth: number | null;
  slotHeight: number | null;
  /** Frame copies allocated so far, and their memory (RGBA estimate). */
  allocatedSlots: number;
  bufferBytes: number;
  /** Frames captured and waiting for display. */
  bufferedFrames: number;
  /** Frames never displayed since this source was loaded: dropped because the buffer was full, or superseded on display. */
  droppedFrames: number;
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
  displayedMediaTimeSec: null,
  lookahead: {
    enabled: true,
    unavailableReason: null,
    lengthMs: 0,
    slotWidth: null,
    slotHeight: null,
    allocatedSlots: 0,
    bufferBytes: 0,
    bufferedFrames: 0,
    droppedFrames: 0,
  },
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
// Per-frame cut-trigger scores kept for cut localisation: a few seconds,
// well over the gap between two detections.
const SCORED_FRAME_HISTORY = 120;
// A frame shown while paused waits for its own detection this long at most.
const HELD_FRAME_TIMEOUT_MS = 500;
// Frame rate assumed for sizing the frame buffer before one is measured.
const ASSUMED_FPS = 30;
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
  video: CanvasImageSource,
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

interface FrameSlot {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
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
  // Per-detection counts for the benchmark probe.
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

  // Decision side: what the latest detection decided, before it is shown.
  private decidedTargetPanes: PaneTarget[] = [];
  private decidedSpeakerCount = 0;
  // True once a frame was rendered (or buffered) since the last reset: the
  // no-crop layout counts as committed from then on.
  private hasFrameSinceReset = false;
  private decisions = new DecisionTimeline();

  // Display side: what the frame on screen uses.
  private displayedSpeakerCount = 0;
  private displayedSkinRejectedFaces: FaceBox[] = [];
  private targetPanes: PaneTarget[] = [];
  private smoothedPanes: PaneRect[] = [];

  private layoutSignature = "";
  // Set by an applied decision, consumed by the frame it was applied on.
  private pendingReframe: Reframe | null = null;
  private transitionSnapshotCanvas: OffscreenCanvas | null = null;
  private transitionStart: number | null = null;

  // Lookahead: the output is shown lookaheadLengthMs behind the decoded
  // frame, so each frame's detection result is in before it is displayed.
  private lookaheadEnabled = true;
  private lookaheadUnavailable: LookaheadUnavailableReason | null = null;
  private lookaheadLengthMs = 0;
  private sourceTainted = false;
  private readonly deviceClass = detectDeviceClass();
  private frameBuffer: FrameRingBuffer<FrameSlot> | null = null;
  private slotSize: SlotSize | null = null;
  private captureIndex = 0;
  private nextDetectionFrameIndex = FACE_DETECT_INTERVAL;
  private lastCapturedMediaTime: number | null = null;
  private frameIntervalMediaSec: number | null = null;
  private lastFrameMediaTime: number | null = null;
  private heldFrameTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
  private displayFrameId: number | null = null;
  private lastDisplayCallbackAt: number | null = null;
  private lastDisplayedAt: number | null = null;
  private refreshIntervalMs = 1000 / 60;
  private displayedMediaTimeSec: number | null = null;
  // Detection round trips (dispatch → result) of the current WASM build, for the lookahead length.
  private detectionLatency = new RollingP95();
  private detectionLatencyBuild: WasmBuildVariant | null = null;
  private triggerLatency = new RollingP95();
  private taintProbeCtx: OffscreenCanvasRenderingContext2D | null = null;

  // Per-frame cut trigger (lookahead only): scores every buffered frame in
  // its own worker and asks for a detection right away on a likely cut.
  private cutTriggerWorker: Worker | null = null;
  private cutTriggerUnavailable = false;
  private cutTriggerGeneration = 0;
  private pendingTriggerFrames = new Map<number, { mediaTimeSec: number; capturedAt: number }>();
  private scoredFrames: ScoredFrame[] = [];
  private pendingCutDetectionSec: number | null = null;
  private lastDispatchedDetectionSec: number | null = null;

  // Benchmark mode only (see src/core/bench). Null in normal playback, where
  // every instrumentation point below reduces to a single null check.
  private benchmarkProbe: BenchmarkProbe | null = null;

  private boundOnVideoFrame = this.onVideoFrame.bind(this);
  private boundOnPlay = () => this.startLoop();
  private boundOnSeeking = () => this.onSeeking();
  private boundOnPlayForHeldFrames = () => this.releaseHeldFrames();
  private boundOnDisplayFrame = this.onDisplayFrame.bind(this);
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
    video.addEventListener("play", this.boundOnPlayForHeldFrames);
    video.addEventListener("seeking", this.boundOnSeeking);
    video.addEventListener("loadedmetadata", this.boundOnLoadedMetadata);

    if (!video.paused) this.startLoop();
  }

  /** Stops rendering and removes all listeners from the current video. Keeps the WASM engine warm for a future `attach`. */
  detach(): void {
    if (!this.video) return;
    this.video.removeEventListener("play", this.boundOnPlay);
    this.video.removeEventListener("play", this.boundOnPlayForHeldFrames);
    this.video.removeEventListener("seeking", this.boundOnSeeking);
    this.video.removeEventListener("loadedmetadata", this.boundOnLoadedMetadata);
    if (this.frameCallbackId !== null) this.video.cancelVideoFrameCallback(this.frameCallbackId);
    this.frameCallbackId = null;
    this.running = false;
    this.stopDisplayLoop();
    clearTimeout(this.heldFrameTimeout);
    this.frameBuffer = null;
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
    this.taintProbeCtx = null;
    this.cutTriggerWorker?.terminate();
    this.cutTriggerWorker = null;
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

  /**
   * Turns lookahead on or off at runtime. Either way the change is one
   * short gap: the buffered frames are dropped, and the audio is silent
   * until audio delayed by the new amount comes out.
   */
  setLookaheadEnabled(enabled: boolean): void {
    if (enabled === this.lookaheadEnabled) return;
    this.lookaheadEnabled = enabled;
    this.refreshLookahead(true);
  }

  getLookaheadStatus(): LookaheadStatus {
    return this.lookaheadStatus();
  }

  /** Media time of the frame on screen, or null (see VertixMetrics.displayedMediaTimeSec). */
  getDisplayedMediaTime(): number | null {
    return this.displayedMediaTimeSec;
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
      speakerCount: this.displayedSpeakerCount,
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
    this.sourceTainted = false;
    this.flushLookahead();
    this.frameBuffer = null;
    this.captureIndex = 0;
    this.nextDetectionFrameIndex = FACE_DETECT_INTERVAL;
    this.frameIntervalMediaSec = null;
    this.lastFrameMediaTime = null;
    this.displayedMediaTimeSec = null;
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
    this.refreshLookahead(true);
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
    this.lastDispatchedDetectionSec = null;
    this.pendingCutDetectionSec = null;
    this.resetCutTrigger();
    this.detectionIntervalEma = 0;
    this.personCount.reset();
    this.activeSpeaker.reset();
    this.decidedTargetPanes = [];
    this.decidedSpeakerCount = 0;
    this.hasFrameSinceReset = false;
    this.decisions.clear();
    this.displayedSpeakerCount = 0;
    this.displayedSkinRejectedFaces = [];
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

  private onSeeking(): void {
    this.resetTrackingState();
    this.flushLookahead();
    this.displayedMediaTimeSec = null;
    this.nextDetectionFrameIndex = this.captureIndex + FACE_DETECT_INTERVAL;
    this.lastFrameMediaTime = null;
    // A flush point: the lookahead length may follow what was measured so far.
    this.refreshLookahead(true);
  }

  /**
   * Drops buffered frames, and silences the audio still in the delay line
   * (it belongs to frames that will never be shown). The last frame shown
   * stays on the canvas until new frames are due.
   */
  private flushLookahead(): void {
    this.frameBuffer?.flush();
    this.frameBuffer?.resetCounters();
    this.stopDisplayLoop();
    clearTimeout(this.heldFrameTimeout);
    if (this.lookaheadLengthMs > 0) this.audioMonitor.muteFor(this.lookaheadLengthMs / 1000);
  }

  /**
   * Re-evaluates whether lookahead can run and how long it is. With
   * `recomputeLength` false (mid-playback), an active lookahead keeps its
   * length: only a flush point (seek, source change, the switch) may change
   * it, so playback never jumps on its own.
   */
  private refreshLookahead(recomputeLength: boolean): void {
    this.lookaheadUnavailable = !this.audioMonitor.available
      ? "no-audio-graph"
      : this.sourceTainted
        ? "cross-origin"
        : this.audioMonitor.silentPathSuspected
          ? "silent-audio-path"
          : null;
    const active = this.lookaheadEnabled && this.lookaheadUnavailable === null;
    const lengthMs = !active
      ? 0
      : recomputeLength || this.lookaheadLengthMs === 0
        ? this.computeLookaheadLengthMs()
        : this.lookaheadLengthMs;
    if (lengthMs !== this.lookaheadLengthMs) {
      this.flushLookahead();
      this.lookaheadLengthMs = lengthMs;
      this.audioMonitor.setOutputDelay(lengthMs / 1000);
      // Sized for the new length on the next captured frame.
      this.frameBuffer = null;
      this.nextDetectionFrameIndex = this.captureIndex + 1;
    }
    this.metrics = { ...this.metrics, lookahead: this.lookaheadStatus() };
    this.emitMetrics();
  }

  private computeLookaheadLengthMs(): number {
    const build = getActiveWasmBuild().variant;
    if (this.detectionLatencyBuild !== build) {
      this.detectionLatency = new RollingP95();
      this.detectionLatencyBuild = build;
    }
    const measured = this.detectionLatency.p95();
    if (measured !== null) storeDetectionP95(build, measured);
    const detectionP95 = measured ?? loadStoredDetectionP95(build) ?? DEFAULT_DETECTION_P95_MS[this.deviceClass][build];
    const playbackRate = this.video?.playbackRate || 1;
    const frameIntervalMs =
      this.frameIntervalMediaSec !== null
        ? (this.frameIntervalMediaSec * 1000) / playbackRate
        : DEFAULT_FRAME_INTERVAL_MS;
    return lookaheadLengthMs(detectionP95, this.triggerLatency.p95() ?? DEFAULT_TRIGGER_P95_MS, frameIntervalMs);
  }

  private lookaheadStatus(): LookaheadStatus {
    const buffer = this.frameBuffer;
    const allocatedSlots = buffer?.allocatedSlots ?? 0;
    return {
      enabled: this.lookaheadEnabled,
      unavailableReason: this.lookaheadEnabled ? this.lookaheadUnavailable : null,
      lengthMs: this.lookaheadLengthMs,
      slotWidth: buffer ? (this.slotSize?.width ?? null) : null,
      slotHeight: buffer ? (this.slotSize?.height ?? null) : null,
      allocatedSlots,
      bufferBytes: allocatedSlots * (this.slotSize?.bytesPerSlot ?? 0),
      bufferedFrames: buffer?.length ?? 0,
      droppedFrames: buffer ? buffer.overflowDrops + buffer.skippedOnDisplay : 0,
    };
  }

  /** Media-time step between frames (EMA), for the buffer size and the lookahead margin. */
  private trackFrameInterval(mediaTimeSec: number): void {
    const last = this.lastFrameMediaTime;
    this.lastFrameMediaTime = mediaTimeSec;
    if (last === null) return;
    const step = mediaTimeSec - last;
    if (step <= 0 || step > 0.5) return;
    this.frameIntervalMediaSec =
      this.frameIntervalMediaSec === null
        ? step
        : this.frameIntervalMediaSec + (step - this.frameIntervalMediaSec) * 0.1;
  }

  /** False when the video taints a canvas (cross-origin without CORS). */
  private isFrameReadable(video: HTMLVideoElement): boolean {
    try {
      this.taintProbeCtx ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
      this.taintProbeCtx!.drawImage(video, 0, 0, 1, 1);
      this.taintProbeCtx!.getImageData(0, 0, 1, 1);
      return true;
    } catch {
      return false;
    }
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
    const faces = this.displayedSkinRejectedFaces;
    if (faces.length === 0 || this.mode === "16:9") return;

    const { w: srcW, h: srcH } = this.srcDims;
    const fittedHeight = Math.round(srcH * (outW / srcW));
    const views: { source: PaneRect; dest: PaneRect }[] =
      this.displayedSpeakerCount === 0
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
    source: HTMLVideoElement | OffscreenCanvas,
    mediaTimeSec: number,
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number
  ): void {
    const probe = this.benchmarkProbe;
    const dispatchedAt = performance.now();
    const previousDetectionSec = this.lastDispatchedDetectionSec;
    const audioEnergy = this.audioMonitor.energy();

    if (sharedWorkerReady && sharedWorker) {
      this.detectionInFlight = true;
      this.lastDispatchedDetectionSec = mediaTimeSec;
      const generation = this.detectionRequestGeneration;
      const requestId = nextDetectionRequestId++;
      let bitmapReadyAt = 0;
      const onResult = (facesFlat: Float64Array, cutScoresFlat: Float64Array, tookMs: number, readbackMs: number) => {
        this.detectionInFlight = false;
        // Belongs to a frame from before a reset (seek, mode change) —
        // discard it instead of feeding stale positions into the layout.
        if (generation !== this.detectionRequestGeneration) return;
        const postStart = performance.now();
        this.detectionLatency.push(postStart - dispatchedAt);
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
          tookMs,
          previousDetectionSec
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
        this.dispatchPendingCutDetection();
      };
      pendingDetections.set(requestId, {
        onResult,
        onCancel: () => {
          this.detectionInFlight = false;
          this.pendingCutDetectionSec = null;
        },
      });
      // Resizing via createImageBitmap instead of drawImage+getImageData
      // here keeps the main thread from doing a synchronous GPU→CPU
      // readback every detection tick — the worker does that part now
      // (see faceDetectionWorker.ts).
      createImageBitmap(source, { resizeWidth: FACE_W, resizeHeight: FACE_H, resizeQuality: "low" })
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
          this.pendingCutDetectionSec = null;
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
      this.lastDispatchedDetectionSec = mediaTimeSec;
      this.faceCtx.drawImage(source, 0, 0, FACE_W, FACE_H);
      const drawnAt = probe ? performance.now() : 0;
      const faceImageData = this.faceCtx.getImageData(0, 0, FACE_W, FACE_H);
      const start = performance.now();
      const facesFlat = this.engine.update_faces(new Uint8Array(faceImageData.data.buffer), mediaTimeSec);
      const tookMs = performance.now() - start;
      this.detectionLatency.push(performance.now() - dispatchedAt);
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
        tookMs,
        previousDetectionSec
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
    inferenceMs: number,
    previousDetectionSec: number | null = null
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
      : this.personCount.observe(count, this.hasFrameSinceReset, mediaTimeSec);
    // With lookahead, a cut found here is shown from the frame where it
    // happened (the biggest per-frame jump since the previous detection),
    // not from this detection frame.
    const decisionSec =
      sceneCut.isCut && this.lookaheadLengthMs > 0
        ? locateCut(this.scoredFrames, previousDetectionSec, mediaTimeSec)
        : mediaTimeSec;
    this.decideLayout(decisionSec, count, stablePersonCount, sceneCut.isCut, srcW, srcH, cropW, cropH);

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
  }

  /** Turns one detection into a LayoutDecision for the frame at `mediaTimeSec`, and queues it for display. */
  private decideLayout(
    mediaTimeSec: number,
    count: number,
    stablePersonCount: number,
    isCut: boolean,
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number
  ): void {
    const countChanged = stablePersonCount !== this.decidedSpeakerCount;
    let reframe: Reframe | null = isCut ? "snap" : null;
    if (stablePersonCount === 0) {
      this.decidedTargetPanes = [];
    } else if (count === stablePersonCount) {
      // Only refresh the target once the raw count matches the *committed*
      // layout — otherwise, mid-debounce, this could compute a different
      // pane count than what's actually on screen. The deadzone itself
      // lives inside computeSpeakerLayout. A reframe or a new layout aims
      // straight at the new faces, without the deadzone.
      if (this.activeSpeaker.switchedSpeaker) reframe ??= "dissolve";
      this.decidedTargetPanes =
        reframe !== null || countChanged
          ? computeSpeakerLayout(this.lastResolvedFaces, srcW, srcH, cropW, cropH)
          : computeSpeakerLayout(
              this.lastResolvedFaces,
              srcW,
              srcH,
              cropW,
              cropH,
              this.decidedTargetPanes,
              DEADZONE_FRACTION
            );
    }
    this.decidedSpeakerCount = stablePersonCount;
    this.decisions.push({
      mediaTimeSec,
      speakerCount: stablePersonCount,
      targetPanes: this.decidedTargetPanes,
      reframe,
      isCut,
      skinRejectedFaces: this.lastSkinRejectedFaces,
    });
    if (this.video?.paused) this.releaseHeldFrames();
  }

  /** Applies the decisions due for the frame about to be drawn; with `onlyUpToSec` null, every queued one (no lookahead: they are already late). */
  private applyDueDecisions(onlyUpToSec: number | null): LayoutDecision | null {
    const decision = mergeDecisions(
      onlyUpToSec === null ? this.decisions.takeAll() : this.decisions.takeDue(onlyUpToSec)
    );
    if (!decision) return null;
    const countChanged = decision.speakerCount !== this.displayedSpeakerCount;
    this.displayedSpeakerCount = decision.speakerCount;
    this.displayedSkinRejectedFaces = decision.skinRejectedFaces;
    this.targetPanes = decision.targetPanes;
    this.pendingReframe = decision.reframe;
    if (countChanged) this.emitState();
    return decision;
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

  // Runs on every decoded frame. Without lookahead the frame is rendered
  // right here, synchronously (not through any framework state), so it
  // stays in sync with audio. With lookahead it is copied into the frame
  // buffer and rendered by the display loop LOOKAHEAD later, with the
  // audio delayed by the same amount.
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
      if (video.paused && !video.ended && this.lookaheadLengthMs > 0 && this.srcDimsInitialized) {
        this.capturePausedFrame(video, metadata);
      }
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
    this.trackFrameInterval(metadata.mediaTime);
    if (now - this.lastMetricsPush > 300) {
      this.lastMetricsPush = now;
      if (this.audioMonitor.silentPathSuspected !== this.audioMonitor.checkSilentPath(video, now)) {
        this.refreshLookahead(false);
      }
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
        displayedMediaTimeSec: this.displayedMediaTimeSec,
        lookahead: this.lookaheadStatus(),
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

      const tainted = !this.isFrameReadable(video);
      if (tainted !== this.sourceTainted) {
        this.sourceTainted = tainted;
        this.refreshLookahead(true);
      }
    }

    if (this.lookaheadLengthMs > 0) {
      this.captureFrame(video, metadata, now);
    } else {
      this.renderLiveFrame(video, metadata, now, frameDtSec);
    }

    if (probe) probe.recordFrame(now, performance.now() - workStart, metadata.mediaTime, metadata.presentedFrames);
    this.scheduleNextFrame(video);
  }

  /** No lookahead: detection on this frame if due, then draw it straight from the video. */
  private renderLiveFrame(
    video: HTMLVideoElement,
    metadata: VideoFrameCallbackMetadata,
    now: number,
    frameDtSec: number
  ): void {
    const { w: srcW, h: srcH, cropW, cropH } = this.srcDims;
    if (this.mode === "9:16") {
      this.hasFrameSinceReset = true;
      this.frameCounter += 1;
      if (this.frameCounter % FACE_DETECT_INTERVAL === 0) {
        if (!this.detectionInFlight) {
          this.dispatchDetection(video, metadata.mediaTime, srcW, srcH, cropW, cropH);
        } else {
          this.benchmarkProbe?.recordSkippedDetection();
        }
      }
    }
    this.renderFrame(video, srcW, srcH, null, now, frameDtSec);
    this.displayedMediaTimeSec = metadata.mediaTime;
  }

  /** Lookahead: copies the frame into the buffer, due LOOKAHEAD after its own display time, and runs detection on it if due. */
  private captureFrame(video: HTMLVideoElement, metadata: VideoFrameCallbackMetadata, now: number): void {
    const frame = this.bufferFrame(
      video,
      metadata.mediaTime,
      (metadata.expectedDisplayTime ?? now) + this.lookaheadLengthMs
    );
    if (this.mode === "9:16") {
      this.hasFrameSinceReset = true;
      if (frame.frameIndex >= this.nextDetectionFrameIndex) {
        this.nextDetectionFrameIndex = frame.frameIndex + FACE_DETECT_INTERVAL;
        if (!this.detectionInFlight) {
          this.dispatchDetection(frame.slot.canvas, frame.mediaTimeSec, ...this.cropArgs());
        } else {
          this.benchmarkProbe?.recordSkippedDetection();
        }
      }
      this.scoreFrameForCut(frame);
    }
    this.ensureDisplayLoop();
  }

  private ensureCutTriggerWorker(): Worker | null {
    if (this.cutTriggerWorker || this.cutTriggerUnavailable) return this.cutTriggerWorker;
    try {
      const worker = new Worker(`${import.meta.env.BASE_URL}workers/cutTriggerWorker.js`);
      worker.onmessage = (e: MessageEvent) => this.onCutTriggerScore(e.data);
      worker.onerror = () => {
        console.error("[Vertix] Cut-trigger worker failed; cuts are applied at detection rate.");
        worker.terminate();
        this.cutTriggerWorker = null;
        this.cutTriggerUnavailable = true;
      };
      this.cutTriggerWorker = worker;
    } catch {
      this.cutTriggerUnavailable = true;
    }
    return this.cutTriggerWorker;
  }

  /** Sends a thumbnail of a buffered frame to the cut trigger. Only the createImageBitmap/postMessage calls run here. */
  private scoreFrameForCut(frame: BufferedFrame<FrameSlot>): void {
    const worker = this.ensureCutTriggerWorker();
    if (!worker) return;
    const start = performance.now();
    const generation = this.cutTriggerGeneration;
    const probe = this.benchmarkProbe;
    this.pendingTriggerFrames.set(frame.frameIndex, { mediaTimeSec: frame.mediaTimeSec, capturedAt: start });
    let syncMs = 0;
    createImageBitmap(frame.slot.canvas, { resizeWidth: TRIGGER_W, resizeHeight: TRIGGER_H, resizeQuality: "low" })
      .then((bitmap) => {
        const postStart = performance.now();
        if (generation !== this.cutTriggerGeneration || worker !== this.cutTriggerWorker) {
          bitmap.close();
          return;
        }
        worker.postMessage({ type: "score", frameId: frame.frameIndex, bitmap }, [bitmap]);
        probe?.recordTriggerCost(syncMs + performance.now() - postStart);
      })
      .catch(() => this.pendingTriggerFrames.delete(frame.frameIndex));
    syncMs = performance.now() - start;
  }

  private onCutTriggerScore(msg: { frameId: number; hist: number; grid: number; triggered: boolean }): void {
    const pending = this.pendingTriggerFrames.get(msg.frameId);
    if (!pending) return;
    this.pendingTriggerFrames.delete(msg.frameId);
    this.triggerLatency.push(performance.now() - pending.capturedAt);
    if (this.scoredFrames.length === SCORED_FRAME_HISTORY) this.scoredFrames.shift();
    this.scoredFrames.push({ mediaTimeSec: pending.mediaTimeSec, score: Math.max(msg.hist, msg.grid) });
    if (msg.triggered && this.mode === "9:16") this.requestCutDetection(pending.mediaTimeSec);
  }

  /** A detection on the likely cut frame now, instead of at the next regular tick (after the one in flight, if any). */
  private requestCutDetection(mediaTimeSec: number): void {
    // A detection on this frame or a later one already covers the cut; if
    // it finds it, cut localisation moves the change back to this frame.
    if (this.lastDispatchedDetectionSec !== null && this.lastDispatchedDetectionSec >= mediaTimeSec) return;
    if (this.detectionInFlight) {
      this.pendingCutDetectionSec = mediaTimeSec;
      return;
    }
    const frame = this.frameBuffer?.find(mediaTimeSec);
    if (!frame) return;
    this.nextDetectionFrameIndex = frame.frameIndex + FACE_DETECT_INTERVAL;
    this.dispatchDetection(frame.slot.canvas, mediaTimeSec, ...this.cropArgs());
  }

  private dispatchPendingCutDetection(): void {
    const pending = this.pendingCutDetectionSec;
    if (pending === null) return;
    this.pendingCutDetectionSec = null;
    this.requestCutDetection(pending);
  }

  private resetCutTrigger(): void {
    this.cutTriggerGeneration += 1;
    this.pendingTriggerFrames.clear();
    this.scoredFrames = [];
    this.cutTriggerWorker?.postMessage({ type: "reset" });
  }

  /**
   * A new frame while paused (a seek, or a source's first frame): held
   * until its own detection result is in, so it is shown with the right
   * crop, or HELD_FRAME_TIMEOUT_MS at most.
   */
  private capturePausedFrame(video: HTMLVideoElement, metadata: VideoFrameCallbackMetadata): void {
    if (metadata.mediaTime === this.lastCapturedMediaTime) return;
    const frame = this.bufferFrame(video, metadata.mediaTime, Infinity);
    if (this.mode === "9:16" && !this.detectionInFlight) {
      this.dispatchDetection(frame.slot.canvas, frame.mediaTimeSec, ...this.cropArgs());
    }
    clearTimeout(this.heldFrameTimeout);
    this.heldFrameTimeout = setTimeout(() => this.releaseHeldFrames(), HELD_FRAME_TIMEOUT_MS);
  }

  private releaseHeldFrames(): void {
    clearTimeout(this.heldFrameTimeout);
    if (!this.frameBuffer) return;
    this.frameBuffer.releaseHeld(performance.now());
    this.ensureDisplayLoop();
  }

  private cropArgs(): [number, number, number, number] {
    const { w, h, cropW, cropH } = this.srcDims;
    return [w, h, cropW, cropH];
  }

  private bufferFrame(video: HTMLVideoElement, mediaTimeSec: number, dueMs: number): BufferedFrame<FrameSlot> {
    const buffer = this.ensureFrameBuffer();
    const slot = buffer.acquire();
    slot.ctx.drawImage(video, 0, 0, slot.canvas.width, slot.canvas.height);
    this.captureIndex += 1;
    this.lastCapturedMediaTime = mediaTimeSec;
    const frame = { slot, mediaTimeSec, dueMs, frameIndex: this.captureIndex };
    buffer.enqueue(frame);
    return frame;
  }

  private ensureFrameBuffer(): FrameRingBuffer<FrameSlot> {
    if (this.frameBuffer) return this.frameBuffer;
    const { w, h } = this.srcDims;
    const fps = this.frameIntervalMediaSec !== null ? 1 / this.frameIntervalMediaSec : ASSUMED_FPS;
    const size = chooseSlotSize(w, h, this.lookaheadLengthMs, fps, this.video?.playbackRate ?? 1);
    this.slotSize = size;
    this.frameBuffer = new FrameRingBuffer(() => {
      const canvas = new OffscreenCanvas(size.width, size.height);
      return { canvas, ctx: canvas.getContext("2d", { alpha: false })! };
    }, size.maxSlots);
    return this.frameBuffer;
  }

  private ensureDisplayLoop(): void {
    if (this.displayFrameId === null) this.displayFrameId = requestAnimationFrame(this.boundOnDisplayFrame);
  }

  private stopDisplayLoop(): void {
    if (this.displayFrameId !== null) cancelAnimationFrame(this.displayFrameId);
    this.displayFrameId = null;
    this.lastDisplayCallbackAt = null;
    this.lastDisplayedAt = null;
  }

  /**
   * Lookahead display loop, once per screen refresh while frames are
   * waiting. Draws the latest frame whose due time falls on the next
   * refresh (what is drawn now reaches the screen about one refresh later),
   * with the decisions for its media time.
   */
  private onDisplayFrame(now: DOMHighResTimeStamp): void {
    this.displayFrameId = null;
    const buffer = this.frameBuffer;
    if (!buffer || !this.canvas) return;

    if (this.lastDisplayCallbackAt !== null) {
      const dt = now - this.lastDisplayCallbackAt;
      if (dt > 4 && dt < 50) this.refreshIntervalMs += (dt - this.refreshIntervalMs) * 0.1;
    }
    this.lastDisplayCallbackAt = now;

    const onScreenAt = now + this.refreshIntervalMs;
    const frame = buffer.takeDue(onScreenAt + this.refreshIntervalMs / 2);
    if (frame) {
      const frameDtSec = this.lastDisplayedAt !== null ? (now - this.lastDisplayedAt) / 1000 : 0;
      this.lastDisplayedAt = now;
      this.renderFrame(
        frame.slot.canvas,
        frame.slot.canvas.width,
        frame.slot.canvas.height,
        frame.mediaTimeSec,
        now,
        frameDtSec
      );
      buffer.release(frame);
      this.displayedMediaTimeSec = frame.mediaTimeSec;
    }

    if (buffer.length > 0) {
      this.ensureDisplayLoop();
    } else if (this.video?.paused) {
      this.lastDisplayCallbackAt = null;
      this.lastDisplayedAt = null;
      this.metrics = {
        ...this.metrics,
        displayedMediaTimeSec: this.displayedMediaTimeSec,
        lookahead: this.lookaheadStatus(),
      };
      this.emitMetrics();
    }
  }

  /**
   * Draws one output frame from `source` (the video, or a buffered copy of
   * size sourceW × sourceH), after applying the layout decisions due for
   * it: those up to `decisionsUpToSec`, or all of them when null.
   */
  private renderFrame(
    source: CanvasImageSource,
    sourceW: number,
    sourceH: number,
    decisionsUpToSec: number | null,
    now: number,
    frameDtSec: number
  ): void {
    const canvas = this.canvas!;
    const probe = this.benchmarkProbe;
    const { w: srcW, h: srcH, cropW, cropH } = this.srcDims;
    const currentMode = this.mode;
    // Crop rects are in source-video pixels; a buffered copy may be smaller.
    const scaleX = sourceW / srcW;
    const scaleY = sourceH / srcH;

    const targetW = currentMode === "16:9" ? srcW : cropW;
    const targetH = currentMode === "16:9" ? srcH : cropH;
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    if (!this.outputCtx) this.outputCtx = canvas.getContext("2d");
    const ctx = this.outputCtx!;

    if (currentMode === "16:9") {
      ctx.drawImage(source, 0, 0, srcW, srcH);
    } else {
      // "9:16" mode: 0 faces -> full frame, no crop; N>=1 -> N panes, each a
      // cover-crop following its face. The layout (pane count/positions) is
      // committed once per debounced face-count change and held fixed;
      // within it, each pane's crop only drifts smoothly toward its target.
      this.applyDueDecisions(decisionsUpToSec);
      const speakerCount = this.displayedSpeakerCount;
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
        drawFitFrame(ctx, this.blurCanvas, source, srcW, srcH, cropW, cropH);
      } else {
        // Mutate the already-allocated smoothed rects toward the cached
        // target and draw with integer coordinates (avoids sub-pixel blit
        // interpolation). No new objects, no layout math — that only runs
        // at detection ticks.
        const smoothingAlpha = paneSmoothingAlpha(frameDtSec);
        for (let i = 0; i < this.targetPanes.length; i++) {
          const target = this.targetPanes[i].pane;
          const smoothed = lerpPaneRectInto(this.smoothedPanes[i], target.source, smoothingAlpha);
          ctx.drawImage(
            source,
            Math.round(smoothed.x * scaleX),
            Math.round(smoothed.y * scaleY),
            Math.round(smoothed.w * scaleX),
            Math.round(smoothed.h * scaleY),
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
  }
}
