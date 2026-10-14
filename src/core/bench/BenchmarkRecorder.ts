import {
  EMPTY_SUMMARY,
  deltas,
  medianOfPositive,
  ratePerSecond,
  selectWhere,
  sum,
  summarize,
  type SampleSummary,
} from "./stats";
import type { BenchmarkWasmBuild } from "./suitePlan";
import type { CutSource } from "../lookahead/decisionTimeline";

export type DetectionPath = "worker" | "main-thread";

/**
 * What VertixEngine reports into while benchmark mode is on. Every argument
 * is a plain number (or a string literal), so a call never allocates.
 */
export interface BenchmarkProbe {
  recordFrame(nowMs: number, workMs: number, mediaTimeSec: number, presentedFrames: number): void;
  recordDetection(
    path: DetectionPath,
    downscaleMs: number,
    readbackMs: number,
    wasmMs: number,
    postProcessMs: number,
    totalMs: number,
    rawFaceCount: number,
    keptFaceCount: number,
    skinRejectedCount: number,
    skinRejectedSpeakerSizedCount: number,
    frameMediaTimeSec: number,
    sceneCutHist: number,
    sceneCutGrid: number,
    sceneCut: boolean,
    /** Schema v5: dispatched by the per-frame cut trigger instead of the regular tick. */
    triggeredByCut?: boolean,
    /** Schema v5: faces the layout tracks after active-speaker resolution, and the first one's centre x (NaN without one). */
    resolvedFaceCount?: number,
    resolvedCx?: number
  ): void;
  /** A detection was due on this frame but skipped because the previous one had not returned yet. */
  recordSkippedDetection(): void;
  recordLayoutChange(nowMs: number): void;
  /** Main-thread time spent sending one frame to the cut trigger (lookahead only): in total, scaling it (drawImage + transfer), and posting it. */
  recordTriggerCost(mainThreadMs: number, drawMs?: number, postMs?: number): void;
  /**
   * A frame was drawn on the output canvas. `errorMs` (lookahead only) is
   * when it reaches the screen minus when it should (its own display time +
   * the lookahead): the video side of the audio/video offset, since the
   * audio delay is sample-exact. NaN without lookahead.
   */
  recordDisplay(nowMs: number, mediaTimeSec: number, workMs: number, errorMs: number): void;
  /** A hard-cut decision for the frame at `cutMediaTimeSec` was applied on the displayed frame at `shownMediaTimeSec`. */
  recordCutShown(nowMs: number, cutMediaTimeSec: number, shownMediaTimeSec: number, source: CutSource): void;
}

export interface BenchmarkRecorderOptions {
  clipName: string;
  video: HTMLVideoElement;
  /** Media-time seconds from the first recorded frame that are recorded but excluded from the summary. */
  warmupSec: number;
  /** The clip's real frame rate, when known. Otherwise it is estimated from mediaTime steps. */
  nominalFps: number | null;
  /** Media times of the clip's real hard cuts, when known (test clips). */
  knownCutsSec?: readonly number[];
}

// Matches FACE_DETECT_INTERVAL in VertixEngine.ts.
const REGULAR_DETECTION_GAP_FRAMES = 5;
// A crop change more than this long after a known cut is not counted as its change.
const KNOWN_CUT_MATCH_WINDOW_SEC = 1.5;
const CUT_SHOWN_CAPACITY = 1024;
const CUT_SOURCES: CutSource[] = ["tick", "trigger", "localised"];

export interface FrameAccounting {
  /** requestVideoFrameCallback calls after warm-up. */
  callbacks: number;
  /** Increase of `presentedFrames` between the first and last measured callback. */
  presentedFrames: number | null;
  /** Frames the source contains over the same mediaTime span: Δ mediaTime × fps. */
  expectedFrames: number | null;
  /** expectedFrames − presentedFrames, floored at 0. */
  droppedFramesEstimate: number | null;
  /** Frames that were presented but did not get their own callback: presentedFrames − (callbacks − 1). */
  missedCallbacks: number | null;
  /** Callbacks whose presentedFrames equals the previous callback's — more than one render loop is running, so the run is not valid. */
  duplicateCallbacks: number;
  fpsUsed: number | null;
  fpsSource: "nominal" | "estimated" | null;
  /** Increase of getVideoPlaybackQuality().droppedVideoFrames over the measured window, as a cross-check. */
  playbackQualityDroppedFrames: number | null;
  playbackQualityTotalFrames: number | null;
}

export interface DetectionSummary {
  count: number;
  /** Completed detections per wall-clock second over the measured window. */
  rateHz: number | null;
  /** Detections that were due but skipped because the previous one was still running. */
  skippedInFlight: number;
  workerCount: number;
  mainThreadCount: number;
  downscaleMs: SampleSummary;
  readbackMs: SampleSummary;
  /** downscaleMs + readbackMs: getting the 320×240 pixels the model needs. */
  acquireMs: SampleSummary;
  wasmMs: SampleSummary;
  postProcessMs: SampleSummary;
  /** totalMs − (acquire + wasm + post-process): message passing and event-loop queueing. */
  overheadMs: SampleSummary;
  totalMs: SampleSummary;
  rawFaces: SampleSummary;
  keptFaces: SampleSummary;
  /** Detections the skin-tone filter rejected (sum over measured detections); `speakerSized` would also have passed the size/visibility filter. */
  skinRejected: { total: number; speakerSized: number };
}

