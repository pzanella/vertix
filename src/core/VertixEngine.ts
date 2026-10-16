import { AudioActivityMonitor } from "./audioActivity";
import { PersonCountDebouncer } from "./personCount";
import {
  LayoutPlanner,
  layoutKey,
  paneCountOf,
  SWITCH_DISSOLVE_DISTANCE,
  type LayoutPlan,
  type LayoutRule,
  type TrackSnapshot,
} from "./tracking/layoutPlanner";
import type { PanelVariant } from "./tracking/panelDetector";
import { displayedSourceSize, fittedOutputSize, isShownAsIs } from "./sourceAspect";
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
  DecisionTimeline,
  mergeDecisions,
  type CutSource,
  type LayoutDecision,
  type Reframe,
} from "./lookahead/decisionTimeline";
import { FrameRingBuffer, type BufferedFrame } from "./lookahead/frameRingBuffer";
import { TRIGGER_SOURCE_H, TRIGGER_SOURCE_W, locateCut, type ScoredFrame } from "./lookahead/cutTrigger";
import { DetectionLatencyTracker } from "./lookahead/detectionLatency";
import {
  ASSUMED_MAX_FPS,
  BYTES_PER_PIXEL,
  DEFAULT_DETECTION_P95_MS,
  DEFAULT_FRAME_INTERVAL_MS,
  DEFAULT_TRIGGER_P95_MS,
  FRAME_BUFFER_BUDGET_BYTES,
  RollingP95,
  alignToFrames,
  chooseSlotSize,
  detectDeviceClass,
  loadStoredDetectionP95,
  lookaheadLengthMs,
  maxSlotsFor,
  slotsForDelay,
  storeDetectionP95,
  type FrameAlignedDelay,
  type SlotSize,
} from "./lookahead/lookaheadSizing";
import { DelaySchedule } from "./lookahead/delaySchedule";
import { FrameIntervalTracker } from "./lookahead/frameInterval";
import {
  HIGH_FRAME_RATE_FPS,
  REDUCED_SLOT_HEIGHT,
  SlotHeightGovernor,
  type SlotHeightChangeReason,
} from "./lookahead/slotHeightGovernor";
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
  /** The graph carries exact silence while a cross-origin element plays unmuted audio (same cause, detected from the audio side). */
  | "silent-audio-path";

/** A change of the frame-copy height: the governor's decision ("drops", "overflow", "recovered", "frame-rate") or a new pool size ("pool"). */
export interface SlotHeightChange {
  /** Media time of the frame being captured when it changed. */
  mediaTimeSec: number;
  height: number;
  reason: SlotHeightChangeReason | "pool";
}

/** Where the detection p95 behind the lookahead length came from. */
export type LookaheadLengthSource = "measured" | "stored" | "default";

export interface LookaheadStatus {
  /** The switch: lookahead wanted (the host's choice, else the default for the active WASM build). */
  enabled: boolean;
  /** What the switch is by default with the active WASM build: on with SIMD, off with scalar (LOOKAHEAD_ON_BY_DEFAULT). */
  enabledByDefault: boolean;
  /** Whether the host set the switch (setLookaheadEnabled(true/false)); false while it follows the build default. */
  setByHost: boolean;
  /** Set when lookahead is wanted but forced off. */
  unavailableReason: LookaheadUnavailableReason | null;
  /** Wanted and available, but not running because the mode is 16:9 (no detection, nothing to look ahead for). */
  bypassed: boolean;
  /** The audio delay actually applied, in ms (0 when off or bypassed). */
  audioDelayMs: number;
  /** How far behind the decoded frame the output (and audio) is shown, in ms: a whole number of frames. 0 when off. */
  lengthMs: number;
  /** lengthMs in frames. */
  delayFrames: number;
  /** Detection p95 the length was computed from, and where it came from: this device's warm detections, an earlier session, or the device default. */
  detectionP95Ms: number | null;
  lengthSource: LookaheadLengthSource;
  /** Size of one buffered frame, null until the first frame is buffered. */
  slotWidth: number | null;
  slotHeight: number | null;
  /** Frame copies allocated so far, and their memory (RGBA estimate). */
  allocatedSlots: number;
  bufferBytes: number;
  /** Frames captured and waiting for display. */
  bufferedFrames: number;
  /** Frames never displayed since this source was loaded: overflowDrops + skippedOnDisplay. */
  droppedFrames: number;
  /** Dropped because the pool was full (should stay 0). */
  overflowDrops: number;
  /** Passed over on display: the frame callback for their counterpart was skipped, or the delay was shrinking. */
  skippedOnDisplay: number;
  /** Frame-copy height changes since this source was loaded (see SlotHeightGovernor). */
  slotHeightChanges: SlotHeightChange[];
  /** Wall time spent at each frame-copy height since this source was loaded, in ms, keyed by height. */
  timeAtSlotHeightMs: Record<string, number>;
  /** Most frame-buffer memory used at once (RGBA estimate), never above the 96 MiB budget. */
  peakBufferBytes: number;
}

