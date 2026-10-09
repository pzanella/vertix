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
    skinRejectedSpeakerSizedCount: number
  ): void;
  /** A detection was due on this frame but skipped because the previous one had not returned yet. */
  recordSkippedDetection(): void;
  recordLayoutChange(nowMs: number): void;
}

export interface BenchmarkRecorderOptions {
  clipName: string;
  video: HTMLVideoElement;
  /** Media-time seconds from the first recorded frame that are recorded but excluded from the summary. */
  warmupSec: number;
  /** The clip's real frame rate, when known. Otherwise it is estimated from mediaTime steps. */
  nominalFps: number | null;
}

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
  };
  skippedDetections: { mediaTimeSec: number[]; warmup: number[] };
  layoutChanges: { nowMs: number[]; mediaTimeSec: number[]; warmup: number[] };
  longTasks: { startTimeMs: number[]; durationMs: number[]; warmup: number[] };
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
  summary: BenchmarkClipSummary;
  raw: BenchmarkClipRaw;
}

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
  private detectionCount = 0;
  private detectionOverflow = 0;

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

    const durationSec = Number.isFinite(options.video.duration) ? options.video.duration : FALLBACK_DURATION_SEC;
    const frameCapacity = Math.ceil(durationSec * MAX_FRAME_RATE_HZ) + BUFFER_HEADROOM;
    this.frameNow = new Float64Array(frameCapacity);
    this.frameWork = new Float64Array(frameCapacity);
    this.frameMediaTime = new Float64Array(frameCapacity);
    this.framePresented = new Float64Array(frameCapacity);
    this.frameWarmup = new Uint8Array(frameCapacity);

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
    skinRejectedSpeakerSizedCount: number
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
  finish(mode: "9:16" | "16:9"): BenchmarkClipResult {
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

    const measuredSeconds = now.length >= 2 ? (now[now.length - 1] - now[0]) / 1000 : 0;

    return {
      measuredSeconds,
      frameWorkMs: summarize(work),
      frameIntervalMs: now.length >= 2 ? summarize(deltas(now)) : EMPTY_SUMMARY,
      effectiveFps: ratePerSecond(now),
      frames: this.frameAccounting(mediaTime, presented),
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