/** A hard cut the WASM detector found in the source (schema v4). */
export interface SceneCutEvent {
  /** Media time of the detection frame the cut was found on (up to one detection interval after the real cut). */
  mediaTimeSec: number;
  histScore: number;
  gridScore: number;
  /** Found during the clip's warm-up. */
  warmup: boolean;
}

/** A hard-cut decision as the viewer saw it (schema v5). */
export interface CutShownEvent {
  /** Frame the decision belongs to: the detection frame, or with lookahead the located cut frame. */
  cutMediaTimeSec: number;
  /** Displayed frame the crop changed on. */
  shownMediaTimeSec: number;
  /** Displayed frames from cutMediaTimeSec up to (not including) the one the crop changed on. Target 0. */
  framesLate: number;
  /** How the cut was found: the per-frame trigger, localised from a regular detection, or a regular detection ("tick"). */
  source: CutSource;
}

/** A cut whose real time is known (test clips with joins), as the viewer saw it (schema v5). */
export interface KnownCutResult {
  timeSec: number;
  /** Displayed frames from the real cut frame up to the one the crop changed on; null if the crop never changed for it. */
  framesLate: number | null;
  shownMediaTimeSec: number | null;
  /** How the matched cut was found; null if the crop never changed for it. */
  source: CutSource | null;
}

export interface DisplaySummary {
  /** Frames drawn on the output canvas, after warm-up. */
  count: number;
  /** Lookahead only: screen time minus due time per displayed frame (the video side of the A/V offset). */
  errorMs: SampleSummary;
  /** Render cost of one displayed frame (with lookahead: in the display loop, apart from frameWorkMs). */
  workMs: SampleSummary;
}

export interface TriggerSummary {
  count: number;
  /** Main-thread cost per frame: scaling the buffered frame and posting it to the trigger worker. */
  mainThreadMs: SampleSummary;
  /** The two parts of mainThreadMs: drawImage into the small canvas + transferToImageBitmap, and postMessage. Added within v5. */
  drawMs: SampleSummary;
  postMs: SampleSummary;
  /** Detections dispatched by the trigger instead of the regular tick. */
  triggeredDetections: number;
}

/** Gaps between consecutive detections, in frames (schema v5). Mouth motion is measured over this gap. */
export interface DetectionGapSummary {
  /** Pairs of consecutive detections measured. */
  pairs: number;
  /** Pairs whose gap is not FACE_DETECT_INTERVAL (5) frames. */
  irregular: number;
  /** Count per gap length in frames, e.g. { "5": 120, "2": 3 }. */
  histogram: Record<string, number>;
}

export interface LongTaskSummary {
  supported: boolean;
  count: number;
  totalMs: number;
  durationMs: SampleSummary;
}

export interface BenchmarkClipSummary {
  /** Wall-clock span of the measured (post-warm-up) frames. */
  measuredSeconds: number;
  frameWorkMs: SampleSummary;
  frameIntervalMs: SampleSummary;
  effectiveFps: number | null;
  frames: FrameAccounting;
  detection: DetectionSummary;
  layoutChanges: number;
  /** Every detected cut, warm-up included (schema v4). */
  sceneCutCount: number;
  sceneCuts: SceneCutEvent[];
  /** Schema v5. */
  cutsShown: CutShownEvent[];
  knownCuts: KnownCutResult[];
  display: DisplaySummary;
  trigger: TriggerSummary;
  detectionGaps: DetectionGapSummary;
  longTasks: LongTaskSummary;
  /** Samples that did not fit in the preallocated buffers (should always be 0). */
  overflow: { frames: number; detections: number; layoutChanges: number; longTasks: number };
}

export interface BenchmarkClipRaw {
  frames: {
    nowMs: number[];
    workMs: number[];
    mediaTimeSec: number[];
    presentedFrames: number[];
    warmup: number[];
  };
  detections: {
    endedAtMs: number[];
    mediaTimeSec: number[];
    path: DetectionPath[];
    downscaleMs: number[];
    readbackMs: number[];
    wasmMs: number[];
    postProcessMs: number[];
    totalMs: number[];
    rawFaces: number[];
    keptFaces: number[];
    skinRejected: number[];
    skinRejectedSpeakerSized: number[];
    warmup: number[];
    /** Schema v4: media time of the analysed frame (mediaTimeSec above is the time the result arrived). */
    frameMediaTimeSec: number[];
    /** Schema v4: scene-cut scores of every detection (0..1), and 1 where the detector called a cut. */
    sceneCutHist: number[];
    sceneCutGrid: number[];
    sceneCut: number[];
    /** Schema v5: 1 for a detection dispatched by the cut trigger. */
    triggered: number[];
    resolvedFaces: number[];
    resolvedCx: number[];
  };
  /** Schema v5. */
  displays: { nowMs: number[]; mediaTimeSec: number[]; workMs: number[]; errorMs: number[]; warmup: number[] };
  cutsShown: { nowMs: number[]; cutMediaTimeSec: number[]; shownMediaTimeSec: number[]; source: CutSource[] };
  triggers: { mainThreadMs: number[]; drawMs: number[]; postMs: number[]; warmup: number[] };
  skippedDetections: { mediaTimeSec: number[]; warmup: number[] };
  layoutChanges: { nowMs: number[]; mediaTimeSec: number[]; warmup: number[] };
  longTasks: { startTimeMs: number[]; durationMs: number[]; warmup: number[] };
}

