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
  /** Current voice-activity energy (0-1 RMS) from the audio track, or null when audioAvailable is false. Only meaningful once MANY_SPEAKERS_THRESHOLD (3) or more raw faces are detected. */
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

const INITIAL_METRICS: VertixMetrics = {
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

/** Cubic ease-in-out (gentle start, gentle finish) — shapes the layout cross-dissolve so it reads as a smooth reveal, not a snap. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Detection resolution the face model is fed — drawn as a plain stretch
// fill (not letterboxed), so a detected face's fractional position maps
// directly onto the same fraction of the source frame.
const FACE_W = 320;
const FACE_H = 240;
// Face detection (synchronous WASM/ONNX inference, blocks this thread while
// it runs) only runs on every Nth frame; drawing and the pane LERP below
// still run every frame regardless. Kept on the main thread on purpose — a
// Web Worker version added enough round-trip latency to the tracking
// target that panning read as disconnected, even though raw FPS went up.
const FACE_DETECT_INTERVAL = 4;

// A face only counts toward the layout if it's at least this tall or wide,
// as a fraction of the frame — filters out background people (footballers
// on the pitch, crowd/spectators), which the model still happily detects
// but which typically only occupy 2-8% of the frame, vs. a real on-camera
// interview subject's close-up framing.
const MIN_SPEAKER_FACE_SIZE = 0.12;
// A face must be at least this visible within the frame (not cropped off
// at an edge) to count — see `faceVisibleFraction`. Guards against a
// half-visible face at the frame boundary triggering a split.
const MIN_FACE_VISIBLE_FRACTION = 0.8;

// A person-count change only takes effect once this many consecutive
// detection ticks agree, so a momentary misdetection doesn't flip the
// layout and back. Three thresholds for three cases: the very first
// layout commit (nothing on screen yet, so no flicker risk) can be fast;
// a normal mid-stream count change needs more confirmation; dropping to 0
// speakers (B-roll) sits in between — faster than a normal change, since
// staying cropped over an empty shot looks worse than briefly widening
// out, but not instant, so a single stray frame can't flip the layout.
const PERSON_COUNT_STABLE_TICKS_INITIAL = 2;
const PERSON_COUNT_STABLE_TICKS = 6;
const PERSON_COUNT_DROP_TO_ZERO_TICKS = 2;

// --- "Many faces, ambiguous scene" safety fallback ------------------------
// A raw face count at or above this is what runs the active-speaker check
// below. Originally 4 (strictly above any bundled sample's face count), but
// real press-scrum footage — one person talking, several silent bystanders
// close enough to camera to pass the size/visibility filter — routinely
// filters down to exactly 3 valid faces, the same count as a genuine 3-way
// conversation (3-speakers.mp4). Telling those apart needs this same
// audio+motion check at 3 too; see AMBIGUOUS_GRID_FALLBACK_FACES below for
// how 3-speakers.mp4 stays unaffected when nobody dominates.
const MANY_SPEAKERS_THRESHOLD = 3;
// At exactly this many raw faces, a scene the audio+motion check can't
// confidently resolve (no clear winner, nothing locked yet) falls back to
// today's ordinary N-pane grid instead of the full-frame fallback used
// above this count. This is what keeps 3-speakers.mp4's natural back-and-
// forth conversation showing its usual 3-way grid during any stretch where
// nobody's mouth motion clearly dominates — a real press scrum, by
// contrast, only ever produces a confident winner (the one person actually
// talking) or nothing yet locked, both already handled below. Above this
// count, an unresolved scene is assumed too crowded to guess at and falls
// back to no crop instead, per MANY_SPEAKERS_THRESHOLD's own reasoning.
const AMBIGUOUS_GRID_FALLBACK_FACES = 3;
// RMS energy (0-1) below which the audio track counts as silence/room tone
// for this purpose, not speech. A coarse, untuned starting value — see the
// README's "Known limitations" section for why: it hasn't been checked
// against real broadcast audio yet.
const AUDIO_ACTIVE_ENERGY = 0.02;
// A face's mouth-motion score must beat the next-highest candidate's by at
// least this multiple to count as an unambiguous single active speaker —
// otherwise several people moving similarly (nodding, cross-talk) would
// flip the pick every detection tick.
const ACTIVE_SPEAKER_MARGIN = 1.5;
// A face's size (the same max(w,h) fraction used for MIN_SPEAKER_FACE_SIZE
// and the dashboard's faceSizes) must beat the next-largest face's by at
// least this multiple to count as clearly the foregrounded subject.
// Checked before motion, and without needing audio (see
// resolveLayoutFaces) — motion alone turned out too weak a signal in
// handheld, shaky press-scrum footage, where camera
// shake adds apparent "motion" to every face in frame, not just whoever's
// actually talking. Framing size doesn't have that problem, and interview
// subjects are conventionally shot larger than bystanders around them —
// confirmed against a real scrum where the actual speaker's face measured
// roughly 2x the size of the two next-largest (39.1% vs. 19.9%/17.7% of
// frame), so 1.4 leaves real margin either side of that.
const FACE_SIZE_DOMINANCE_MARGIN = 1.4;
// How many consecutive detection ticks a new candidate must keep winning
// before the engine actually moves its lock onto them — same role as
// PERSON_COUNT_STABLE_TICKS, applied to *which* face instead of how many.
const ACTIVE_SPEAKER_LOCK_TICKS = 5;
// Two face positions (fractions of frame) within this distance of each
// other count as "the same person" from one tick to the next, for both the
// lock-streak check and for re-finding the locked speaker's current face.
const SAME_PERSON_DISTANCE = 0.08;

// How much each pane's crop glides toward its subject's latest detected
// position per rendered frame (0-1) — gentle camera-follow *within* an
// already-stable layout (same face count), not a trigger for changing the
// layout itself.
const PANE_SMOOTHING_ALPHA = 0.08;

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

  private engine: InstanceType<typeof ReframeEngine> | null = null;
  private wasmReady = false;
  private wasmLoading: Promise<void> | null = null;

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
    // Starts loading immediately, not on first `attach` — a host typically
    // constructs the engine well before it has a video/canvas to attach to
    // (e.g. while the user is still picking a file), and that dead time is
    // exactly when this latency should be hidden.
    this.ensureWasm();
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

  /** Fully tears the engine down, including the WASM instance. The engine can't be reused after this — construct a new one. */
  destroy(): void {
    this.detach();
    this.audioMonitor.detach();
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
      wasmReady: this.wasmReady,
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
    this.metrics = INITIAL_METRICS;
    this.resetTrackingState();
    this.emitState();
    this.emitMetrics();
  }

  /** Clears face-tracking/layout state without touching video dimensions or WASM readiness — used on seek and mode changes. */
  private resetTrackingState(): void {
    this.engine?.reset();
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
   * track this tick. Below MANY_SPEAKERS_THRESHOLD (3), returns them
   * unchanged — exactly today's behavior for 0-2 faces.
   *
   * At 3 or more, a grid stops being a safe default — it's as likely to be
   * a press scrum (one person talking, several bystanders close enough to
   * pass the size/visibility filter) as a genuine multi-person
   * conversation, and the multi-pane grid was never designed or tuned for
   * the former. Resolves to whichever single face is clearly the active
   * subject — checked by framing size first (no audio needed: this app
   * loads every video muted by default, so a signal that required audio
   * would sit unused until someone manually unmutes), then by audio+motion
   * only if no one's clearly foregrounded — confidently locked onto for a
   * few ticks, so a noisy read doesn't flip who's framed every detection
   * tick. Or, whenever neither signal can determine that (no audio track,
   * silence/muted with nobody foregrounded either, or no single face
   * clearly out in front of the others by either signal): at exactly
   * AMBIGUOUS_GRID_FALLBACK_FACES (3), the raw faces unchanged (today's
   * ordinary grid — this is what keeps 3-speakers.mp4's natural
   * conversation looking as it always has whenever nobody's clearly
   * dominant); above it, an empty array, which the caller already treats
   * as "show the full frame" for the zero-face case. This is a heuristic,
   * not a guarantee: it trades away some cases where a real multi-person
   * panel *could* have been framed correctly, in exchange for never
   * confidently showing a wrong crop on a scene it can't actually make
   * sense of.
   */
  private resolveLayoutFaces(rawFaces: FaceBox[]): FaceBox[] {
    if (rawFaces.length < MANY_SPEAKERS_THRESHOLD) return rawFaces;
    const ambiguousFallback = rawFaces.length === AMBIGUOUS_GRID_FALLBACK_FACES ? rawFaces : [];

    // Framing size doesn't need audio to be meaningful, and deliberately
    // isn't gated on it: this app loads every video muted by default (see
    // useWasmReframe's load()), so requiring audio here would mean this
    // whole signal sits unused for anyone who hasn't manually unmuted —
    // exactly the state a clearly-foregrounded interview subject should
    // still be identifiable in.
    let winner = dominantBy(rawFaces, (f) => Math.max(f.w, f.h), FACE_SIZE_DOMINANCE_MARGIN);

    if (winner === null) {
      // No one's clearly foregrounded — a same-sized panel, where framing
      // alone can't say who's talking. Mouth motion can, but only once we
      // know *someone* actually is (unmuted audio above the noise floor);
      // otherwise motion from camera shake or ordinary gesturing is as
      // likely to win as real speech.
      const energy = this.audioMonitor.energy();
      winner =
        energy !== null && energy >= AUDIO_ACTIVE_ENERGY
          ? dominantBy(rawFaces, (f) => f.motion, ACTIVE_SPEAKER_MARGIN)
          : null;
    }

    if (winner === null) {
      // Neither signal found a confident subject — don't restart the
      // lock-in streak over one ambiguous tick, but don't extend it
      // either; keep showing whoever was already locked on, if anyone.
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

  // Runs on every decoded frame. Rendering happens synchronously here (not
  // through any framework state) so playback stays perfectly in sync with
  // audio.
  private onVideoFrame(now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void {
    const video = this.video;
    const canvas = this.canvas;
    if (!video || !canvas || video.paused || video.ended) {
      this.running = false;
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
      this.metrics = {
        ...this.metrics,
        fps: this.fpsEma,
        frameTimeMs: this.frameTimeEma,
        fpsHistory: appendCapped(this.metrics.fpsHistory, this.fpsEma),
        frameTimeHistory: appendCapped(this.metrics.frameTimeHistory, this.frameTimeEma),
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
      if (this.frameCounter % FACE_DETECT_INTERVAL === 0 && this.engine) {
        this.faceCtx.drawImage(video, 0, 0, FACE_W, FACE_H);
        const faceImageData = this.faceCtx.getImageData(0, 0, FACE_W, FACE_H);
        const facesFlat = this.engine.update_faces(new Uint8Array(faceImageData.data.buffer));
        // Background people (players on the pitch, crowd) still get
        // detected by the model, and a half-visible face clipped at the
        // frame edge isn't a usable speaker either — only close-up,
        // unclipped faces count as an actual interview subject.
        this.lastFaces = unpackFaces(facesFlat).filter(
          (f) =>
            (f.h >= MIN_SPEAKER_FACE_SIZE || f.w >= MIN_SPEAKER_FACE_SIZE) &&
            faceVisibleFraction(f) >= MIN_FACE_VISIBLE_FRACTION
        );

        // Resolves the raw detected faces down to what layout should
        // actually track — unchanged for 0-3 faces, but for 4+ (a scene the
        // grid layout was never validated on) either the single face the
        // audio track says is talking, or none at all, treated exactly
        // like the zero-face case below. See MANY_SPEAKERS_THRESHOLD.
        this.lastResolvedFaces = this.resolveLayoutFaces(this.lastFaces);
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
          audioEnergy: this.audioMonitor.energy(),
          motionHistory:
            motionScore !== null ? appendCapped(this.metrics.motionHistory, motionScore) : this.metrics.motionHistory,
          confidenceHistory:
            faceConfidence !== null
              ? appendCapped(this.metrics.confidenceHistory, faceConfidence)
              : this.metrics.confidenceHistory,
        };
        this.emitMetrics();

        // Only refresh the LERP target once the raw count matches the
        // *committed* layout — otherwise, mid-debounce, this could compute
        // a different pane count than what's actually on screen. The
        // deadzone itself lives inside computeSpeakerLayout.
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

      const targetSignature = this.stablePersonCount === 0 ? "broll" : `speakers:${this.stablePersonCount}`;

      if (targetSignature !== this.layoutSignature) {
        // Snapshot the current frame before it's overwritten, so the layout
        // change dissolves in instead of cutting. Skipped on the very first
        // commit — there's no prior frame to fade from.
        if (this.layoutSignature !== "") {
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
          this.sceneSwitchCount += 1;
        }
        this.layoutSignature = targetSignature;

        // A genuinely new layout snaps straight to its target (empty
        // `previous` — every pane counts as "moved") instead of lerping
        // from whatever the old layout's positions were.
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