export interface VertixState {
  wasmReady: boolean;
  mode: VertixMode;
  meta: VertixMeta | null;
  /** Number of valid (large-enough, unclipped) speakers in the current committed layout — 0 means B-roll/no-crop. */
  speakerCount: number;
  /** Whether a layout cross-dissolve is currently in progress. */
  isTransitioning: boolean;
  /** The rule behind the layout on screen (9:16 only). */
  layoutRule: LayoutRule;
  /** True when the source is not landscape: shown whole, without crop or detection. */
  sourceShownAsIs: boolean;
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
    enabled: false,
    enabledByDefault: false,
    setByHost: false,
    unavailableReason: null,
    bypassed: false,
    audioDelayMs: 0,
    lengthMs: 0,
    delayFrames: 0,
    detectionP95Ms: null,
    lengthSource: "default",
    slotWidth: null,
    slotHeight: null,
    allocatedSlots: 0,
    bufferBytes: 0,
    bufferedFrames: 0,
    droppedFrames: 0,
    overflowDrops: 0,
    skippedOnDisplay: 0,
    slotHeightChanges: [],
    timeAtSlotHeightMs: {},
    peakBufferBytes: 0,
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
// Spans of uncaptured but presented frames kept: well over a lookahead length of skips.
const UNCAPTURED_SPAN_HISTORY = 64;
// A frame shown while paused waits for its own detection this long at most.
const HELD_FRAME_TIMEOUT_MS = 500;
// With lookahead, frames are shown from the frame callback while playing.
// If no callback comes for this many frame intervals (paused, buffering,
// ended), the requestAnimationFrame loop drains the buffer instead.
const STALL_FRAMES = 3;
// A frame-interval change beyond this fraction (another rendition's frame
// rate) recomputes the lookahead length.
const FRAME_RATE_CHANGE_FRACTION = 0.1;
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
// When the current shared worker reported ready, and how many results it has
// returned since: its first detections are warm-up (see detectionLatency.ts).
let sharedWorkerReadyAt = 0;
let sharedWorkerResults = 0;
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
// Engines to tell when the active build changes (their lookahead default follows it).
const wasmBuildListeners = new Set<() => void>();

/**
 * Lookahead by default, per WASM build: on with SIMD; off with scalar,
 * whose slower detections (~175-220 ms on a phone) make the delay long
 * (~0.5 s).
 */
export const LOOKAHEAD_ON_BY_DEFAULT: Record<WasmBuildVariant, boolean> = { simd: true, scalar: false };

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
  for (const listener of wasmBuildListeners) listener();
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
        sharedWorkerReadyAt = performance.now();
        sharedWorkerResults = 0;
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

// "Show tracks" overlay style: the main subject thicker and in another
// colour, background tracks dimmed, unconfirmed tracks dashed.
const TRACK_SUBJECT_STROKE = "#facc15";
const TRACK_FOREGROUND_STROKE = "#22d3ee";
const TRACK_BACKGROUND_STROKE = "rgba(148, 163, 184, 0.7)";
const TRACK_LINE_WIDTH = 2;
const TRACK_SUBJECT_LINE_WIDTH = 4;
const TRACK_TENTATIVE_DASH = [6, 4];

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
/** Draws the `rect` crop (source-video pixels, scaled to the source's own size) into `dest`, on whole pixels. */
function drawCrop(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  rect: PaneRect,
  dest: PaneRect,
  scaleX: number,
  scaleY: number
): void {
  ctx.drawImage(
    source,
    Math.round(rect.x * scaleX),
    Math.round(rect.y * scaleY),
    Math.round(rect.w * scaleX),
    Math.round(rect.h * scaleY),
    Math.round(dest.x),
    Math.round(dest.y),
    Math.round(dest.w),
    Math.round(dest.h)
  );
}

/** The whole frame fitted inside the output, centred on black bars (letterbox or pillarbox). */
function drawLetterboxed(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number
): void {
  const scale = Math.min(outW / srcW, outH / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(source, Math.round((outW - w) / 2), Math.round((outH - h) / 2), w, h);
}

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

/** A framing to draw from the current frame: the fitted full frame (B-roll), or crops into panes. */
interface DrawnLayout {
  broll: boolean;
  panes: { source: PaneRect; dest: PaneRect }[];
}

interface FrameSlot {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
}

/** Scales `source` into `canvas` on the GPU and takes the result as a bitmap, leaving the canvas blank. */
function scaledBitmap(canvas: OffscreenCanvas, source: CanvasImageSource): ImageBitmap {
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "low";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.transferToImageBitmap();
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
  private planner = new LayoutPlanner();
  private lastPlanRule: LayoutRule = "broll";
  private lastSwitchedFar = false;
  private sourceShownAsIs = false;
  private tracksOverlay: HTMLCanvasElement | null = null;
  private tracksOverlayCtx: CanvasRenderingContext2D | null = null;

  private audioMonitor = new AudioActivityMonitor();

  // Decision side: what the latest detection decided, before it is shown.
  private decidedTargetPanes: PaneTarget[] = [];
  private decidedSpeakerCount = 0;
  private decidedLayoutKey = 0;
  private decidedRule: LayoutRule = "broll";
  // True once a frame was rendered (or buffered) since the last reset: the
  // no-crop layout counts as committed from then on.
  private hasFrameSinceReset = false;
  // Set by a seek while paused: like a cut, the first detection after it
  // commits the speaker count at once, so the frame shown there is cropped.
  private commitCountAtNextDetection = false;
  private decisions = new DecisionTimeline();

  // Display side: what the frame on screen uses.
  private displayedSpeakerCount = 0;
  private displayedSkinRejectedFaces: FaceBox[] = [];
  private displayedRule: LayoutRule = "broll";
  private displayedSubjectTrackId: number | null = null;
  private displayedTracks: TrackSnapshot[] = [];
  private displayedPaneTrackIds: number[] = [];
  private targetPanes: PaneTarget[] = [];
  private smoothedPanes: PaneRect[] = [];

  private layoutSignature = "";
  // Set by an applied decision, consumed by the frame it was applied on.
  private pendingReframe: Reframe | null = null;
  // A dissolve crossfades from the framing on screen when it started to
  // the new one, both cropped from the frame being drawn: it never shows
  // pixels of an earlier frame, so it can never mix two scenes.
  private transitionFrom: DrawnLayout | null = null;
  private transitionStart: number | null = null;
  // What the last 9:16 frame was drawn with (references, not copies).
  private drawnLayout: { broll: boolean; targetPanes: PaneTarget[]; smoothedPanes: PaneRect[] } = {
    broll: true,
    targetPanes: [],
    smoothedPanes: [],
  };

  // Lookahead: the output is shown lookaheadLengthMs behind the decoded
  // frame, so each frame's detection result is in before it is displayed.
  // Off by default until it has been checked on phones; the dashboard switch turns it on.
  // The host's choice; null follows LOOKAHEAD_ON_BY_DEFAULT for the active build.
  private lookaheadPreference: boolean | null = null;
  // What refreshLookahead last applied, to notice a build change that flips the default.
  private appliedLookaheadEnabled = false;
  private boundOnWasmBuildChange = () => {
    if (this.lookaheadEnabled !== this.appliedLookaheadEnabled) this.refreshLookahead("flush");
  };
  private lookaheadUnavailable: LookaheadUnavailableReason | null = null;
  // Current (target) length, whole frames, and the frame interval it was computed with.
  private lookaheadLengthMs = 0;
  private delayFrames = 0;
  private lengthIntervalSec: number | null = null;
  // What audio and video actually follow: lookaheadLengthMs, or a ramp towards it.
  private delaySchedule = new DelaySchedule();
  // A smaller pool, applied once a shrinking ramp has ended.
  private pendingMaxSlots: { slots: number; at: number } | null = null;
  private stallWatchdog: ReturnType<typeof setTimeout> | undefined = undefined;
  private sourceTainted = false;
  private readonly deviceClass = detectDeviceClass();
  private frameBuffer: FrameRingBuffer<FrameSlot> | null = null;
  // Without lookahead, in 9:16: the one copy of the current frame everything is drawn from.
  private liveFrameCanvas: OffscreenCanvas | null = null;
  private liveFrameCtx: OffscreenCanvasRenderingContext2D | null = null;
  private slotSize: SlotSize | null = null;
  private slotHeightGovernor = new SlotHeightGovernor();
  private slotHeightChanges: SlotHeightChange[] = [];
  private timeAtSlotHeightMs: Record<string, number> = {};
  private slotHeightSince: { height: number; atMs: number } | null = null;
  private lastScoredMediaSec: number | null = null;
  private captureIndex = 0;
  private nextDetectionFrameIndex = FACE_DETECT_INTERVAL;
  private lastCapturedMediaTime: number | null = null;
  private frameInterval = new FrameIntervalTracker();
  private frameRateHintFps: number | null = null;
  // Media-time spans whose frames the video element presented without a
  // frame callback (never captured). Only for those does the display
  // catch up to the next frame; a frame the element dropped itself is
  // skipped the way the element skips it, holding the previous one.
  private uncapturedPresentedSpans: { afterSec: number; beforeSec: number }[] = [];
  private lastCallback: { mediaTimeSec: number; presentedFrames: number } | null = null;
  private heldFrameTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
  private displayFrameId: number | null = null;
  private lastDisplayCallbackAt: number | null = null;
  private lastDisplayedAt: number | null = null;
  private refreshIntervalMs = 1000 / 60;
  private displayedMediaTimeSec: number | null = null;
  // Detection round trips (dispatch → result) of the current WASM build, for the lookahead length.
  private detectionLatency = new DetectionLatencyTracker();
  private lookaheadLengthSource: LookaheadLengthSource = "default";
  private lookaheadDetectionP95Ms: number | null = null;
  // Main-thread fallback detector: when it became ready, and its results since.
  private mainThreadReadyAt = 0;
  private mainThreadResults = 0;
  private triggerLatency = new RollingP95();
  private taintProbeCtx: OffscreenCanvasRenderingContext2D | null = null;

  // Per-frame cut trigger (lookahead only): scores every buffered frame in
  // its own worker and asks for a detection right away on a likely cut.
  private cutTriggerWorker: Worker | null = null;
  // Small GPU canvases the buffered frame is scaled into for the trigger and
  // for detection; transferToImageBitmap hands their pixels over without a copy.
  private triggerSourceCanvas: OffscreenCanvas | null = null;
  private detectionSourceCanvas: OffscreenCanvas | null = null;
  private cutTriggerUnavailable = false;
  // Bumped on every reset (seek, mode change, new source): scores from before it are ignored.
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
  private boundOnPlaybackHalt = () => {
    if (this.lookaheadLengthMs > 0) this.ensureDisplayLoop();
  };
  private boundOnRateChange = () => this.refreshLookahead("ramp");
  private boundOnDisplayFrame = this.onDisplayFrame.bind(this);
  private boundOnLoadedMetadata = () => this.resetForNewSource();

  constructor() {
    wasmBuildListeners.add(this.boundOnWasmBuildChange);
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
    for (const type of ["pause", "waiting", "ended"]) video.addEventListener(type, this.boundOnPlaybackHalt);
    video.addEventListener("ratechange", this.boundOnRateChange);
    video.addEventListener("seeking", this.boundOnSeeking);
    video.addEventListener("loadedmetadata", this.boundOnLoadedMetadata);

    if (!video.paused) this.startLoop();
  }

  /** Stops rendering and removes all listeners from the current video. Keeps the WASM engine warm for a future `attach`. */
  detach(): void {
    if (!this.video) return;
    this.video.removeEventListener("play", this.boundOnPlay);
    this.video.removeEventListener("play", this.boundOnPlayForHeldFrames);
    for (const type of ["pause", "waiting", "ended"]) this.video.removeEventListener(type, this.boundOnPlaybackHalt);
    this.video.removeEventListener("ratechange", this.boundOnRateChange);
    this.video.removeEventListener("seeking", this.boundOnSeeking);
    this.video.removeEventListener("loadedmetadata", this.boundOnLoadedMetadata);
    if (this.frameCallbackId !== null) this.video.cancelVideoFrameCallback(this.frameCallbackId);
    this.frameCallbackId = null;
    this.running = false;
    this.stopDisplayLoop();
    clearTimeout(this.heldFrameTimeout);
    clearTimeout(this.stallWatchdog);
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
    wasmBuildListeners.delete(this.boundOnWasmBuildChange);
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

  /**
   * Switches between the untouched 16:9 picture and the 9:16 reframe.
   * Lookahead only runs in 9:16 (16:9 has nothing to look ahead for), so a
   * switch to 16:9 drops the delay (a 15 ms fade, then live), and a switch
   * to 9:16 brings it back: the current frame is shown at once as a 9:16
   * frame, re-shown cropped as soon as its own detection is in, and held
   * until the delayed stream reaches it, with the audio silent as long.
   */
  setMode(mode: VertixMode): void {
    const changed = mode !== this.mode;
    this.mode = mode;
    if (this.outputCtx) this.outputCtx = this.canvas?.getContext("2d") ?? null;
    this.engine?.reset();
    this.resetTrackingState();
    if (changed) {
      // Like a cut: the first detection in 9:16 commits the speaker count at once.
      this.commitCountAtNextDetection = mode === "9:16";
      this.refreshLookahead("flush");
      this.showCurrentFrameAfterModeSwitch();
    }
    this.emitState();
  }

  /**
   * Draws detections the skin-tone filter rejected as dashed boxes on
   * `canvas`, which the host lays exactly over the output canvas. They are
   * never drawn on the output itself, so they can't leak into the video.
   * Pass null to stop.
   */
  setSkinRejectionOverlay(canvas: HTMLCanvasElement | null): void {
    this.skinRejectionOverlay = canvas;
    this.skinRejectionOverlayCtx = null;
  }

  /** Draws every face track (ID, main subject) on `canvas`, laid exactly over the output like the skin-rejection overlay. Pass null to stop. */
  setTracksOverlay(canvas: HTMLCanvasElement | null): void {
    if (!canvas)
      this.tracksOverlayCtx?.clearRect(0, 0, this.tracksOverlay?.width ?? 0, this.tracksOverlay?.height ?? 0);
    this.tracksOverlay = canvas;
    this.tracksOverlayCtx = null;
  }

  /** Switches how a panel is recognised (see PanelVariant), for A/B measurement; resets tracking like a seek. */
  setPanelVariant(variant: PanelVariant): void {
    this.planner.setPanelVariant(variant);
    this.resetTrackingState();
  }

  /** Starts (or, with null, stops) reporting per-frame and per-detection timings to `probe`. Does not change rendering or detection. */
  setBenchmarkProbe(probe: BenchmarkProbe | null): void {
    this.benchmarkProbe = probe;
  }

  /**
   * Turns lookahead on or off at runtime; null goes back to the default
   * for the active WASM build (LOOKAHEAD_ON_BY_DEFAULT), which then follows
   * build switches. A change is one short gap: the buffered frames are
   * dropped, and the audio is silent until audio delayed by the new amount
   * comes out.
   */
  setLookaheadEnabled(enabled: boolean | null): void {
    this.lookaheadPreference = enabled;
    if (this.lookaheadEnabled !== this.appliedLookaheadEnabled) {
      this.refreshLookahead("flush");
    } else {
      this.metrics = { ...this.metrics, lookahead: this.lookaheadStatus() };
      this.emitMetrics();
    }
  }

  /** The host's choice from setLookaheadEnabled, or null while lookahead follows the build default. */
  getLookaheadPreference(): boolean | null {
    return this.lookaheadPreference;
  }

  /** 9:16 on a landscape source: the only case with detection, crops and lookahead. */
  private get reframing(): boolean {
    return this.mode === "9:16" && !this.sourceShownAsIs;
  }

  private get lookaheadEnabled(): boolean {
    return this.lookaheadPreference ?? LOOKAHEAD_ON_BY_DEFAULT[getActiveWasmBuild().variant];
  }

  getLookaheadStatus(): LookaheadStatus {
    return this.lookaheadStatus();
  }

  /**
   * The source's frame rate, when the host knows it (e.g. Shaka's active
   * variant), so the lookahead length and the frame buffer are right from
   * the first frame instead of after the first few. Measured frame
   * intervals take over as soon as there are enough. Null clears it.
   */
  setFrameRateHint(fps: number | null): void {
    const hint = fps !== null && Number.isFinite(fps) && fps > 0 ? fps : null;
    if (hint === this.frameRateHintFps) return;
    this.frameRateHintFps = hint;
    if (this.lookaheadLengthMs > 0) this.refreshLookahead(this.frameBuffer?.length ? "ramp" : "flush");
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
      layoutRule: this.displayedRule,
      sourceShownAsIs: this.sourceShownAsIs,
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
      this.mainThreadReadyAt = performance.now();
      this.mainThreadResults = 0;
      this.emitState();
    });
  }

  /**
   * A new source (or the first): nothing of the previous one may be shown
   * after this. The canvas is cleared, the buffer flushed, the crop and
   * dissolve state reset, and late detection and cut-trigger results are
   * dropped by their generation.
   */
  private resetForNewSource(): void {
    this.clearOutput();
    this.srcDimsInitialized = false;
    this.frameCounter = 0;
    this.sourceTainted = false;
    this.audioMonitor.resetSilentPath();
    this.flushLookahead();
    this.frameBuffer = null;
    this.captureIndex = 0;
    this.nextDetectionFrameIndex = FACE_DETECT_INTERVAL;
    this.frameInterval.reset();
    this.forgetCallbackHistory();
    this.slotHeightGovernor.reset();
    this.slotHeightChanges = [];
    this.timeAtSlotHeightMs = {};
    this.slotHeightSince = null;
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
    this.refreshLookahead("flush");
    this.resetTrackingState();
    this.emitState();
    this.emitMetrics();
  }

  private clearOutput(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    this.outputCtx ??= canvas.getContext("2d");
    this.outputCtx?.clearRect(0, 0, canvas.width, canvas.height);
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
    this.planner.reset();
    this.lastPlanRule = "broll";
    this.lastSwitchedFar = false;
    this.decidedTargetPanes = [];
    this.decidedSpeakerCount = 0;
    this.decidedLayoutKey = 0;
    this.decidedRule = "broll";
    this.hasFrameSinceReset = false;
    this.commitCountAtNextDetection = false;
    this.decisions.clear();
    this.displayedSpeakerCount = 0;
    this.displayedSkinRejectedFaces = [];
    this.displayedRule = "broll";
    this.displayedSubjectTrackId = null;
    this.displayedTracks = [];
    this.displayedPaneTrackIds = [];
    this.smoothedPanes = [];
    this.targetPanes = [];
    this.layoutSignature = "";
    this.pendingReframe = null;
    this.endLayoutDissolve();
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

  /** Draws the current video frame for the new mode right away, so the switch never shows a stale or black frame. */
  private showCurrentFrameAfterModeSwitch(): void {
    const video = this.video;
    if (!video || !this.canvas || !this.srcDimsInitialized) return;
    const now = performance.now();
    const mediaTimeSec = video.currentTime;
    const { w, h } = this.srcDims;
    if (this.lookaheadLengthMs === 0) {
      this.renderFrame(video, w, h, null, mediaTimeSec, now, 0);
      this.displayedMediaTimeSec = mediaTimeSec;
      return;
    }
    const anchor = this.bufferFrame(video, mediaTimeSec, now, true);
    const { canvas } = anchor.slot;
    this.renderFrame(canvas, canvas.width, canvas.height, mediaTimeSec, mediaTimeSec, now, 0);
    this.displayedMediaTimeSec = mediaTimeSec;
    this.hasFrameSinceReset = true;
    if (!this.detectionInFlight) this.dispatchDetection(canvas, mediaTimeSec, ...this.cropArgs());
    clearTimeout(this.heldFrameTimeout);
    this.heldFrameTimeout = setTimeout(() => this.releaseHeldFrames(), HELD_FRAME_TIMEOUT_MS);
  }

  private onSeeking(): void {
    this.resetTrackingState();
    this.commitCountAtNextDetection = this.video?.paused ?? false;
    this.displayedMediaTimeSec = null;
    this.metrics = { ...this.metrics, displayedMediaTimeSec: null };
    this.nextDetectionFrameIndex = this.captureIndex + FACE_DETECT_INTERVAL;
    this.frameInterval.restart();
    this.forgetCallbackHistory();
    this.refreshLookahead("flush");
  }

  /**
   * Drops buffered frames, and silences the audio still in the delay line
   * (it belongs to frames that will never be shown). A running ramp jumps
   * to its end. The last frame shown stays on the canvas until new frames
   * are due.
   */
  private flushLookahead({ silenceDelayLine = true } = {}): void {
    this.frameBuffer?.flush();
    this.stopDisplayLoop();
    clearTimeout(this.heldFrameTimeout);
    clearTimeout(this.stallWatchdog);
    this.delaySchedule.set(this.lookaheadLengthMs);
    if (silenceDelayLine && this.lookaheadLengthMs > 0) this.audioMonitor.setOutputDelay(this.lookaheadLengthMs / 1000);
  }

  /**
   * Re-evaluates whether lookahead can run and how long it is.
   * - "flush" (seek, source change, the switch): buffered frames are dropped
   *   and the new length applies at once, behind a short silence.
   * - "ramp" (a measured detection time, a frame-rate or speed change during
   *   playback): audio and video move to the new length together over a
   *   ramp, with no flush and no gap.
   * - "keep": only availability is re-checked.
   */
  private refreshLookahead(how: "flush" | "ramp" | "keep"): void {
    this.lookaheadUnavailable = !this.audioMonitor.available
      ? "no-audio-graph"
      : this.sourceTainted
        ? "cross-origin"
        : this.audioMonitor.silentPathSuspected
          ? "silent-audio-path"
          : null;
    this.appliedLookaheadEnabled = this.lookaheadEnabled;
    const active = this.appliedLookaheadEnabled && this.lookaheadUnavailable === null && this.reframing;
    if (!active) {
      if (this.lookaheadLengthMs > 0) this.applyLookaheadLength({ frames: 0, lengthMs: 0 });
    } else if (this.lookaheadLengthMs === 0 || how === "flush") {
      this.applyLookaheadLength(this.computeLookaheadLength());
    } else if (how === "ramp") {
      this.rampLookaheadLength(this.computeLookaheadLength());
    }
    this.metrics = { ...this.metrics, lookahead: this.lookaheadStatus() };
    this.emitMetrics();
  }

  /** Switches to `delay` at once, behind a flush. */
  private applyLookaheadLength(delay: FrameAlignedDelay): void {
    // The delay change below silences the output itself.
    this.flushLookahead({ silenceDelayLine: false });
    const wasOff = this.lookaheadLengthMs === 0;
    this.lookaheadLengthMs = delay.lengthMs;
    this.delayFrames = delay.frames;
    this.delaySchedule.set(delay.lengthMs);
    this.pendingMaxSlots = null;
    this.audioMonitor.setOutputDelay(delay.lengthMs / 1000);
    // Sized (and copies sized for the screen) on the next captured frame.
    this.frameBuffer = null;
    if (wasOff) this.nextDetectionFrameIndex = this.captureIndex + 1;
  }

  /**
   * Moves to `delay` without a flush: the DelaySchedule ramps, the audio
   * DelayNode follows the same ramp, and the pool grows now (or shrinks
   * once fewer frames wait, see sizePool). The same length in another
   * number of frames (a frame-rate change) needs no ramp, only another
   * pool size.
   */
  private rampLookaheadLength(delay: FrameAlignedDelay): void {
    const now = performance.now();
    if (delay.lengthMs !== this.lookaheadLengthMs) {
      const durationMs = this.delaySchedule.rampTo(now, delay.lengthMs);
      this.audioMonitor.rampOutputDelay(delay.lengthMs / 1000, durationMs / 1000);
      this.lookaheadLengthMs = delay.lengthMs;
    }
    this.delayFrames = delay.frames;
    this.sizePool(now);
  }

  /** Accumulates the time spent at each copy height, and logs height changes. */
  private trackSlotHeight(height: number, now: number, reason: SlotHeightChange["reason"]): void {
    const since = this.slotHeightSince;
    if (since?.height === height) return;
    if (since) {
      this.accumulateSlotHeightTime(now);
      this.slotHeightChanges.push({ mediaTimeSec: this.lastCapturedMediaTime ?? 0, height, reason });
    }
    this.slotHeightSince = { height, atMs: now };
  }

  private accumulateSlotHeightTime(now: number): void {
    const since = this.slotHeightSince;
    if (!since) return;
    this.timeAtSlotHeightMs[since.height] = (this.timeAtSlotHeightMs[since.height] ?? 0) + (now - since.atMs);
    since.atMs = now;
  }

  /** Feeds the slot-height governor (a few times a second while lookahead runs); a new decision resizes the copies. */
  private updateSlotHeight(video: HTMLVideoElement, now: number): void {
    const buffer = this.frameBuffer;
    if (this.lookaheadLengthMs === 0 || !buffer) return;
    const interval = this.knownIntervalSec();
    const frameRateFps = interval ? (video.playbackRate || 1) / interval : null;
    const quality = video.getVideoPlaybackQuality?.() ?? null;
    const reason = this.slotHeightGovernor.update(now, frameRateFps, quality, buffer.overflowDrops);
    if (reason) this.sizePool(now, reason);
    this.accumulateSlotHeightTime(now);
  }

  /** Media seconds per frame: measured, else the host's hint, else null. */
  private knownIntervalSec(): number | null {
    return this.frameInterval.intervalSec ?? (this.frameRateHintFps !== null ? 1 / this.frameRateHintFps : null);
  }

  /** Delay frames the pool must hold: at the known frame rate, or at ASSUMED_MAX_FPS before it is known. */
  private poolDelayFrames(): number {
    if (this.knownIntervalSec() !== null) return this.delayFrames;
    return alignToFrames(this.lookaheadLengthMs, 1 / ASSUMED_MAX_FPS, this.video?.playbackRate || 1).frames;
  }

  /**
   * Sizes the pool for the current delay: the largest copy size at which
   * the frames it must hold fit the budget, and the slot limit. Growth
   * applies now. A smaller limit applies only once the frames waiting now
   * have been shown: after any running ramp, and one delay length later
   * (a lower limit with more frames waiting would drop them).
   */
  private sizePool(now: number, reason: SlotHeightChange["reason"] = "pool"): void {
    const buffer = this.frameBuffer;
    if (!buffer) return;
    const { w, h } = this.srcDims;
    const neededSlots = slotsForDelay(this.poolDelayFrames());
    const heightCap = this.slotHeightGovernor.reduced ? REDUCED_SLOT_HEIGHT : null;
    const size = chooseSlotSize(w, h, neededSlots, this.outputHeightOnScreenPx(), heightCap);
    this.slotSize = size;
    this.trackSlotHeight(size.height, now, reason);
    const slots = maxSlotsFor(size, neededSlots);
    if (slots >= buffer.maxSlots || buffer.length === 0) {
      buffer.setMaxSlots(slots);
      this.pendingMaxSlots = null;
    } else {
      const drainedAt = Math.max(this.delaySchedule.rampEndsAt, now) + this.delaySchedule.valueAt(now);
      this.pendingMaxSlots = { slots, at: drainedAt };
    }
  }

  /** From this build's warm detections, else the value stored by an earlier session, else the device default. Only a measured value is stored. Rounded up to whole frames. */
  private computeLookaheadLength(): FrameAlignedDelay {
    const build = getActiveWasmBuild().variant;
    const measured = this.detectionLatency.p95(build);
    const stored = measured === null ? loadStoredDetectionP95(build) : null;
    if (measured !== null) storeDetectionP95(build, measured);
    this.lookaheadLengthSource = measured !== null ? "measured" : stored !== null ? "stored" : "default";
    const detectionP95 = measured ?? stored ?? DEFAULT_DETECTION_P95_MS[this.deviceClass][build];
    this.lookaheadDetectionP95Ms = detectionP95;
    const playbackRate = this.video?.playbackRate || 1;
    this.lengthIntervalSec = this.knownIntervalSec();
    const intervalSec = this.lengthIntervalSec ?? DEFAULT_FRAME_INTERVAL_MS / 1000;
    const lengthMs = lookaheadLengthMs(
      detectionP95,
      this.triggerLatency.p95() ?? DEFAULT_TRIGGER_P95_MS,
      (intervalSec * 1000) / playbackRate
    );
    return alignToFrames(lengthMs, intervalSec, playbackRate);
  }

  /** Once this build has enough warm detections, the measured length replaces the stored or default one, by a ramp. */
  private adoptMeasuredLength(build: WasmBuildVariant): void {
    if (this.lookaheadLengthMs === 0 || this.lookaheadLengthSource === "measured") return;
    if (build !== getActiveWasmBuild().variant || this.detectionLatency.p95(build) === null) return;
    this.refreshLookahead("ramp");
  }

  private lookaheadStatus(): LookaheadStatus {
    const buffer = this.frameBuffer;
    const allocatedSlots = buffer?.allocatedSlots ?? 0;
    return {
      enabled: this.lookaheadEnabled,
      enabledByDefault: LOOKAHEAD_ON_BY_DEFAULT[getActiveWasmBuild().variant],
      setByHost: this.lookaheadPreference !== null,
      unavailableReason: this.lookaheadEnabled ? this.lookaheadUnavailable : null,
      bypassed: this.lookaheadEnabled && this.lookaheadUnavailable === null && !this.reframing,
      audioDelayMs: Math.round(this.audioMonitor.outputDelaySec * 1000),
      lengthMs: Math.round(this.lookaheadLengthMs),
      delayFrames: this.delayFrames,
      detectionP95Ms: this.lookaheadLengthMs > 0 ? this.lookaheadDetectionP95Ms : null,
      lengthSource: this.lookaheadLengthSource,
      slotWidth: buffer ? (this.slotSize?.width ?? null) : null,
      slotHeight: buffer ? (this.slotSize?.height ?? null) : null,
      allocatedSlots,
      bufferBytes: buffer?.allocatedBytes ?? 0,
      bufferedFrames: buffer?.length ?? 0,
      droppedFrames: buffer ? buffer.overflowDrops + buffer.skippedOnDisplay : 0,
      overflowDrops: buffer?.overflowDrops ?? 0,
      skippedOnDisplay: buffer?.skippedOnDisplay ?? 0,
      slotHeightChanges: [...this.slotHeightChanges],
      timeAtSlotHeightMs: { ...this.timeAtSlotHeightMs },
      peakBufferBytes: buffer?.peakAllocatedBytes ?? 0,
    };
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
    if (faces.length === 0 || !this.reframing) return;

    const { w: srcW, h: srcH } = this.srcDims;
    const views = this.overlayViews(outW, outH);

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

  /** Where each part of the source is drawn on the output: the panes, or the whole fitted frame (B-roll, 16:9). */
  private overlayViews(outW: number, outH: number): { source: PaneRect; dest: PaneRect }[] {
    const { w: srcW, h: srcH } = this.srcDims;
    if (this.mode === "16:9") {
      return [{ source: { x: 0, y: 0, w: srcW, h: srcH }, dest: { x: 0, y: 0, w: outW, h: outH } }];
    }
    if (this.displayedSpeakerCount === 0) {
      const fittedHeight = Math.round(srcH * (outW / srcW));
      return [
        {
          source: { x: 0, y: 0, w: srcW, h: srcH },
          dest: { x: 0, y: Math.round((outH - fittedHeight) / 2), w: outW, h: fittedHeight },
        },
      ];
    }
    return this.targetPanes.map((p, i) => ({ source: this.smoothedPanes[i], dest: p.pane.dest }));
  }

  /** Draws every track of the decision on screen (box and ID; the main subject highlighted) on the overlay canvas. */
  private drawTracksOverlay(overlay: HTMLCanvasElement, outW: number, outH: number): void {
    if (overlay.width !== outW || overlay.height !== outH) {
      overlay.width = outW;
      overlay.height = outH;
      this.tracksOverlayCtx = null;
    }
    this.tracksOverlayCtx ??= overlay.getContext("2d");
    const ctx = this.tracksOverlayCtx;
    if (!ctx) return;
    ctx.clearRect(0, 0, outW, outH);
    if (!this.reframing || this.displayedTracks.length === 0) return;

    const { w: srcW, h: srcH } = this.srcDims;
    const fontPx = Math.max(14, Math.round(outH / 40));
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    ctx.textBaseline = "bottom";
    for (const { source, dest } of this.overlayViews(outW, outH)) {
      const scaleX = dest.w / source.w;
      const scaleY = dest.h / source.h;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dest.x, dest.y, dest.w, dest.h);
      ctx.clip();
      for (const t of this.displayedTracks) {
        const isSubject = t.id === this.displayedSubjectTrackId;
        const x = dest.x + ((t.cx - t.w / 2) * srcW - source.x) * scaleX;
        const y = dest.y + ((t.cy - t.h / 2) * srcH - source.y) * scaleY;
        ctx.strokeStyle = isSubject
          ? TRACK_SUBJECT_STROKE
          : t.foreground
            ? TRACK_FOREGROUND_STROKE
            : TRACK_BACKGROUND_STROKE;
        ctx.lineWidth = isSubject ? TRACK_SUBJECT_LINE_WIDTH : TRACK_LINE_WIDTH;
        ctx.setLineDash(t.confirmed ? [] : TRACK_TENTATIVE_DASH);
        ctx.strokeRect(x, y, t.w * srcW * scaleX, t.h * srcH * scaleY);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(isSubject ? `#${t.id} ★` : `#${t.id}`, x, y - 2);
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
    cropH: number,
    triggeredByCut = false
  ): void {
    const probe = this.benchmarkProbe;
    const dispatchedAt = performance.now();
    const build = getActiveWasmBuild().variant;
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
        sharedWorkerResults += 1;
        if (
          this.detectionLatency.record(
            build,
            postStart - dispatchedAt,
            dispatchedAt - sharedWorkerReadyAt,
            sharedWorkerResults
          )
        ) {
          this.adoptMeasuredLength(build);
        }
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
          previousDetectionSec,
          triggeredByCut
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
            this.lastSceneCut.isCut,
            triggeredByCut,
            this.lastResolvedFaces.length,
            this.lastResolvedFaces[0]?.cx ?? NaN
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
      // No getImageData here: the main thread only scales the frame and
      // hands it over; the GPU→CPU readback happens in the worker (see
      // faceDetectionWorker.ts).
      this.detectionInputBitmap(source)
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
      this.mainThreadResults += 1;
      if (
        this.detectionLatency.record(
          build,
          performance.now() - dispatchedAt,
          dispatchedAt - this.mainThreadReadyAt,
          this.mainThreadResults
        )
      ) {
        this.adoptMeasuredLength(build);
      }
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
        previousDetectionSec,
        triggeredByCut
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
          this.lastSceneCut.isCut,
          triggeredByCut,
          this.lastResolvedFaces.length,
          this.lastResolvedFaces[0]?.cx ?? NaN
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
    previousDetectionSec: number | null = null,
    triggeredByCut = false
  ): void {
    const detections = unpackDetections(facesFlat);
    this.lastSceneCut = sceneCut;
    this.lastDetectedFaceCount = detections.faces.length;
    this.lastSkinRejectedFaces = detections.skinRejected;
    this.lastSkinRejectedSpeakerSizedCount = detections.skinRejected.filter(isSpeakerSized).length;

    // A hard cut makes everything learned from the previous shot stale:
    // the tracks, the subject, the agreement streaks, the committed count.
    if (sceneCut.isCut) this.sceneCutCount += 1;
    const planStart = performance.now();
    const plan = this.planner.plan(detections.faces, audioEnergy, mediaTimeSec, sceneCut.isCut, {
      srcW,
      srcH,
      outW: cropW,
      outH: cropH,
    });
    const trackerMs = performance.now() - planStart;
    this.lastFaces = this.planner.tracker.tracks.filter((t) => t.visible && t.foreground).map((t) => t.lastDetection);
    this.lastResolvedFaces = plan.faces;
    this.lastPlanRule = plan.rule;
    this.lastSwitchedFar = plan.switchedFar;
    const count = this.lastResolvedFaces.length;
    const commitAtOnce = sceneCut.isCut || this.commitCountAtNextDetection;
    // A count committed at once after a seek or a mode switch replaces whatever was on screen: no dissolve from it.
    const snapWithoutCut = commitAtOnce && !sceneCut.isCut;
    this.commitCountAtNextDetection = false;
    // Debounced on the layout key, not only the pane count: see layoutKey.
    const key = layoutKey(plan.rule, count);
    const stableKey = commitAtOnce
      ? this.personCount.commitNow(key, mediaTimeSec)
      : this.personCount.observe(key, this.hasFrameSinceReset, mediaTimeSec);
    // With lookahead, a cut found here is shown from the frame where it
    // happened (the biggest per-frame jump since the previous detection),
    // not from this detection frame.
    const decisionSec =
      sceneCut.isCut && this.lookaheadLengthMs > 0
        ? locateCut(this.scoredFrames, previousDetectionSec, mediaTimeSec)
        : mediaTimeSec;
    const cutSource: CutSource | null = !sceneCut.isCut
      ? null
      : triggeredByCut
        ? "trigger"
        : decisionSec < mediaTimeSec
          ? "localised"
          : "tick";
    this.decideLayout(decisionSec, key, stableKey, cutSource, snapWithoutCut, srcW, srcH, cropW, cropH, plan);
    this.benchmarkProbe?.recordTracking(
      trackerMs,
      plan.foregroundCount,
      plan.backgroundCount,
      plan.paneSwap,
      plan.leftToRightFlip
    );
    this.benchmarkProbe?.recordTrackSnapshot?.(mediaTimeSec, plan.tracks, plan.subjectTrackId, plan.rule);

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
    key: number,
    stableKey: number,
    cutSource: CutSource | null,
    snap: boolean,
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number,
    plan: LayoutPlan
  ): void {
    const isCut = cutSource !== null;
    const stablePersonCount = paneCountOf(stableKey);
    const countChanged = stableKey !== this.decidedLayoutKey;
    let reframe: Reframe | null = isCut || snap ? "snap" : null;
    if (stablePersonCount === 0) {
      this.decidedTargetPanes = [];
      this.decidedRule = "broll";
    } else if (key === stableKey) {
      this.decidedRule = plan.rule;
      // Only refresh the target once the raw count matches the *committed*
      // layout — otherwise, mid-debounce, this could compute a different
      // pane count than what's actually on screen. The deadzone itself
      // lives inside computeSpeakerLayout. A reframe or a new layout aims
      // straight at the new faces, without the deadzone.
      if (this.lastSwitchedFar || this.movesSinglePaneFar(countChanged)) reframe ??= "dissolve";
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
    this.decidedLayoutKey = stableKey;
    this.decisions.push({
      mediaTimeSec,
      speakerCount: stablePersonCount,
      targetPanes: this.decidedTargetPanes,
      reframe,
      isCut,
      cutSource,
      skinRejectedFaces: this.lastSkinRejectedFaces,
      rule: this.decidedRule,
      subjectTrackId: plan.subjectTrackId,
      paneTrackIds: plan.paneTrackIds,
      tracks: plan.tracks,
    });
    if (this.frameBuffer?.hasHeld) this.releaseHeldFrames();
  }

  /**
   * A committed change between one-pane layouts of different kinds (one
   * face, main subject, group) that moves the framing far away: dissolve
   * instead of panning across the frame.
   */
  private movesSinglePaneFar(layoutChanged: boolean): boolean {
    const previous = this.decidedTargetPanes;
    const next = this.lastResolvedFaces;
    if (!layoutChanged || previous.length !== 1 || next.length !== 1) return false;
    const from = previous[0].face;
    return Math.hypot(from.cx - next[0].cx, from.cy - next[0].cy) >= SWITCH_DISSOLVE_DISTANCE;
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
    this.displayedSubjectTrackId = decision.subjectTrackId;
    this.displayedTracks = decision.tracks;
    this.displayedPaneTrackIds = decision.paneTrackIds;
    const ruleChanged = decision.rule !== this.displayedRule;
    this.displayedRule = decision.rule;
    this.targetPanes = decision.targetPanes;
    this.pendingReframe = decision.reframe;
    if (countChanged || ruleChanged) this.emitState();
    return decision;
  }

  /**
   * Starts a cross-dissolve from the framing on screen (its crop rects,
   * kept fixed) to the new one, over LAYOUT_TRANSITION_MS. If a dissolve
   * is already running, this cuts straight to the new framing instead of
   * stacking a second one on top of it.
   */
  private startLayoutDissolve(now: number): void {
    if (this.transitionStart !== null) {
      this.endLayoutDissolve();
      return;
    }
    const { broll, targetPanes, smoothedPanes } = this.drawnLayout;
    this.transitionFrom = {
      broll,
      panes: broll ? [] : targetPanes.map((p, i) => ({ source: { ...smoothedPanes[i] }, dest: { ...p.pane.dest } })),
    };
    this.transitionStart = now;
  }

  private endLayoutDissolve(): void {
    this.transitionStart = null;
    this.transitionFrom = null;
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
    this.frameInterval.push(metadata.mediaTime);
    this.noteUncapturedFrames(metadata);
    if (now - this.lastMetricsPush > 300) {
      this.lastMetricsPush = now;
      this.updateSlotHeight(video, now);
      if (this.audioMonitor.silentPathSuspected !== this.audioMonitor.checkSilentPath(video, now)) {
        this.refreshLookahead("keep");
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
      const { width: w, height: h } = displayedSourceSize(
        metadata.width,
        metadata.height,
        video.videoWidth,
        video.videoHeight
      );
      const shownAsIs = isShownAsIs(w, h);
      const { width: cropW, height: cropH } = shownAsIs
        ? fittedOutputSize(w, h, 9 / 16)
        : { width: Math.round((h * 9) / 16), height: h };

      this.srcDims = { w, h, cropW, cropH };
      this.srcDimsInitialized = true;

      this.meta = { width: w, height: h, cropWidth: cropW, cropHeight: cropH };
      this.emitState();

      const tainted = !this.isFrameReadable(video);
      if (tainted !== this.sourceTainted || shownAsIs !== this.sourceShownAsIs) {
        this.sourceTainted = tainted;
        this.sourceShownAsIs = shownAsIs;
        this.refreshLookahead("flush");
      }
    }

    if (this.lookaheadLengthMs > 0) {
      this.captureFrame(video, metadata, now);
    } else {
      this.renderLiveFrame(video, metadata, now, frameDtSec);
    }

    if (probe) {
      probe.recordFrame(
        now,
        performance.now() - workStart,
        metadata.mediaTime,
        metadata.presentedFrames,
        metadata.expectedDisplayTime ?? now
      );
    }
    this.scheduleNextFrame(video);
  }

  /**
   * No lookahead. In 9:16 the frame is copied once into an offscreen canvas
   * and everything (the crops, the B-roll background, the detection input)
   * is drawn from that copy: drawing the video element itself several times
   * per frame into the visible canvas made a phone drop a fifth of the
   * frames at 50 fps. 16:9 draws the video once, straight.
   */
  private renderLiveFrame(
    video: HTMLVideoElement,
    metadata: VideoFrameCallbackMetadata,
    now: number,
    frameDtSec: number
  ): void {
    const { w: srcW, h: srcH, cropW, cropH } = this.srcDims;
    const renderStart = this.benchmarkProbe ? performance.now() : 0;
    let source: HTMLVideoElement | OffscreenCanvas = video;
    if (this.reframing) {
      source = this.copyLiveFrame(video);
      this.hasFrameSinceReset = true;
      this.frameCounter += 1;
      if (this.frameCounter % FACE_DETECT_INTERVAL === 0) {
        if (!this.detectionInFlight) {
          this.dispatchDetection(source, metadata.mediaTime, srcW, srcH, cropW, cropH);
        } else {
          this.benchmarkProbe?.recordSkippedDetection();
        }
      }
    }
    const sourceW = source instanceof OffscreenCanvas ? source.width : srcW;
    const sourceH = source instanceof OffscreenCanvas ? source.height : srcH;
    this.renderFrame(source, sourceW, sourceH, null, metadata.mediaTime, now, frameDtSec);
    this.displayedMediaTimeSec = metadata.mediaTime;
    this.benchmarkProbe?.recordDisplay(
      now,
      metadata.mediaTime,
      performance.now() - renderStart,
      NaN,
      metadata.expectedDisplayTime ?? now,
      0
    );
  }

  /** The current video frame, copied once into the live-frame canvas (sized like a lookahead slot: never above the source or what the output can show). */
  private copyLiveFrame(video: HTMLVideoElement): OffscreenCanvas {
    const { w, h } = this.srcDims;
    const size = chooseSlotSize(w, h, 1, this.outputHeightOnScreenPx());
    let canvas = this.liveFrameCanvas;
    if (!canvas || canvas.width !== size.width || canvas.height !== size.height) {
      canvas = new OffscreenCanvas(size.width, size.height);
      this.liveFrameCanvas = canvas;
      this.liveFrameCtx = canvas.getContext("2d", { alpha: false })!;
    }
    this.liveFrameCtx!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Lookahead, while playing: copies the frame into the buffer, runs
   * detection on it if due, then shows the buffered frame whose time has
   * come: the one at this frame's mediaTime minus the delay. Picking by
   * media time keeps audio and video in sync when a callback is skipped;
   * if the due frame itself was never captured (its callback was skipped)
   * and the screen would fall behind, the nearest captured frame is shown
   * (see FrameRingBuffer.takeNearest). The delay is a whole number of
   * frames, so that frame appears exactly when the video element would
   * show it.
   */
  private captureFrame(video: HTMLVideoElement, metadata: VideoFrameCallbackMetadata, now: number): void {
    this.followFrameRate();
    const presentedAtMs = metadata.expectedDisplayTime ?? now;
    const rate = video.playbackRate || 1;
    const intervalSec = this.knownIntervalSec() ?? DEFAULT_FRAME_INTERVAL_MS / 1000;
    const frame = this.bufferFrame(video, metadata.mediaTime, presentedAtMs, false);
    if (this.reframing) {
      this.hasFrameSinceReset = true;
      if (frame.frameIndex >= this.nextDetectionFrameIndex) {
        this.nextDetectionFrameIndex = frame.frameIndex + FACE_DETECT_INTERVAL;
        if (!this.detectionInFlight) {
          this.dispatchDetection(frame.slot.canvas, frame.mediaTimeSec, ...this.cropArgs());
        } else {
          this.benchmarkProbe?.recordSkippedDetection();
        }
      }
      if (this.shouldScoreForCut(frame.mediaTimeSec, intervalSec, rate)) this.scoreFrameForCut(frame);
    }

    this.stopDisplayLoop();
    const delayMs = this.delaySchedule.valueAt(presentedAtMs);
    const dueSec = metadata.mediaTime - (delayMs / 1000) * rate;
    const shownSec = this.displayedMediaTimeSec;
    const catchUp =
      shownSec !== null && shownSec < dueSec - intervalSec / 2 && this.wasPresentedWithoutCallback(dueSec, intervalSec);
    const due = this.frameBuffer!.takeNearest(dueSec, intervalSec, catchUp);
    if (due) this.showBufferedFrame(due, now, presentedAtMs, delayMs, (dueSec - due.mediaTimeSec) / intervalSec);
    this.applyPendingMaxSlots(now);
    this.armStallWatchdog(intervalSec / rate);
  }

  /**
   * Every frame up to HIGH_FRAME_RATE_FPS; above it, a frame at most every
   * second frame (a cut between two scored frames is found on the second).
   */
  private shouldScoreForCut(mediaTimeSec: number, intervalSec: number, rate: number): boolean {
    const last = this.lastScoredMediaSec;
    if (rate / intervalSec <= HIGH_FRAME_RATE_FPS + 0.5 || last === null || mediaTimeSec < last) return true;
    return mediaTimeSec - last >= intervalSec * 1.5;
  }

  /**
   * Notes the frames between this callback and the previous one, if any:
   * presented by the video element (its presentedFrames count rose by as
   * many) but never captured. If presentedFrames is missing or rose by
   * less, the element dropped them itself.
   */
  private noteUncapturedFrames(metadata: VideoFrameCallbackMetadata): void {
    const last = this.lastCallback;
    const presentedFrames = metadata.presentedFrames;
    this.lastCallback = Number.isFinite(presentedFrames) ? { mediaTimeSec: metadata.mediaTime, presentedFrames } : null;
    const intervalSec = this.knownIntervalSec();
    if (!last || !this.lastCallback || !intervalSec) return;
    const mediaSteps = Math.round((metadata.mediaTime - last.mediaTimeSec) / intervalSec);
    if (mediaSteps < 2 || presentedFrames - last.presentedFrames < mediaSteps) return;
    if (this.uncapturedPresentedSpans.length === UNCAPTURED_SPAN_HISTORY) this.uncapturedPresentedSpans.shift();
    this.uncapturedPresentedSpans.push({ afterSec: last.mediaTimeSec, beforeSec: metadata.mediaTime });
  }

  private wasPresentedWithoutCallback(mediaTimeSec: number, intervalSec: number): boolean {
    const slackSec = intervalSec / 4;
    return this.uncapturedPresentedSpans.some(
      (span) => span.afterSec + slackSec < mediaTimeSec && mediaTimeSec < span.beforeSec - slackSec
    );
  }

  private forgetCallbackHistory(): void {
    this.uncapturedPresentedSpans = [];
    this.lastCallback = null;
  }

  /** A frame-rate change (another rendition) or the first measured interval moves the length to whole frames of the new rate. */
  private followFrameRate(): void {
    const interval = this.knownIntervalSec();
    if (interval === null) return;
    const used = this.lengthIntervalSec;
    if (used === null || Math.abs(interval - used) / used > FRAME_RATE_CHANGE_FRACTION) this.refreshLookahead("ramp");
  }

  private applyPendingMaxSlots(now: number): void {
    const pending = this.pendingMaxSlots;
    if (!pending || now < pending.at || !this.frameBuffer) return;
    this.frameBuffer.setMaxSlots(pending.slots);
    this.pendingMaxSlots = null;
  }

  /** Starts the drain loop if no frame callback comes for STALL_FRAMES frame intervals. */
  private armStallWatchdog(frameWallSec: number): void {
    clearTimeout(this.stallWatchdog);
    this.stallWatchdog = setTimeout(() => this.ensureDisplayLoop(), frameWallSec * 1000 * STALL_FRAMES);
  }

  /**
   * Draws a buffered frame that reaches the screen at `onScreenAtMs`, due
   * `delayMs` after its own display time; `frameOffset` is how many frames
   * it is from the due one (positive: older).
   */
  private showBufferedFrame(
    frame: BufferedFrame<FrameSlot>,
    now: number,
    onScreenAtMs: number,
    delayMs: number,
    frameOffset: number
  ): void {
    const frameDtSec = this.lastDisplayedAt !== null ? (now - this.lastDisplayedAt) / 1000 : 0;
    this.lastDisplayedAt = now;
    const renderStart = performance.now();
    const { canvas } = frame.slot;
    this.renderFrame(canvas, canvas.width, canvas.height, frame.mediaTimeSec, frame.mediaTimeSec, now, frameDtSec);
    this.frameBuffer?.release(frame);
    this.displayedMediaTimeSec = frame.mediaTimeSec;
    this.benchmarkProbe?.recordDisplay(
      now,
      frame.mediaTimeSec,
      performance.now() - renderStart,
      onScreenAtMs - (frame.presentedAtMs + delayMs),
      onScreenAtMs,
      delayMs,
      frameOffset
    );
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

  /**
   * Sends a small copy of a buffered frame to the cut trigger: a GPU scale
   * (drawImage) and a transfer, both synchronous, no pixel readback here.
   */
  private scoreFrameForCut(frame: BufferedFrame<FrameSlot>): void {
    const worker = this.ensureCutTriggerWorker();
    if (!worker) return;
    this.lastScoredMediaSec = frame.mediaTimeSec;
    const start = performance.now();
    this.pendingTriggerFrames.set(frame.frameIndex, { mediaTimeSec: frame.mediaTimeSec, capturedAt: start });
    this.triggerSourceCanvas ??= new OffscreenCanvas(TRIGGER_SOURCE_W, TRIGGER_SOURCE_H);
    const bitmap = scaledBitmap(this.triggerSourceCanvas, frame.slot.canvas);
    const drawnAt = performance.now();
    const generation = this.cutTriggerGeneration;
    worker.postMessage({ type: "score", generation, frameId: frame.frameIndex, bitmap }, [bitmap]);
    const end = performance.now();
    this.benchmarkProbe?.recordTriggerCost(end - start, drawnAt - start, end - drawnAt);
  }

  /**
   * The detector's 320x240 input as a bitmap: from the video with
   * createImageBitmap (no lookahead), or from a buffered frame with a GPU
   * scale and a transfer, without the full-size bitmap and promise
   * createImageBitmap makes for a canvas.
   */
  private detectionInputBitmap(source: HTMLVideoElement | OffscreenCanvas): Promise<ImageBitmap> {
    if (!(source instanceof OffscreenCanvas)) {
      return createImageBitmap(source, { resizeWidth: FACE_W, resizeHeight: FACE_H, resizeQuality: "low" });
    }
    this.detectionSourceCanvas ??= new OffscreenCanvas(FACE_W, FACE_H);
    return Promise.resolve(scaledBitmap(this.detectionSourceCanvas, source));
  }

  private onCutTriggerScore(msg: {
    generation: number;
    frameId: number;
    failed: boolean;
    hist: number;
    grid: number;
    triggered: boolean;
  }): void {
    // A score from before the last reset (seek, mode change, new source) belongs to another frame.
    if (msg.generation !== this.cutTriggerGeneration) return;
    if (msg.failed) {
      this.pendingTriggerFrames.delete(msg.frameId);
      return;
    }
    const pending = this.pendingTriggerFrames.get(msg.frameId);
    if (!pending) return;
    this.pendingTriggerFrames.delete(msg.frameId);
    this.triggerLatency.push(performance.now() - pending.capturedAt);
    if (this.scoredFrames.length === SCORED_FRAME_HISTORY) this.scoredFrames.shift();
    this.scoredFrames.push({ mediaTimeSec: pending.mediaTimeSec, score: Math.max(msg.hist, msg.grid) });
    if (msg.triggered && this.reframing) this.requestCutDetection(pending.mediaTimeSec);
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
    this.dispatchDetection(frame.slot.canvas, mediaTimeSec, ...this.cropArgs(), true);
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
    this.lastScoredMediaSec = null;
    this.cutTriggerWorker?.postMessage({ type: "reset" });
  }

  /**
   * A new frame while paused (a seek, or a source's first frame): held
   * until its own detection result is in, so it is shown with the right
   * crop, or HELD_FRAME_TIMEOUT_MS at most.
   */
  private capturePausedFrame(video: HTMLVideoElement, metadata: VideoFrameCallbackMetadata): void {
    if (metadata.mediaTime === this.lastCapturedMediaTime) return;
    const frame = this.bufferFrame(video, metadata.mediaTime, metadata.expectedDisplayTime ?? performance.now(), true);
    if (this.reframing && !this.detectionInFlight) {
      this.dispatchDetection(frame.slot.canvas, frame.mediaTimeSec, ...this.cropArgs());
    }
    clearTimeout(this.heldFrameTimeout);
    this.heldFrameTimeout = setTimeout(() => this.releaseHeldFrames(), HELD_FRAME_TIMEOUT_MS);
  }

  private releaseHeldFrames(): void {
    clearTimeout(this.heldFrameTimeout);
    if (!this.frameBuffer) return;
    this.frameBuffer.releaseHeld();
    this.ensureDisplayLoop();
  }

  private cropArgs(): [number, number, number, number] {
    const { w, h, cropW, cropH } = this.srcDims;
    return [w, h, cropW, cropH];
  }

  private bufferFrame(
    video: HTMLVideoElement,
    mediaTimeSec: number,
    presentedAtMs: number,
    held: boolean
  ): BufferedFrame<FrameSlot> {
    const buffer = this.ensureFrameBuffer();
    const slot = buffer.acquire();
    slot.ctx.drawImage(video, 0, 0, slot.canvas.width, slot.canvas.height);
    this.captureIndex += 1;
    this.lastCapturedMediaTime = mediaTimeSec;
    const frame = { slot, mediaTimeSec, presentedAtMs, frameIndex: this.captureIndex, held, forced: false };
    buffer.enqueue(frame);
    return frame;
  }

  /** The pool, sized for the current delay: copies no larger than the source or than the output canvas can show. */
  private ensureFrameBuffer(): FrameRingBuffer<FrameSlot> {
    if (this.frameBuffer) return this.frameBuffer;
    const isCurrentSize = (slot: FrameSlot) =>
      slot.canvas.width === this.slotSize?.width && slot.canvas.height === this.slotSize.height;
    this.frameBuffer = new FrameRingBuffer<FrameSlot>(
      {
        create: () => {
          const canvas = new OffscreenCanvas(this.slotSize!.width, this.slotSize!.height);
          return { canvas, ctx: canvas.getContext("2d", { alpha: false })! };
        },
        bytesPerNewSlot: () => this.slotSize!.bytesPerSlot,
        bytesOf: (slot) => slot.canvas.width * slot.canvas.height * BYTES_PER_PIXEL,
        isCurrent: isCurrentSize,
      },
      1,
      FRAME_BUFFER_BUDGET_BYTES
    );
    this.sizePool(performance.now());
    return this.frameBuffer;
  }

  /** Height of the output canvas on screen in device pixels, or null when not laid out. */
  private outputHeightOnScreenPx(): number | null {
    const cssHeight = this.canvas?.clientHeight ?? 0;
    if (!cssHeight || typeof devicePixelRatio !== "number") return null;
    return cssHeight * devicePixelRatio;
  }

  private ensureDisplayLoop(): void {
    if (this.displayFrameId === null) this.displayFrameId = requestAnimationFrame(this.boundOnDisplayFrame);
  }

  private stopDisplayLoop(): void {
    if (this.displayFrameId !== null) cancelAnimationFrame(this.displayFrameId);
    this.displayFrameId = null;
    this.lastDisplayCallbackAt = null;
  }

  /**
   * Lookahead drain loop, once per screen refresh, only while no frame
   * callbacks come (paused, buffering, ended) or a held frame was released.
   * Draws the latest frame whose due time (display time + delay) falls on
   * the next refresh: what is drawn now reaches the screen about one
   * refresh later.
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
    const delayMs = this.delaySchedule.valueAt(onScreenAt);
    const frame = buffer.takeLatest((f) => f.presentedAtMs + delayMs <= onScreenAt + this.refreshIntervalMs / 2);
    if (frame) {
      const frameWallMs =
        ((this.knownIntervalSec() ?? DEFAULT_FRAME_INTERVAL_MS / 1000) * 1000) / (this.video?.playbackRate || 1);
      const frameOffset = (onScreenAt - (frame.presentedAtMs + delayMs)) / frameWallMs;
      this.showBufferedFrame(frame, now, onScreenAt, delayMs, frameOffset);
    }

    if (buffer.length > 0) {
      this.ensureDisplayLoop();
    } else if (this.video?.paused) {
      this.lastDisplayCallbackAt = null;
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
    frameMediaTimeSec: number,
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

    const shownAsIsSize = this.sourceShownAsIs
      ? fittedOutputSize(srcW, srcH, currentMode === "16:9" ? 16 / 9 : 9 / 16)
      : null;
    const targetW = shownAsIsSize?.width ?? (currentMode === "16:9" ? srcW : cropW);
    const targetH = shownAsIsSize?.height ?? (currentMode === "16:9" ? srcH : cropH);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    if (!this.outputCtx) this.outputCtx = canvas.getContext("2d");
    const ctx = this.outputCtx!;

    if (shownAsIsSize) {
      drawLetterboxed(ctx, source, srcW, srcH, targetW, targetH);
    } else if (currentMode === "16:9") {
      ctx.drawImage(source, 0, 0, srcW, srcH);
    } else {
      // "9:16" mode: 0 faces -> full frame, no crop; N>=1 -> N panes, each a
      // cover-crop following its face. The layout (pane count/positions) is
      // committed once per debounced face-count change and held fixed;
      // within it, each pane's crop only drifts smoothly toward its target.
      const applied = this.applyDueDecisions(decisionsUpToSec);
      if (applied?.isCut) {
        probe?.recordCutShown(now, applied.mediaTimeSec, frameMediaTimeSec, applied.cutSource ?? "tick");
      }
      if (applied) probe?.recordLayoutRule(now, this.displayedRule, this.displayedSubjectTrackId ?? -1, applied.isCut);
      const speakerCount = this.displayedSpeakerCount;
      const targetSignature = speakerCount === 0 ? "broll" : `speakers:${speakerCount}`;

      const reframe = this.pendingReframe;
      this.pendingReframe = null;
      // After a source cut, the old frame shows the previous shot: never
      // fade from it, and stop any fade still running.
      if (reframe === "snap") this.endLayoutDissolve();

      if (targetSignature !== this.layoutSignature) {
        // Skipped on the very first commit — there's no prior frame to fade from.
        if (this.layoutSignature !== "") {
          this.sceneSwitchCount += 1;
          probe?.recordLayoutChange(now);
          if (reframe !== "snap") this.startLayoutDissolve(now);
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
        if (reframe === "dissolve") this.startLayoutDissolve(now);
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
          drawCrop(ctx, source, smoothed, target.dest, scaleX, scaleY);
        }
      }
      this.drawnLayout.broll = speakerCount === 0;
      this.drawnLayout.targetPanes = this.targetPanes;
      this.drawnLayout.smoothedPanes = this.smoothedPanes;

      const from = this.transitionFrom;
      if (this.transitionStart !== null && from) {
        const t = Math.min(1, (now - this.transitionStart) / LAYOUT_TRANSITION_MS);
        // Ease-in-out: the old framing dissolves away gradually at both
        // ends of the transition instead of snapping out almost
        // immediately, so a speaker coming into focus reads as a smooth
        // reveal. Drawn from this same frame, at the old crop.
        ctx.globalAlpha = 1 - easeInOutCubic(t);
        if (from.broll) {
          drawFitFrame(ctx, this.blurCanvas, source, srcW, srcH, cropW, cropH);
        } else {
          for (const pane of from.panes) drawCrop(ctx, source, pane.source, pane.dest, scaleX, scaleY);
        }
        ctx.globalAlpha = 1;
        if (t >= 1) {
          this.endLayoutDissolve();
          this.emitState();
        }
      }
    }

    if (this.skinRejectionOverlay) this.drawSkinRejectionOverlay(this.skinRejectionOverlay, targetW, targetH);
    if (this.tracksOverlay) this.drawTracksOverlay(this.tracksOverlay, targetW, targetH);
  }
}