/** Lookahead state of one run (schema v5). */
export interface BenchmarkLookahead {
  enabled: boolean;
  unavailableReason: string | null;
  /** Added within v5: on but not running because the mode is 16:9. */
  bypassed: boolean;
  /** Added within v5: the audio delay actually applied (0 when off or bypassed). */
  audioDelayMs: number;
  lengthMs: number;
  /** Added within v5: lengthMs in whole frames. */
  delayFrames: number;
  /** Detection p95 behind lengthMs, and where it came from (measured / stored / default). Added within v5. */
  detectionP95Ms: number | null;
  lengthSource: string;
  slotWidth: number | null;
  slotHeight: number | null;
  allocatedSlots: number;
  /** Estimated frame-buffer memory (RGBA). */
  bufferBytes: number;
  /** Frames dropped by the buffer (full) or superseded on display: overflowDrops + skippedOnDisplay. */
  droppedFrames: number;
  /** Added within v5: frames dropped because the pool was full (should be 0). */
  overflowDrops: number;
  /** Added within v5: frames passed over on display, following a skipped frame callback or a shrinking delay. */
  skippedOnDisplay: number;
  /** Added within v5: frame-copy height changes, `{ mediaTimeSec, height, reason }`. */
  slotHeightChanges: { mediaTimeSec: number; height: number; reason: string }[];
  /** Added within v5: wall time at each frame-copy height, in ms, keyed by height. */
  timeAtSlotHeightMs: Record<string, number>;
}

export interface BenchmarkClipResult {
  clip: string;
  mode: "9:16" | "16:9";
  startedAt: string;
  warmupSec: number;
  video: { width: number; height: number; durationSec: number };
  /** Whether the video was muted at the end of the run (audio energy feeds the 3+ face layout decision). */
  muted: boolean;
  /** True if the page was hidden at any point of the run — browsers throttle or stop frames then, so the run is not valid. */
  pageHiddenDuringRun: boolean;
  /** The WASM build this run used (schema v3). */
  wasmBuild: BenchmarkWasmBuild;
  /** Schema v5. */
  lookahead: BenchmarkLookahead;
  summary: BenchmarkClipSummary;
  raw: BenchmarkClipRaw;
}

/** What the recorder itself knows; the runner adds the build and the lookahead state. */
export type BenchmarkClipRecording = Omit<BenchmarkClipResult, "wasmBuild" | "lookahead">;

// requestVideoFrameCallback fires at most once per new video frame, so this
// bounds the frame buffer for any source up to 120 fps with headroom.
const MAX_FRAME_RATE_HZ = 120;
const BUFFER_HEADROOM = 256;
const FALLBACK_DURATION_SEC = 600;
const LONG_TASK_CAPACITY = 4096;
const LAYOUT_CHANGE_CAPACITY = 1024;
const PATH_WORKER = 0;
const PATH_MAIN_THREAD = 1;

function toArray(values: Float64Array | Uint8Array, length: number): number[] {
  return Array.from(values.subarray(0, length));
}

/**
 * Records one benchmark run of one clip into buffers that are allocated
 * once, up front, from the clip's duration. Recording only writes numbers
 * into typed arrays; all summarizing happens in `finish()`, after playback.
 */
export class BenchmarkRecorder implements BenchmarkProbe {
  private readonly clipName: string;
  private readonly video: HTMLVideoElement;
  private readonly warmupSec: number;
  private readonly nominalFps: number | null;
  private readonly knownCutsSec: readonly number[];
  private readonly startedAt = new Date().toISOString();

  private readonly frameNow: Float64Array;
  private readonly frameWork: Float64Array;
  private readonly frameMediaTime: Float64Array;
  private readonly framePresented: Float64Array;
  private readonly frameWarmup: Uint8Array;
  private frameCount = 0;
  private frameOverflow = 0;

  private readonly detectionEndedAt: Float64Array;
  private readonly detectionMediaTime: Float64Array;
  private readonly detectionPath: Uint8Array;
  private readonly detectionDownscale: Float64Array;
  private readonly detectionReadback: Float64Array;
  private readonly detectionWasm: Float64Array;
  private readonly detectionPost: Float64Array;
  private readonly detectionTotal: Float64Array;
  private readonly detectionRawFaces: Float64Array;
  private readonly detectionKeptFaces: Float64Array;
  private readonly detectionSkinRejected: Float64Array;
  private readonly detectionSkinRejectedSpeakerSized: Float64Array;
  private readonly detectionWarmup: Uint8Array;
  private readonly detectionFrameMediaTime: Float64Array;
  private readonly detectionCutHist: Float64Array;
  private readonly detectionCutGrid: Float64Array;
  private readonly detectionCut: Uint8Array;
  private readonly detectionTriggered: Uint8Array;
  private readonly detectionResolvedFaces: Float64Array;
  private readonly detectionResolvedCx: Float64Array;
  private detectionCount = 0;
  private detectionOverflow = 0;

