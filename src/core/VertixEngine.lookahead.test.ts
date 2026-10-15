import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VertixEngine, getActiveWasmBuild, switchWasmBuild } from "./VertixEngine";
import type { SceneCutScores } from "./layoutEngine";
import type { BenchmarkProbe } from "./bench/BenchmarkRecorder";
import type { ScoredFrame } from "./lookahead/cutTrigger";
import type { DetectionLatencyTracker } from "./lookahead/detectionLatency";
import { slotsForDelay } from "./lookahead/lookaheadSizing";

const audio = vi.hoisted(() => ({
  setOutputDelay: vi.fn(),
  rampOutputDelay: vi.fn(),
}));

vi.mock("./wasm/simd/wasm.js", () => ({ default: () => new Promise(() => {}), ReframeEngine: class {} }));
vi.mock("./wasm/scalar/wasm.js", () => ({ default: () => new Promise(() => {}), ReframeEngine: class {} }));

vi.mock("./audioActivity", () => ({
  AudioActivityMonitor: class {
    available = true;
    silentPathSuspected = false;
    outputDelaySec = 0;
    attach() {}
    detach() {}
    energy() {
      return null;
    }
    checkSilentPath() {
      return false;
    }
    setOutputDelay(seconds: number) {
      this.outputDelaySec = seconds;
      audio.setOutputDelay(seconds);
    }
    rampOutputDelay(seconds: number, durationSec: number) {
      this.outputDelaySec = seconds;
      audio.rampOutputDelay(seconds, durationSec);
    }
    muteFor() {}
    resetSilentPath() {}
  },
}));

/** Every drawImage / clearRect on any canvas: onto what, from what, at which alpha. */
interface DrawEntry {
  target: object;
  source?: object;
  alpha?: number;
  clear?: boolean;
}
const drawLog: DrawEntry[] = [];

const fake2dContext = (target: object) => ({
  drawImage(source: object) {
    drawLog.push({ target, source, alpha: this.globalAlpha });
  },
  clearRect() {
    drawLog.push({ target, clear: true });
  },
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  filter: "none",
  globalAlpha: 1,
  imageSmoothingQuality: "low",
});

vi.stubGlobal(
  "OffscreenCanvas",
  class {
    private ctx: ReturnType<typeof fake2dContext> | null = null;
    constructor(
      public width: number,
      public height: number
    ) {}
    getContext() {
      return (this.ctx ??= fake2dContext(this));
    }
    transferToImageBitmap() {
      return { close() {} };
    }
  }
);
interface WorkerMessage {
  type: string;
  generation?: number;
  frameId?: number;
  source?: unknown;
}
const workerMessages: WorkerMessage[] = [];
const workers: { onmessage: ((e: { data: unknown }) => void) | null }[] = [];
vi.stubGlobal(
  "Worker",
  class {
    onmessage = null;
    onerror = null;
    constructor() {
      workers.push(this);
    }
    postMessage(message: WorkerMessage) {
      workerMessages.push(message);
    }
    terminate() {}
  }
);

vi.stubGlobal("createImageBitmap", () => new Promise(() => {}));

// Manual requestAnimationFrame: runRefresh() runs what is pending, like one screen refresh.
const pendingRefresh = new Map<number, FrameRequestCallback>();
let nextRefreshId = 1;
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  const id = nextRefreshId++;
  pendingRefresh.set(id, callback);
  return id;
});
vi.stubGlobal("cancelAnimationFrame", (id: number) => pendingRefresh.delete(id));

type FrameCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void;

/**
 * A video with its own clock (also performance.now()): each presented frame
 * advances media time by 1/fps and the clock by that over playbackRate.
 */
class FakeVideo {
  paused = false;
  ended = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  videoWidth = 1280;
  videoHeight = 720;
  fps = 25;
  mediaTime = 0;
  clockMs = 0;
  presented = 0;
  droppedVideoFrames = 0;
  /** Share of frames the video element reports as dropped (getVideoPlaybackQuality). */
  dropShare = 0;
  private nextId = 1;
  private readonly pending = new Map<number, FrameCallback>();
  private readonly listeners = new Map<string, Set<() => void>>();

  requestVideoFrameCallback(callback: FrameCallback): number {
    const id = this.nextId++;
    this.pending.set(id, callback);
    return id;
  }