  private readonly displayNow: Float64Array;
  private readonly displayMediaTime: Float64Array;
  private readonly displayWork: Float64Array;
  private readonly displayError: Float64Array;
  private readonly displayWarmup: Uint8Array;
  private displayCount = 0;

  private readonly cutShownNow = new Float64Array(CUT_SHOWN_CAPACITY);
  private readonly cutShownCut = new Float64Array(CUT_SHOWN_CAPACITY);
  private readonly cutShownAt = new Float64Array(CUT_SHOWN_CAPACITY);
  private readonly cutShownSource = new Uint8Array(CUT_SHOWN_CAPACITY);
  private cutShownCount = 0;

  private readonly triggerCost: Float64Array;
  private readonly triggerDraw: Float64Array;
  private readonly triggerPost: Float64Array;
  private readonly triggerWarmup: Uint8Array;
  private triggerCount = 0;

  private readonly skippedMediaTime: Float64Array;
  private readonly skippedWarmup: Uint8Array;
  private skippedCount = 0;

  private readonly layoutNow = new Float64Array(LAYOUT_CHANGE_CAPACITY);
  private readonly layoutMediaTime = new Float64Array(LAYOUT_CHANGE_CAPACITY);
  private readonly layoutWarmup = new Uint8Array(LAYOUT_CHANGE_CAPACITY);
  private layoutCount = 0;
  private layoutOverflow = 0;

  private readonly longTaskStart = new Float64Array(LONG_TASK_CAPACITY);
  private readonly longTaskDuration = new Float64Array(LONG_TASK_CAPACITY);
  private longTaskCount = 0;
  private longTaskOverflow = 0;
  private longTaskObserver: PerformanceObserver | null = null;

  private warmupEndMediaTime: number | null = null;
  private inWarmup = true;
  private lastMediaTime = 0;
  private measuredFromNow: number | null = null;
  private qualityAtMeasureStart: VideoPlaybackQuality | null = null;
  private finished = false;