  cancelVideoFrameCallback(id: number): void {
    this.pending.delete(id);
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  get currentTime(): number {
    return this.mediaTime;
  }

  /** Like Chrome's VideoPlaybackQuality: the fields are getters on the prototype. */
  getVideoPlaybackQuality() {
    const dropped = this.droppedVideoFrames;
    const total = this.presented;
    return new (class {
      get droppedVideoFrames() {
        return dropped;
      }
      get totalVideoFrames() {
        return total;
      }
    })();
  }

  /** Advances one frame without running any frame callback (a dropped frame / skipped callback). */
  skipFrame(): void {
    this.droppedVideoFrames += this.dropShare;
    this.mediaTime = Math.round((this.mediaTime + 1 / this.fps) * 1e6) / 1e6;
    this.clockMs += 1000 / this.fps / this.playbackRate;
    this.presented += 1;
  }

  /** The element drops a frame itself: media time moves on, presentedFrames does not, no callback. */
  dropFrame(): void {
    this.mediaTime = Math.round((this.mediaTime + 1 / this.fps) * 1e6) / 1e6;
    this.clockMs += 1000 / this.fps / this.playbackRate;
  }

  /** Leaves presentedFrames out of the callback metadata. */
  omitPresentedFrames = false;

  presentFrame(): void {
    this.skipFrame();
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    const metadata = {
      width: 1280,
      height: 720,
      mediaTime: this.mediaTime,
      presentedFrames: this.omitPresentedFrames ? undefined : this.presented,
      expectedDisplayTime: this.clockMs,
    } as VideoFrameCallbackMetadata;
    for (const callback of callbacks) callback(this.clockMs, metadata);
  }
}

interface EngineInternals {
  scoredFrames: ScoredFrame[];
  detectionLatency: DetectionLatencyTracker;
  adoptMeasuredLength(build: string): void;
  rampLookaheadLength(delay: { frames: number; lengthMs: number }): void;
  decisions: { push(decision: object): void };
  frameBuffer: { maxSlots: number; allocatedSlots: number } | null;
  processDetectionResult(
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
    previousDetectionSec?: number | null,
    triggeredByCut?: boolean
  ): void;
}

/** A probe that only keeps the cuts shown. */
function cutProbe() {
  const cuts: { cutMediaTimeSec: number; shownMediaTimeSec: number; source: string }[] = [];
  const noop = () => {};
  const probe: BenchmarkProbe = {
    recordFrame: noop,
    recordDetection: noop,
    recordSkippedDetection: noop,
    recordLayoutChange: noop,
    recordTriggerCost: noop,
    recordDisplay: noop,
    recordCutShown: (_now, cutMediaTimeSec, shownMediaTimeSec, source) =>
      cuts.push({ cutMediaTimeSec, shownMediaTimeSec, source }),
  };
  return { probe, cuts };
}

const LEFT_FACE = new Float64Array([0.3, 0.5, 0.2, 0.2, 0, 0.9, 0]);
const CUT: SceneCutScores = { hist: 0.5, grid: 0.5, isCut: true };
const NO_CUT: SceneCutScores = { hist: 0, grid: 0, isCut: false };

function fakeCanvas(): HTMLCanvasElement & { width: number } {
  const canvas = { width: 0, height: 0, clientHeight: 0 } as { getContext?: () => object };
  const ctx = fake2dContext(canvas);
  canvas.getContext = () => ctx;
  return canvas as unknown as HTMLCanvasElement;
}

/**
 * What the output canvas was drawn from since log index `from`: the single
 * frame source (the video, or a buffered copy), following canvases redrawn
 * within the same span back to what they were drawn from (the live-frame
 * copy, the blurred background). Also whether anything was blended in.
 */
function outputSince(canvas: object, from: number) {
  const entries = drawLog.slice(from);
  const onOutput = entries.filter((e) => e.target === canvas && e.source);
  const redrawnFrom = new Map(entries.filter((e) => e.target !== canvas && e.source).map((e) => [e.target, e.source]));
  const origin = (source: object): object => {
    const from = redrawnFrom.get(source);
    return from === undefined || from === source ? source : origin(from);
  };
  const frameSources = new Set(onOutput.map((e) => origin(e.source!)));
  return {
    frameSources,
    blended: onOutput.some((e) => (e.alpha ?? 1) < 1),
    cleared: entries.some((e) => e.target === canvas && e.clear),
  };
}

function setUp({ lookahead = true } = {}) {
  const engine = new VertixEngine();
  const video = new FakeVideo();
  vi.spyOn(performance, "now").mockImplementation(() => video.clockMs);
  const canvas = fakeCanvas();
  engine.attach(video as unknown as HTMLVideoElement, canvas);
  engine.setLookaheadEnabled(lookahead);
  const internals = engine as unknown as EngineInternals;
  const result = (sceneCut: SceneCutScores) => (mediaTimeSec: number) =>
    internals.processDetectionResult(LEFT_FACE, sceneCut, null, mediaTimeSec, 1280, 720, 405, 720, "worker", 1);
  /** Presents `count` frames, returning the media time on screen after each. */
  const play = (count: number) => {
    const shown: (number | null)[] = [];
    for (let i = 0; i < count; i++) {
      video.presentFrame();
      shown.push(engine.getDisplayedMediaTime());
    }
    return shown;
  };
  const runRefresh = () => {
    const callbacks = [...pendingRefresh.values()];
    pendingRefresh.clear();
    for (const callback of callbacks) callback(video.clockMs);
  };
  return { engine, video, canvas, internals, detectCut: result(CUT), detect: result(NO_CUT), play, runRefresh };
}

/** Rounds to microseconds: media times built by repeated addition. */
const us = (sec: number | null) => (sec === null ? null : Math.round(sec * 1e6) / 1e6);

describe("VertixEngine lookahead", () => {
  beforeEach(() => {
    audio.setOutputDelay.mockClear();
    audio.rampOutputDelay.mockClear();
    pendingRefresh.clear();
  });
  afterEach(() => {
    pendingRefresh.clear();
    vi.restoreAllMocks();
  });

  describe("default", () => {
    const useBuild = (variant: "simd" | "scalar") => void switchWasmBuild({ variant, reason: "benchmark-suite" });
    afterEach(() => useBuild("simd"));

    it("is on with the SIMD build and off with scalar, following build switches", () => {
      useBuild("simd");
      const engine = new VertixEngine();
      engine.attach(new FakeVideo() as unknown as HTMLVideoElement, fakeCanvas());
      expect(engine.getLookaheadStatus()).toMatchObject({ enabled: true, enabledByDefault: true, setByHost: false });
      expect(engine.getLookaheadStatus().lengthMs).toBeGreaterThan(0);
      useBuild("scalar");
      expect(engine.getLookaheadStatus()).toMatchObject({ enabled: false, enabledByDefault: false, lengthMs: 0 });
      useBuild("simd");
      expect(engine.getLookaheadStatus().enabled).toBe(true);
      engine.destroy();
    });

    it("a host setting wins over the build default, and null goes back to it", () => {
      useBuild("scalar");
      const engine = new VertixEngine();
      engine.attach(new FakeVideo() as unknown as HTMLVideoElement, fakeCanvas());
      engine.setLookaheadEnabled(true);
      expect(engine.getLookaheadStatus()).toMatchObject({ enabled: true, setByHost: true });
      expect(engine.getLookaheadPreference()).toBe(true);
      useBuild("simd");
      engine.setLookaheadEnabled(false);
      expect(engine.getLookaheadStatus()).toMatchObject({ enabled: false, enabledByDefault: true, lengthMs: 0 });
      engine.setLookaheadEnabled(null);
      expect(engine.getLookaheadStatus()).toMatchObject({ enabled: true, setByHost: false });
      expect(engine.getLookaheadPreference()).toBeNull();
      engine.destroy();
    });
  });

  it("when switched on, delays video and audio by a whole number of frames", () => {
    const { engine } = setUp();
    const { enabled, lengthMs, delayFrames, unavailableReason } = engine.getLookaheadStatus();
    expect({ enabled, unavailableReason }).toEqual({ enabled: true, unavailableReason: null });
    expect(lengthMs).toBe(delayFrames * 40);
    expect(lengthMs).toBeGreaterThanOrEqual(120);
    expect(audio.setOutputDelay).toHaveBeenLastCalledWith(lengthMs / 1000);
    engine.destroy();
  });

  it("shows each frame exactly delayFrames frames after it was decoded, from the frame callback", () => {
    const { engine, video, play } = setUp();
    const { delayFrames } = engine.getLookaheadStatus();
    const shown = play(delayFrames + 10);
    expect(shown.slice(0, delayFrames).every((t) => t === null)).toBe(true);
    expect(us(shown[delayFrames])).toBe(us(1 / 25));
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - delayFrames / 25));
    expect(pendingRefresh.size).toBe(0);
    engine.destroy();
  });