  constructor(options: BenchmarkRecorderOptions) {
    this.clipName = options.clipName;
    this.video = options.video;
    this.warmupSec = Math.max(0, options.warmupSec);
    this.nominalFps = options.nominalFps;
    this.knownCutsSec = options.knownCutsSec ?? [];

    const durationSec = Number.isFinite(options.video.duration) ? options.video.duration : FALLBACK_DURATION_SEC;
    const frameCapacity = Math.ceil(durationSec * MAX_FRAME_RATE_HZ) + BUFFER_HEADROOM;
    this.frameNow = new Float64Array(frameCapacity);
    this.frameWork = new Float64Array(frameCapacity);
    this.frameMediaTime = new Float64Array(frameCapacity);
    this.framePresented = new Float64Array(frameCapacity);
    this.frameWarmup = new Uint8Array(frameCapacity);
    this.displayNow = new Float64Array(frameCapacity);
    this.displayMediaTime = new Float64Array(frameCapacity);
    this.displayWork = new Float64Array(frameCapacity);
    this.displayError = new Float64Array(frameCapacity);
    this.displayWarmup = new Uint8Array(frameCapacity);
    this.triggerCost = new Float64Array(frameCapacity);
    this.triggerDraw = new Float64Array(frameCapacity);
    this.triggerPost = new Float64Array(frameCapacity);
    this.triggerWarmup = new Uint8Array(frameCapacity);

    const detectionCapacity = Math.ceil(frameCapacity / 2);
    this.detectionEndedAt = new Float64Array(detectionCapacity);
    this.detectionMediaTime = new Float64Array(detectionCapacity);
    this.detectionPath = new Uint8Array(detectionCapacity);
    this.detectionDownscale = new Float64Array(detectionCapacity);
    this.detectionReadback = new Float64Array(detectionCapacity);
    this.detectionWasm = new Float64Array(detectionCapacity);
    this.detectionPost = new Float64Array(detectionCapacity);
    this.detectionTotal = new Float64Array(detectionCapacity);
    this.detectionRawFaces = new Float64Array(detectionCapacity);
    this.detectionKeptFaces = new Float64Array(detectionCapacity);
    this.detectionSkinRejected = new Float64Array(detectionCapacity);
    this.detectionSkinRejectedSpeakerSized = new Float64Array(detectionCapacity);
    this.detectionWarmup = new Uint8Array(detectionCapacity);
    this.detectionFrameMediaTime = new Float64Array(detectionCapacity);
    this.detectionCutHist = new Float64Array(detectionCapacity);
    this.detectionCutGrid = new Float64Array(detectionCapacity);
    this.detectionCut = new Uint8Array(detectionCapacity);
    this.detectionTriggered = new Uint8Array(detectionCapacity);
    this.detectionResolvedFaces = new Float64Array(detectionCapacity);
    this.detectionResolvedCx = new Float64Array(detectionCapacity);
    this.skippedMediaTime = new Float64Array(detectionCapacity);
    this.skippedWarmup = new Uint8Array(detectionCapacity);

    try {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.pushLongTask(entry.startTime, entry.duration);
      });
      this.longTaskObserver.observe({ type: "longtask" });
    } catch {
      this.longTaskObserver = null;
    }
  }

  recordFrame(nowMs: number, workMs: number, mediaTimeSec: number, presentedFrames: number): void {
    if (this.finished) return;
    if (this.warmupEndMediaTime === null) this.warmupEndMediaTime = mediaTimeSec + this.warmupSec;
    this.inWarmup = mediaTimeSec < this.warmupEndMediaTime;
    this.lastMediaTime = mediaTimeSec;
    if (!this.inWarmup && this.measuredFromNow === null) {
      this.measuredFromNow = nowMs;
      this.qualityAtMeasureStart = this.video.getVideoPlaybackQuality?.() ?? null;
    }

    const i = this.frameCount;
    if (i >= this.frameNow.length) {
      this.frameOverflow += 1;
      return;
    }
    this.frameNow[i] = nowMs;
    this.frameWork[i] = workMs;
    this.frameMediaTime[i] = mediaTimeSec;
    this.framePresented[i] = presentedFrames;
    this.frameWarmup[i] = this.inWarmup ? 1 : 0;
    this.frameCount = i + 1;
  }

  recordDetection(
    path: DetectionPath,
    downscaleMs: number,
    readbackMs: number,
    wasmMs: number,
    postProcessMs: number,
    totalMs: number,
    rawFaceCount: number,
    keptFaceCount: number,
    skinRejectedCount: number,
    skinRejectedSpeakerSizedCount: number,
    frameMediaTimeSec: number,
    sceneCutHist: number,
    sceneCutGrid: number,
    sceneCut: boolean,
    triggeredByCut = false,
    resolvedFaceCount = NaN,
    resolvedCx = NaN
  ): void {
    if (this.finished) return;
    const i = this.detectionCount;
    if (i >= this.detectionTotal.length) {
      this.detectionOverflow += 1;
      return;
    }
    this.detectionEndedAt[i] = performance.now();
    this.detectionMediaTime[i] = this.lastMediaTime;
    this.detectionPath[i] = path === "worker" ? PATH_WORKER : PATH_MAIN_THREAD;
    this.detectionDownscale[i] = downscaleMs;
    this.detectionReadback[i] = readbackMs;
    this.detectionWasm[i] = wasmMs;
    this.detectionPost[i] = postProcessMs;
    this.detectionTotal[i] = totalMs;
    this.detectionRawFaces[i] = rawFaceCount;
    this.detectionKeptFaces[i] = keptFaceCount;
    this.detectionSkinRejected[i] = skinRejectedCount;
    this.detectionSkinRejectedSpeakerSized[i] = skinRejectedSpeakerSizedCount;
    this.detectionWarmup[i] = this.inWarmup ? 1 : 0;
    this.detectionFrameMediaTime[i] = frameMediaTimeSec;
    this.detectionCutHist[i] = sceneCutHist;
    this.detectionCutGrid[i] = sceneCutGrid;
    this.detectionCut[i] = sceneCut ? 1 : 0;
    this.detectionTriggered[i] = triggeredByCut ? 1 : 0;
    this.detectionResolvedFaces[i] = resolvedFaceCount;
    this.detectionResolvedCx[i] = resolvedCx;
    this.detectionCount = i + 1;
  }

  recordSkippedDetection(): void {
    if (this.finished) return;
    const i = this.skippedCount;
    if (i >= this.skippedMediaTime.length) {
      this.detectionOverflow += 1;
      return;
    }
    this.skippedMediaTime[i] = this.lastMediaTime;
    this.skippedWarmup[i] = this.inWarmup ? 1 : 0;
    this.skippedCount = i + 1;
  }

  recordDisplay(nowMs: number, mediaTimeSec: number, workMs: number, errorMs: number): void {
    if (this.finished) return;
    const i = this.displayCount;
    if (i >= this.displayNow.length) {
      this.frameOverflow += 1;
      return;
    }
    this.displayNow[i] = nowMs;
    this.displayMediaTime[i] = mediaTimeSec;
    this.displayWork[i] = workMs;
    this.displayError[i] = errorMs;
    this.displayWarmup[i] = this.warmupEndMediaTime !== null && mediaTimeSec < this.warmupEndMediaTime ? 1 : 0;
    this.displayCount = i + 1;
  }

  recordCutShown(nowMs: number, cutMediaTimeSec: number, shownMediaTimeSec: number, source: CutSource): void {
    if (this.finished) return;
    const i = this.cutShownCount;
    if (i >= CUT_SHOWN_CAPACITY) {
      this.layoutOverflow += 1;
      return;
    }
    this.cutShownNow[i] = nowMs;
    this.cutShownCut[i] = cutMediaTimeSec;
    this.cutShownAt[i] = shownMediaTimeSec;
    this.cutShownSource[i] = CUT_SOURCES.indexOf(source);
    this.cutShownCount = i + 1;
  }

  recordTriggerCost(mainThreadMs: number, drawMs = NaN, postMs = NaN): void {
    if (this.finished) return;
    const i = this.triggerCount;
    if (i >= this.triggerCost.length) {
      this.frameOverflow += 1;
      return;
    }
    this.triggerCost[i] = mainThreadMs;
    this.triggerDraw[i] = drawMs;
    this.triggerPost[i] = postMs;
    this.triggerWarmup[i] = this.inWarmup ? 1 : 0;
    this.triggerCount = i + 1;
  }

  recordLayoutChange(nowMs: number): void {
    if (this.finished) return;
    const i = this.layoutCount;
    if (i >= LAYOUT_CHANGE_CAPACITY) {
      this.layoutOverflow += 1;
      return;
    }
    this.layoutNow[i] = nowMs;
    this.layoutMediaTime[i] = this.lastMediaTime;
    this.layoutWarmup[i] = this.inWarmup ? 1 : 0;
    this.layoutCount = i + 1;
  }

  /** Stops recording and builds the result. Recording calls after this are ignored. */
  finish(mode: "9:16" | "16:9"): BenchmarkClipRecording {
    if (!this.finished) {
      this.finished = true;
      if (this.longTaskObserver) {
        for (const entry of this.longTaskObserver.takeRecords()) this.pushLongTask(entry.startTime, entry.duration);
        this.longTaskObserver.disconnect();
      }
    }
    return {
      clip: this.clipName,
      mode,
      startedAt: this.startedAt,
      warmupSec: this.warmupSec,
      video: { width: this.video.videoWidth, height: this.video.videoHeight, durationSec: this.video.duration },
      muted: this.video.muted,
      pageHiddenDuringRun: false,
      summary: this.summarize(),
      raw: this.rawSamples(),
    };
  }

  private pushLongTask(startTime: number, duration: number): void {
    const i = this.longTaskCount;
    if (i >= LONG_TASK_CAPACITY) {
      this.longTaskOverflow += 1;
      return;
    }
    this.longTaskStart[i] = startTime;
    this.longTaskDuration[i] = duration;
    this.longTaskCount = i + 1;
  }

  private isLongTaskInWarmup(index: number): boolean {
    return this.measuredFromNow === null || this.longTaskStart[index] < this.measuredFromNow;
  }

  private summarize(): BenchmarkClipSummary {
    const frameCount = this.frameCount;
    const measuredFrame = (i: number) => this.frameWarmup[i] === 0;
    const now = selectWhere(this.frameNow.subarray(0, frameCount), measuredFrame);
    const mediaTime = selectWhere(this.frameMediaTime.subarray(0, frameCount), measuredFrame);
    const presented = selectWhere(this.framePresented.subarray(0, frameCount), measuredFrame);
    const work = selectWhere(this.frameWork.subarray(0, frameCount), measuredFrame);

    const detectionCount = this.detectionCount;
    const measuredDetection = (i: number) => this.detectionWarmup[i] === 0;
    const pick = (column: Float64Array) => selectWhere(column.subarray(0, detectionCount), measuredDetection);
    const downscale = pick(this.detectionDownscale);
    const readback = pick(this.detectionReadback);
    const wasm = pick(this.detectionWasm);
    const post = pick(this.detectionPost);
    const total = pick(this.detectionTotal);
    const acquire = downscale.map((d, i) => d + readback[i]);
    const overhead = total.map((t, i) => t - acquire[i] - wasm[i] - post[i]);
    const paths = selectWhere(this.detectionPath.subarray(0, detectionCount), measuredDetection);
    const workerCount = paths.filter((p) => p === PATH_WORKER).length;

    let skippedInFlight = 0;
    for (let i = 0; i < this.skippedCount; i++) if (this.skippedWarmup[i] === 0) skippedInFlight += 1;

    let longTaskCount = 0;
    let longTaskTotal = 0;
    const longTaskDurations: number[] = [];
    for (let i = 0; i < this.longTaskCount; i++) {
      if (this.isLongTaskInWarmup(i)) continue;
      longTaskCount += 1;
      longTaskTotal += this.longTaskDuration[i];
      longTaskDurations.push(this.longTaskDuration[i]);
    }

    let layoutChanges = 0;
    for (let i = 0; i < this.layoutCount; i++) if (this.layoutWarmup[i] === 0) layoutChanges += 1;

    const sceneCuts: SceneCutEvent[] = [];
    for (let i = 0; i < detectionCount; i++) {
      if (this.detectionCut[i] === 0) continue;
      sceneCuts.push({
        mediaTimeSec: this.detectionFrameMediaTime[i],
        histScore: this.detectionCutHist[i],
        gridScore: this.detectionCutGrid[i],
        warmup: this.detectionWarmup[i] === 1,
      });
    }

    const measuredSeconds = now.length >= 2 ? (now[now.length - 1] - now[0]) / 1000 : 0;
    const frames = this.frameAccounting(mediaTime, presented);

    const measuredDisplay = (i: number) => this.displayWarmup[i] === 0;
    const measuredTrigger = (i: number) => this.triggerWarmup[i] === 0;
    const displayCount = this.displayCount;
    let triggeredDetections = 0;
    for (let i = 0; i < detectionCount; i++) if (this.detectionTriggered[i] === 1) triggeredDetections += 1;

    return {
      measuredSeconds,
      frameWorkMs: summarize(work),
      frameIntervalMs: now.length >= 2 ? summarize(deltas(now)) : EMPTY_SUMMARY,
      effectiveFps: ratePerSecond(now),
      frames,
      detection: {
        count: total.length,
        rateHz: measuredSeconds > 0 ? total.length / measuredSeconds : null,
        skippedInFlight,
        workerCount,
        mainThreadCount: paths.length - workerCount,
        downscaleMs: summarize(downscale),
        readbackMs: summarize(readback),
        acquireMs: summarize(acquire),
        wasmMs: summarize(wasm),
        postProcessMs: summarize(post),
        overheadMs: summarize(overhead),
        totalMs: summarize(total),
        rawFaces: summarize(pick(this.detectionRawFaces)),
        keptFaces: summarize(pick(this.detectionKeptFaces)),
        skinRejected: {
          total: sum(pick(this.detectionSkinRejected)),
          speakerSized: sum(pick(this.detectionSkinRejectedSpeakerSized)),
        },
      },
      layoutChanges,
      sceneCutCount: sceneCuts.length,
      sceneCuts,
      cutsShown: this.cutsShown(),
      knownCuts: this.knownCutResults(),
      display: {
        count: selectWhere(this.displayMediaTime.subarray(0, displayCount), measuredDisplay).length,
        errorMs: summarize(selectWhere(this.displayError.subarray(0, displayCount), measuredDisplay)),
        workMs: summarize(selectWhere(this.displayWork.subarray(0, displayCount), measuredDisplay)),
      },
      trigger: {
        count: this.triggerCount,
        mainThreadMs: summarize(selectWhere(this.triggerCost.subarray(0, this.triggerCount), measuredTrigger)),
        drawMs: summarize(selectWhere(this.triggerDraw.subarray(0, this.triggerCount), measuredTrigger)),
        postMs: summarize(selectWhere(this.triggerPost.subarray(0, this.triggerCount), measuredTrigger)),
        triggeredDetections,
      },
      detectionGaps: this.detectionGaps(frames.fpsUsed),
      longTasks: {
        supported: this.longTaskObserver !== null,
        count: longTaskCount,
        totalMs: longTaskTotal,
        durationMs: summarize(longTaskDurations),
      },
      overflow: {
        frames: this.frameOverflow,
        detections: this.detectionOverflow,
        layoutChanges: this.layoutOverflow,
        longTasks: this.longTaskOverflow,
      },
    };
  }

  /** Displayed frames with media time in [fromSec, toSec). */
  private displayedFramesBetween(fromSec: number, toSec: number): number {
    const eps = 1e-4;
    let count = 0;
    for (let i = 0; i < this.displayCount; i++) {
      const t = this.displayMediaTime[i];
      if (t >= fromSec - eps && t < toSec - eps) count += 1;
    }
    return count;
  }

  private cutsShown(): CutShownEvent[] {
    const events: CutShownEvent[] = [];
    for (let i = 0; i < this.cutShownCount; i++) {
      const cutMediaTimeSec = this.cutShownCut[i];
      const shownMediaTimeSec = this.cutShownAt[i];
      events.push({
        cutMediaTimeSec,
        shownMediaTimeSec,
        framesLate: this.displayedFramesBetween(cutMediaTimeSec, shownMediaTimeSec),
        source: CUT_SOURCES[this.cutShownSource[i]],
      });
    }
    return events;
  }

  private knownCutResults(): KnownCutResult[] {
    return this.knownCutsSec.map((timeSec) => {
      let shownMediaTimeSec: number | null = null;
      let source: CutSource | null = null;
      for (let i = 0; i < this.cutShownCount; i++) {
        const shown = this.cutShownAt[i];
        if (shown >= timeSec - 1e-4 && shown < timeSec + KNOWN_CUT_MATCH_WINDOW_SEC) {
          shownMediaTimeSec = shown;
          source = CUT_SOURCES[this.cutShownSource[i]];
          break;
        }
      }
      return {
        timeSec,
        shownMediaTimeSec,
        source,
        framesLate: shownMediaTimeSec === null ? null : this.displayedFramesBetween(timeSec, shownMediaTimeSec),
      };
    });
  }

  private detectionGaps(fps: number | null): DetectionGapSummary {
    const histogram: Record<string, number> = {};
    let pairs = 0;
    let irregular = 0;
    if (fps !== null) {
      for (let i = 1; i < this.detectionCount; i++) {
        const step = this.detectionFrameMediaTime[i] - this.detectionFrameMediaTime[i - 1];
        if (step <= 0) continue;
        const gap = Math.round(step * fps);
        histogram[gap] = (histogram[gap] ?? 0) + 1;
        pairs += 1;
        if (gap !== REGULAR_DETECTION_GAP_FRAMES) irregular += 1;
      }
    }
    return { pairs, irregular, histogram };
  }

  private frameAccounting(mediaTime: Float64Array, presented: Float64Array): FrameAccounting {
    const callbacks = mediaTime.length;
    let duplicateCallbacks = 0;
    for (let i = 1; i < callbacks; i++) if (presented[i] === presented[i - 1]) duplicateCallbacks += 1;
    const quality = this.video.getVideoPlaybackQuality?.() ?? null;
    const qualityStart = this.qualityAtMeasureStart;
    const playbackQualityDroppedFrames =
      quality && qualityStart ? quality.droppedVideoFrames - qualityStart.droppedVideoFrames : null;
    const playbackQualityTotalFrames =
      quality && qualityStart ? quality.totalVideoFrames - qualityStart.totalVideoFrames : null;

    if (callbacks < 2) {
      return {
        callbacks,
        presentedFrames: null,
        expectedFrames: null,
        droppedFramesEstimate: null,
        missedCallbacks: null,
        duplicateCallbacks,
        fpsUsed: null,
        fpsSource: null,
        playbackQualityDroppedFrames,
        playbackQualityTotalFrames,
      };
    }

    const estimatedFrameDuration = medianOfPositive(deltas(mediaTime));
    const fpsUsed = this.nominalFps ?? (estimatedFrameDuration ? 1 / estimatedFrameDuration : null);
    const presentedFrames = presented[callbacks - 1] - presented[0];
    const mediaSpan = mediaTime[callbacks - 1] - mediaTime[0];
    const expectedFrames = fpsUsed !== null ? Math.round(mediaSpan * fpsUsed) : null;

    return {
      callbacks,
      presentedFrames,
      expectedFrames,
      droppedFramesEstimate: expectedFrames !== null ? Math.max(0, expectedFrames - presentedFrames) : null,
      missedCallbacks: presentedFrames - (callbacks - 1),
      duplicateCallbacks,
      fpsUsed,
      fpsSource: fpsUsed === null ? null : this.nominalFps !== null ? "nominal" : "estimated",
      playbackQualityDroppedFrames,
      playbackQualityTotalFrames,
    };
  }

  private rawSamples(): BenchmarkClipRaw {
    const f = this.frameCount;
    const d = this.detectionCount;
    const s = this.skippedCount;
    const l = this.layoutCount;
    const t = this.longTaskCount;
    const longTaskWarmup: number[] = [];
    for (let i = 0; i < t; i++) longTaskWarmup.push(this.isLongTaskInWarmup(i) ? 1 : 0);
    return {
      frames: {
        nowMs: toArray(this.frameNow, f),
        workMs: toArray(this.frameWork, f),
        mediaTimeSec: toArray(this.frameMediaTime, f),
        presentedFrames: toArray(this.framePresented, f),
        warmup: toArray(this.frameWarmup, f),
      },
      detections: {
        endedAtMs: toArray(this.detectionEndedAt, d),
        mediaTimeSec: toArray(this.detectionMediaTime, d),
        path: toArray(this.detectionPath, d).map((p) => (p === PATH_WORKER ? "worker" : "main-thread")),
        downscaleMs: toArray(this.detectionDownscale, d),
        readbackMs: toArray(this.detectionReadback, d),
        wasmMs: toArray(this.detectionWasm, d),
        postProcessMs: toArray(this.detectionPost, d),
        totalMs: toArray(this.detectionTotal, d),
        rawFaces: toArray(this.detectionRawFaces, d),
        keptFaces: toArray(this.detectionKeptFaces, d),
        skinRejected: toArray(this.detectionSkinRejected, d),
        skinRejectedSpeakerSized: toArray(this.detectionSkinRejectedSpeakerSized, d),
        warmup: toArray(this.detectionWarmup, d),
        frameMediaTimeSec: toArray(this.detectionFrameMediaTime, d),
        sceneCutHist: toArray(this.detectionCutHist, d),
        sceneCutGrid: toArray(this.detectionCutGrid, d),
        sceneCut: toArray(this.detectionCut, d),
        triggered: toArray(this.detectionTriggered, d),
        resolvedFaces: toArray(this.detectionResolvedFaces, d),
        resolvedCx: toArray(this.detectionResolvedCx, d),
      },
      displays: {
        nowMs: toArray(this.displayNow, this.displayCount),
        mediaTimeSec: toArray(this.displayMediaTime, this.displayCount),
        workMs: toArray(this.displayWork, this.displayCount),
        errorMs: toArray(this.displayError, this.displayCount),
        warmup: toArray(this.displayWarmup, this.displayCount),
      },
      cutsShown: {
        nowMs: toArray(this.cutShownNow, this.cutShownCount),
        cutMediaTimeSec: toArray(this.cutShownCut, this.cutShownCount),
        shownMediaTimeSec: toArray(this.cutShownAt, this.cutShownCount),
        source: toArray(this.cutShownSource, this.cutShownCount).map((s) => CUT_SOURCES[s]),
      },
      triggers: {
        mainThreadMs: toArray(this.triggerCost, this.triggerCount),
        drawMs: toArray(this.triggerDraw, this.triggerCount),
        postMs: toArray(this.triggerPost, this.triggerCount),
        warmup: toArray(this.triggerWarmup, this.triggerCount),
      },
      skippedDetections: {
        mediaTimeSec: toArray(this.skippedMediaTime, s),
        warmup: toArray(this.skippedWarmup, s),
      },
      layoutChanges: {
        nowMs: toArray(this.layoutNow, l),
        mediaTimeSec: toArray(this.layoutMediaTime, l),
        warmup: toArray(this.layoutWarmup, l),
      },
      longTasks: {
        startTimeMs: toArray(this.longTaskStart, t),
        durationMs: toArray(this.longTaskDuration, t),
        warmup: longTaskWarmup,
      },
    };
  }
}