  it("stays in sync by media time when a frame callback is skipped", () => {
    const { engine, video, play } = setUp();
    const { delayFrames } = engine.getLookaheadStatus();
    play(delayFrames + 5);
    video.skipFrame();
    play(1);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - delayFrames / 25));
    play(3);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - delayFrames / 25));
    engine.destroy();
  });

  it("when the due frame was never captured and the screen would fall behind, shows the next frame, never going back", () => {
    const { engine, video, play } = setUp();
    const { delayFrames } = engine.getLookaheadStatus();
    play(delayFrames + 5);
    // Frame X's callback is skipped, and so is the one that would have shown the frame before X.
    video.skipFrame();
    const missingSec = video.mediaTime;
    play(delayFrames - 2);
    video.skipFrame();
    play(1);
    expect(us(video.mediaTime - delayFrames / 25)).toBe(us(missingSec));
    // Not the frame before X (a frame late): the one after it (a frame early).
    expect(us(engine.getDisplayedMediaTime())).toBe(us(missingSec + 1 / 25));
    play(1);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(missingSec + 1 / 25));
    play(1);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - delayFrames / 25));
    engine.destroy();
  });

  it("when the element dropped the due frame itself, holds the previous frame, as the element does", () => {
    const { engine, video, play } = setUp();
    const { delayFrames } = engine.getLookaheadStatus();
    play(delayFrames + 5);
    const beforeMissingSec = video.mediaTime;
    video.dropFrame();
    play(delayFrames - 2);
    video.skipFrame();
    play(1);
    // The missing frame is due: no frame from after it yet.
    expect(us(engine.getDisplayedMediaTime())).toBe(us(beforeMissingSec));
    play(1);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - delayFrames / 25));
    engine.destroy();
  });

  it("without presentedFrames in the frame metadata, holds the previous frame", () => {
    const { engine, video, play } = setUp();
    video.omitPresentedFrames = true;
    const { delayFrames } = engine.getLookaheadStatus();
    play(delayFrames + 5);
    video.skipFrame();
    const missingSec = video.mediaTime;
    play(delayFrames - 2);
    video.skipFrame();
    play(1);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(missingSec - 1 / 25));
    engine.destroy();
  });

  it("follows a frame-rate change with a ramp: no flush, never backwards, then whole frames of the new rate", () => {
    const { engine, video, play } = setUp();
    play(30);
    const before = engine.getLookaheadStatus();
    video.fps = 50;
    const shown = play(400).filter((t): t is number => t !== null);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]);
    const after = engine.getLookaheadStatus();
    expect(after.lengthMs).toBe(after.delayFrames * 20);
    // Rounded up to whole 25 fps frames before, whole 50 fps frames now: at most one old frame apart.
    expect(Math.abs(after.lengthMs - before.lengthMs)).toBeLessThanOrEqual(40);
    expect(audio.setOutputDelay).toHaveBeenCalledTimes(1);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - after.delayFrames / 50));
    engine.destroy();
  });

  it("moves to a measured length without a flush, a gap or a stale frame, and resizes the pool", () => {
    const { engine, video, internals, play } = setUp();
    play(40);
    const before = engine.getLookaheadStatus();
    expect(before.lengthSource).toBe("default");
    const build = getActiveWasmBuild().variant;
    for (let i = 0; i < 12; i++) internals.detectionLatency.record(build, 250, 3000 + i * 200, 20 + i);
    internals.adoptMeasuredLength(build);
    const after = engine.getLookaheadStatus();
    expect(after).toMatchObject({ lengthSource: "measured", detectionP95Ms: 250 });
    expect(after.lengthMs).toBeGreaterThan(before.lengthMs);
    expect(audio.rampOutputDelay.mock.lastCall![0]).toBeCloseTo(after.lengthMs / 1000, 6);
    expect(audio.setOutputDelay).toHaveBeenCalledTimes(1);
    expect(internals.frameBuffer!.maxSlots).toBe(slotsForDelay(after.delayFrames));

    const shown = play(200).filter((t): t is number => t !== null);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]);
    // While the delay grows, a frame is held now and then, never for long.
    let longestHold = 0;
    for (let i = 1, run = 0; i < shown.length; i++) {
      run = shown[i] === shown[i - 1] ? run + 1 : 0;
      longestHold = Math.max(longestHold, run);
    }
    expect(longestHold).toBeLessThanOrEqual(1);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - after.delayFrames / 25));
    expect(engine.getLookaheadStatus().droppedFrames).toBe(0);
    engine.destroy();
  });

  it("at 50 fps from the first frame, sizes the pool for 50 fps and never overflows", () => {
    const { engine, video, internals, play } = setUp();
    video.fps = 50;
    play(200);
    const status = engine.getLookaheadStatus();
    expect(status.lengthMs).toBe(status.delayFrames * 20);
    expect(internals.frameBuffer!.maxSlots).toBe(slotsForDelay(status.delayFrames));
    expect(status.overflowDrops).toBe(0);
    engine.destroy();
  });

  it("at 50 fps with most frame callbacks skipped, still measures 50 fps and never overflows", () => {
    const { engine, video, play } = setUp();
    video.fps = 50;
    for (let i = 0; i < 150; i++) {
      for (let skip = i % 3; skip > 0; skip--) video.skipFrame();
      play(1);
    }
    const status = engine.getLookaheadStatus();
    expect(status.lengthMs).toBe(status.delayFrames * 20);
    expect(status.overflowDrops).toBe(0);
    expect(us(engine.getDisplayedMediaTime())).toBeGreaterThanOrEqual(
      us(video.mediaTime - status.delayFrames / 50 - 0.02)!
    );
    engine.destroy();
  });

  it("uses the host's frame-rate hint from the first frame", () => {
    const { engine, video, internals, play } = setUp({ lookahead: false });
    engine.setFrameRateHint(50);
    engine.setLookaheadEnabled(true);
    const { lengthMs, delayFrames } = engine.getLookaheadStatus();
    expect(lengthMs).toBe(delayFrames * 20);
    video.fps = 50;
    play(1);
    expect(internals.frameBuffer!.maxSlots).toBe(slotsForDelay(delayFrames));
    play(100);
    expect(engine.getLookaheadStatus()).toMatchObject({ lengthMs, delayFrames, overflowDrops: 0 });
    engine.destroy();
  });

  it("before the frame rate is known, lets the pool hold the delay at 60 fps", () => {
    const { engine, internals, play } = setUp();
    play(1);
    const { lengthMs } = engine.getLookaheadStatus();
    expect(internals.frameBuffer!.maxSlots).toBe(slotsForDelay(Math.ceil(lengthMs / (1000 / 60))));
    engine.destroy();
  });

  it("grows the pool when the same length becomes more frames", () => {
    const { engine, internals, play } = setUp();
    play(20);
    const { lengthMs, delayFrames } = engine.getLookaheadStatus();
    internals.rampLookaheadLength({ frames: delayFrames * 2, lengthMs });
    expect(internals.frameBuffer!.maxSlots).toBe(slotsForDelay(delayFrames * 2));
    expect(audio.rampOutputDelay).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("at 50 fps, reduces the copies to 540 lines while the video element drops frames, and logs it", () => {
    const { engine, video, play } = setUp();
    video.fps = 50;
    play(100);
    expect(engine.getLookaheadStatus().slotHeight).toBe(720);
    const skippedBefore = engine.getLookaheadStatus().skippedOnDisplay;
    video.dropShare = 0.1;
    play(250);
    const status = engine.getLookaheadStatus();
    expect(status.slotHeight).toBe(540);
    expect(status.slotHeightChanges).toEqual([{ mediaTimeSec: expect.any(Number), height: 540, reason: "drops" }]);
    expect(status.timeAtSlotHeightMs[720]).toBeGreaterThan(2000);
    expect(status.timeAtSlotHeightMs[540]).toBeGreaterThan(0);
    // The switch itself loses no frame.
    expect(status.overflowDrops).toBe(0);
    expect(status.skippedOnDisplay).toBe(skippedBefore);
    engine.destroy();
  });

  it("keeps full-size copies at 25 fps even while frames are dropped", () => {
    const { engine, video, play } = setUp();
    video.dropShare = 0.2;
    play(300);
    expect(engine.getLookaheadStatus()).toMatchObject({ slotHeight: 720, slotHeightChanges: [] });
    engine.destroy();
  });

  it("sends every frame to the cut trigger up to 30 fps, every second frame above", () => {
    const { engine, video, play } = setUp();
    const scored = () => workerMessages.filter((m) => m.type === "score").length;
    play(20);
    let before = scored();
    play(40);
    expect(scored() - before).toBe(40);
    video.fps = 50;
    play(20);
    before = scored();
    play(40);
    expect(scored() - before).toBe(20);
    engine.destroy();
  });

  it("ignores cut-trigger scores of frames sent before a source change", () => {
    const { engine, video, internals, play } = setUp();
    const scoreMessages = () => workerMessages.filter((m) => m.type === "score");
    const reply = (message: WorkerMessage, extra: object = {}) =>
      workers.at(-1)!.onmessage!({
        data: {
          type: "score",
          generation: message.generation,
          frameId: message.frameId,
          failed: false,
          hist: 0,
          grid: 0,
          triggered: false,
          ...extra,
        },
      });
    workerMessages.length = 0;
    play(3);
    const old = scoreMessages();
    video.emit("loadedmetadata");
    play(3);
    // Same frame ids as before the change: only the generation tells them apart.
    for (const message of old) reply(message, { hist: 0.9, grid: 0.9 });
    expect(internals.scoredFrames).toEqual([]);
    for (const message of scoreMessages().slice(old.length)) reply(message);
    expect(internals.scoredFrames).toHaveLength(3);
    engine.destroy();
  });

  it("shrinks the pool once a shrinking ramp is over", () => {
    const { engine, internals, play } = setUp();
    const build = getActiveWasmBuild().variant;
    for (let i = 0; i < 12; i++) internals.detectionLatency.record(build, 20, 3000 + i * 200, 20 + i);
    play(20);
    internals.adoptMeasuredLength(build);
    const after = engine.getLookaheadStatus();
    play(200);
    expect(internals.frameBuffer!.maxSlots).toBe(slotsForDelay(after.delayFrames));
    expect(internals.frameBuffer!.allocatedSlots).toBeLessThanOrEqual(slotsForDelay(after.delayFrames));
    engine.destroy();
  });

  it("applies a cut decision on the displayed frame it belongs to, not before", () => {
    const { engine, video, detectCut, play } = setUp();
    play(4);
    const cutFrameSec = video.mediaTime;
    play(3);
    // The result arrives 3 frames after the cut frame was decoded, but before it is shown.
    detectCut(cutFrameSec);
    let countBeforeCut: number | null = null;
    let countWhenCutShown: number | null = null;
    for (let i = 0; i < 20; i++) {
      play(1);
      const shown = us(engine.getDisplayedMediaTime());
      if (shown !== null && shown < us(cutFrameSec)!) countBeforeCut = engine.getState().speakerCount;
      if (shown === us(cutFrameSec)) countWhenCutShown = engine.getState().speakerCount;
    }
    expect(countBeforeCut).toBe(0);
    expect(countWhenCutShown).toBe(1);
    engine.destroy();
  });

  it("moves a cut found on a regular detection back to the frame where it happened", () => {
    const { engine, internals, play } = setUp();
    const { probe, cuts } = cutProbe();
    engine.setBenchmarkProbe(probe);
    play(9);
    // Frame 7 (0.28 s) has the biggest frame-to-frame jump; the regular detection on frame 9 finds the cut.
    internals.scoredFrames = Array.from({ length: 9 }, (_, i) => ({
      mediaTimeSec: us((i + 1) / 25)!,
      score: i + 1 === 7 ? 0.6 : 0.01,
    }));
    internals.processDetectionResult(LEFT_FACE, CUT, null, us(9 / 25)!, 1280, 720, 405, 720, "worker", 1, 0.2, false);
    const countShownAt = new Map<number, number>();
    for (let i = 0; i < 30; i++) {
      play(1);
      const shown = us(engine.getDisplayedMediaTime());
      if (shown !== null) countShownAt.set(shown, engine.getState().speakerCount);
    }
    expect(countShownAt.get(us(6 / 25)!)).toBe(0);
    expect(countShownAt.get(us(7 / 25)!)).toBe(1);
    expect(cuts).toEqual([{ cutMediaTimeSec: us(7 / 25), shownMediaTimeSec: us(7 / 25), source: "localised" }]);
    engine.destroy();
  });

  it("reports a cut from a triggered detection as found by the trigger", () => {
    const { engine, internals, play } = setUp();
    const { probe, cuts } = cutProbe();
    engine.setBenchmarkProbe(probe);
    play(3);
    internals.processDetectionResult(LEFT_FACE, CUT, null, us(3 / 25)!, 1280, 720, 405, 720, "worker", 1, 0, true);
    play(30);
    expect(cuts.map((c) => c.source)).toEqual(["trigger"]);
    engine.destroy();
  });

  it("flushes the buffer on seek and silences the delayed audio", () => {
    const { engine, video, play } = setUp();
    play(3);
    expect(engine.getLookaheadStatus().bufferedFrames).toBe(3);
    audio.setOutputDelay.mockClear();
    video.emit("seeking");
    expect(engine.getLookaheadStatus().bufferedFrames).toBe(0);
    expect(engine.getDisplayedMediaTime()).toBeNull();
    expect(audio.setOutputDelay).toHaveBeenCalledWith(engine.getLookaheadStatus().lengthMs / 1000);
    engine.destroy();
  });

  it("switches off at runtime: no delay, frames drawn as decoded, buffer dropped", () => {
    const { engine, video, play } = setUp();
    play(1);
    engine.setLookaheadEnabled(false);
    expect(audio.setOutputDelay).toHaveBeenLastCalledWith(0);
    expect(engine.getLookaheadStatus()).toMatchObject({ enabled: false, lengthMs: 0, bufferedFrames: 0 });
    play(1);
    expect(engine.getDisplayedMediaTime()).toBe(video.mediaTime);
    engine.destroy();
  });

  it("switches back on at runtime: the delay returns and frames wait again", () => {
    const { engine, video, play } = setUp({ lookahead: false });
    play(1);
    const shownBefore = engine.getDisplayedMediaTime();
    engine.setLookaheadEnabled(true);
    const { lengthMs, delayFrames } = engine.getLookaheadStatus();
    expect(audio.setOutputDelay).toHaveBeenLastCalledWith(lengthMs / 1000);
    play(delayFrames);
    expect(engine.getDisplayedMediaTime()).toBe(shownBefore);
    play(1);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - delayFrames / 25));
    engine.destroy();
  });

  it("drains the buffer after pause, ending on the last decoded frame", () => {
    const { engine, video, play, runRefresh } = setUp();
    play(20);
    video.paused = true;
    video.emit("pause");
    const lastDecoded = video.mediaTime;
    for (let i = 0; i < 60; i++) {
      video.clockMs += 1000 / 60;
      runRefresh();
    }
    expect(engine.getDisplayedMediaTime()).toBe(lastDecoded);
    expect(engine.getLookaheadStatus().bufferedFrames).toBe(0);
    engine.destroy();
  });

  it("after a seek while paused, shows the new frame already cropped", () => {
    const { engine, video, detect, play, runRefresh } = setUp();
    play(2);
    video.paused = true;
    video.emit("seeking");
    video.presentFrame();
    const seekedFrameSec = video.mediaTime;
    expect(engine.getDisplayedMediaTime()).toBeNull();
    detect(seekedFrameSec);
    runRefresh();
    expect(engine.getDisplayedMediaTime()).toBe(seekedFrameSec);
    expect(engine.getState().speakerCount).toBe(1);
    engine.destroy();
  });

  it("keeps the normal debounce for the first detection without a seek", () => {
    const { engine, video, detect, play } = setUp();
    play(1);
    detect(video.mediaTime);
    play(20);
    expect(engine.getState().speakerCount).toBe(0);
    engine.destroy();
  });

  it("is bypassed in 16:9: no delay for video or audio, frames drawn as decoded", () => {
    const { engine, video, play } = setUp();
    play(10);
    engine.setMode("16:9");
    expect(engine.getLookaheadStatus()).toMatchObject({
      enabled: true,
      bypassed: true,
      lengthMs: 0,
      audioDelayMs: 0,
      bufferedFrames: 0,
    });
    expect(audio.setOutputDelay).toHaveBeenLastCalledWith(0);
    // The current frame is drawn at once, live.
    expect(engine.getDisplayedMediaTime()).toBe(video.mediaTime);
    play(1);
    expect(engine.getDisplayedMediaTime()).toBe(video.mediaTime);
    engine.destroy();
  });

  it("back in 9:16, shows the current frame at once as 9:16, re-shows it cropped, and holds it until the stream reaches it", () => {
    const { engine, video, canvas, detect, play } = setUp();
    play(10);
    engine.setMode("16:9");
    play(10);
    engine.setMode("9:16");
    const anchorSec = video.mediaTime;
    const { lengthMs, delayFrames, bypassed, audioDelayMs } = engine.getLookaheadStatus();
    expect({ bypassed, audioDelayMs }).toEqual({ bypassed: false, audioDelayMs: lengthMs });
    expect(engine.getDisplayedMediaTime()).toBe(anchorSec);
    expect(canvas.width).toBe(405);
    expect(engine.getState().speakerCount).toBe(0);

    // Its own detection arrives: the count commits at once and the anchor is shown cropped.
    detect(anchorSec);
    play(1);
    expect(engine.getDisplayedMediaTime()).toBe(anchorSec);
    expect(engine.getState().speakerCount).toBe(1);

    const shown = play(delayFrames + 5);
    expect(shown.slice(0, delayFrames - 1).every((t) => t === anchorSec)).toBe(true);
    for (let i = 1; i < shown.length; i++) expect(shown[i]!).toBeGreaterThanOrEqual(shown[i - 1]!);
    expect(us(engine.getDisplayedMediaTime())).toBe(us(video.mediaTime - delayFrames / 25));
    engine.destroy();
  });

  it("never stores or uses a length from warm-up detections, and uses warm ones once there are enough", () => {
    const storage = new Map<string, string>();
    const withStorage = globalThis as unknown as { localStorage?: unknown };
    withStorage.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };
    const { engine, internals } = setUp();
    const build = getActiveWasmBuild().variant;
    const defaultLength = engine.getLookaheadStatus().lengthMs;
    // A fresh worker: every detection in its first 2 s is slow.
    for (let i = 0; i < 10; i++) internals.detectionLatency.record(build, 900, i * 150, i + 1);
    internals.adoptMeasuredLength(build);
    engine.setLookaheadEnabled(false);
    engine.setLookaheadEnabled(true);
    expect(engine.getLookaheadStatus()).toMatchObject({ lengthSource: "default", lengthMs: defaultLength });
    expect(storage.size).toBe(0);

    for (let i = 0; i < 12; i++) internals.detectionLatency.record(build, 100, 3000 + i * 200, 20 + i);
    engine.setLookaheadEnabled(false);
    engine.setLookaheadEnabled(true);
    expect(engine.getLookaheadStatus()).toMatchObject({ lengthSource: "measured", detectionP95Ms: 100 });
    expect([...storage.values()]).toEqual(["100"]);
    delete withStorage.localStorage;
    engine.destroy();
  });

  describe("without lookahead", () => {
    it("in 9:16, draws the video once per frame, into one copy everything else is drawn from", () => {
      const env = setUp({ lookahead: false });
      // The first frame also has the 1x1 cross-origin probe.
      env.play(1);
      for (let i = 0; i < 30; i++) {
        const from = drawLog.length;
        env.play(1);
        env.detect(env.video.mediaTime);
        const videoDraws = drawLog.slice(from).filter((e) => e.source === env.video);
        expect(videoDraws).toHaveLength(1);
        expect(videoDraws[0].target).not.toBe(env.canvas);
        expect([...outputSince(env.canvas, from).frameSources]).toEqual([env.video]);
      }
      env.engine.destroy();
    });

    it("in 16:9, draws the video once per frame straight onto the output", () => {
      const env = setUp({ lookahead: false });
      env.engine.setMode("16:9");
      env.play(1);
      for (let i = 0; i < 5; i++) {
        const from = drawLog.length;
        env.play(1);
        const videoDraws = drawLog.slice(from).filter((e) => e.source === env.video);
        expect(videoDraws).toEqual([expect.objectContaining({ target: env.canvas })]);
      }
      env.engine.destroy();
    });
  });

  describe("scenes never mix", () => {
    /** Feeds a one-face detection on every frame until the count change starts a dissolve (B-roll -> one speaker). */
    const untilDissolve = (env: ReturnType<typeof setUp>) => {
      for (let i = 0; i < 300 && !env.engine.getState().isTransitioning; i++) {
        env.play(1);
        env.detect(env.video.mediaTime);
      }
      expect(env.engine.getState().isTransitioning).toBe(true);
    };

    it("without lookahead, a dissolve blends two crops of the frame being drawn, never an earlier frame", () => {
      const env = setUp({ lookahead: false });
      untilDissolve(env);
      let blendedFrames = 0;
      while (env.engine.getState().isTransitioning) {
        const from = drawLog.length;
        env.play(1);
        const drawn = outputSince(env.canvas, from);
        expect([...drawn.frameSources]).toEqual([env.video]);
        if (drawn.blended) blendedFrames += 1;
      }
      expect(blendedFrames).toBeGreaterThan(2);
      env.engine.destroy();
    });

    it("with lookahead, a speaker-switch dissolve blends two crops of the displayed frame only", () => {
      const env = setUp();
      const { delayFrames } = env.engine.getLookaheadStatus();
      env.play(3);
      env.detectCut(env.video.mediaTime);
      env.play(delayFrames + 2);
      expect(env.engine.getState().speakerCount).toBe(1);
      const switchSec = us(env.video.mediaTime)!;
      env.internals.decisions.push({
        mediaTimeSec: switchSec,
        speakerCount: 1,
        targetPanes: [{ pane: { source: { x: 800, y: 0, w: 405, h: 720 }, dest: { x: 0, y: 0, w: 405, h: 720 } } }],
        reframe: "dissolve",
        isCut: false,
        cutSource: null,
        skinRejectedFaces: [],
      });
      let blendedFrames = 0;
      for (let i = 0; i < delayFrames + 12; i++) {
        const from = drawLog.length;
        env.play(1);
        const drawn = outputSince(env.canvas, from);
        if (drawn.frameSources.size === 0) continue;
        expect(drawn.frameSources.size).toBe(1);
        expect(drawn.frameSources.has(env.canvas)).toBe(false);
        if (drawn.blended) blendedFrames += 1;
      }
      expect(blendedFrames).toBeGreaterThan(2);
      env.engine.destroy();
    });

    it("a cut during a dissolve snaps: no blend from the frame it is applied on", () => {
      const env = setUp({ lookahead: false });
      untilDissolve(env);
      env.play(1);
      env.detectCut(env.video.mediaTime);
      const from = drawLog.length;
      env.play(1);
      expect(env.engine.getState().isTransitioning).toBe(false);
      expect(outputSince(env.canvas, from).blended).toBe(false);
      env.engine.destroy();
    });

    it("a cut decided late is still a snap", () => {
      const env = setUp({ lookahead: false });
      env.play(5);
      const cutSec = env.video.mediaTime;
      env.play(5);
      env.detectCut(cutSec);
      const from = drawLog.length;
      env.play(1);
      expect(env.engine.getState()).toMatchObject({ speakerCount: 1, isTransitioning: false });
      expect(outputSince(env.canvas, from).blended).toBe(false);
      env.engine.destroy();
    });

    it("on a source change, clears the canvas and shows nothing from the previous clip", () => {
      const env = setUp();
      const { delayFrames } = env.engine.getLookaheadStatus();
      env.play(3);
      env.detectCut(env.video.mediaTime);
      env.play(delayFrames + 5);
      expect(env.engine.getState().speakerCount).toBe(1);
      const from = drawLog.length;
      env.video.emit("loadedmetadata");
      const changedAtSec = env.video.mediaTime;
      expect(outputSince(env.canvas, from).cleared).toBe(true);
      expect(env.engine.getDisplayedMediaTime()).toBeNull();
      expect(env.engine.getLookaheadStatus().bufferedFrames).toBe(0);
      expect(env.engine.getState()).toMatchObject({ speakerCount: 0, isTransitioning: false });
      const shown = env.play(delayFrames + 3).filter((t): t is number => t !== null);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((t) => t > changedAtSec)).toBe(true);
      env.engine.destroy();
    });
  });
});
