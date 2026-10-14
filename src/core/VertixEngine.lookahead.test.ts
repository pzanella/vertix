import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VertixEngine } from "./VertixEngine";
import type { SceneCutScores } from "./layoutEngine";

const audio = vi.hoisted(() => ({
  setOutputDelay: vi.fn(),
  muteFor: vi.fn(),
}));

vi.mock("./wasm/simd/wasm.js", () => ({ default: () => new Promise(() => {}), ReframeEngine: class {} }));
vi.mock("./wasm/scalar/wasm.js", () => ({ default: () => new Promise(() => {}), ReframeEngine: class {} }));

vi.mock("./audioActivity", () => ({
  AudioActivityMonitor: class {
    available = true;
    silentPathSuspected = false;
    attach() {}
    detach() {}
    energy() {
      return null;
    }
    checkSilentPath() {
      return false;
    }
    setOutputDelay(seconds: number) {
      audio.setOutputDelay(seconds);
    }
    muteFor(seconds: number) {
      audio.muteFor(seconds);
    }
    resetSilentPath() {}
  },
}));

const fake2dContext = () => ({
  drawImage() {},
  clearRect() {},
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  filter: "none",
  globalAlpha: 1,
});

vi.stubGlobal(
  "OffscreenCanvas",
  class {
    constructor(
      public width: number,
      public height: number
    ) {}
    getContext() {
      return fake2dContext();
    }
  }
);
vi.stubGlobal(
  "Worker",
  class {
    onmessage = null;
    onerror = null;
    postMessage() {}
    terminate() {}
  }
);
vi.stubGlobal("createImageBitmap", () => new Promise(() => {}));

// Manual requestAnimationFrame: runRefresh(now) runs what is pending, like one screen refresh.
const pendingRefresh = new Map<number, FrameRequestCallback>();
let nextRefreshId = 1;
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  const id = nextRefreshId++;
  pendingRefresh.set(id, callback);
  return id;
});
vi.stubGlobal("cancelAnimationFrame", (id: number) => pendingRefresh.delete(id));
function runRefresh(now: number) {
  const callbacks = [...pendingRefresh.values()];
  pendingRefresh.clear();
  for (const callback of callbacks) callback(now);
}

type FrameCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void;

const FRAME_MS = 40;
const REFRESH_MS = 1000 / 60;

/** A 25 fps video whose frame N is decoded at N × 40 ms and due on screen at the same time. */
class FakeVideo {
  paused = false;
  ended = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  videoWidth = 1280;
  videoHeight = 720;
  frame = 0;
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

  get mediaTime(): number {
    return this.frame / 25;
  }

  presentFrame(): void {
    this.frame += 1;
    const now = this.frame * FRAME_MS;
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    const metadata = {
      width: 1280,
      height: 720,
      mediaTime: this.mediaTime,
      presentedFrames: this.frame,
      expectedDisplayTime: now,
    } as VideoFrameCallbackMetadata;
    for (const callback of callbacks) callback(now, metadata);
  }
}

interface EngineInternals {
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
    inferenceMs: number
  ): void;
}

const LEFT_FACE = new Float64Array([0.3, 0.5, 0.2, 0.2, 0, 0.9, 0]);
const CUT: SceneCutScores = { hist: 0.5, grid: 0.5, isCut: true };
const NO_CUT: SceneCutScores = { hist: 0, grid: 0, isCut: false };

function setUp() {
  const engine = new VertixEngine();
  const video = new FakeVideo();
  const canvas = { width: 0, height: 0, getContext: fake2dContext } as unknown as HTMLCanvasElement;
  engine.attach(video as unknown as HTMLVideoElement, canvas);
  const internals = engine as unknown as EngineInternals;
  /** A cut detection result for the frame at `mediaTimeSec`, with one face. */
  const detectCut = (mediaTimeSec: number) =>
    internals.processDetectionResult(LEFT_FACE, CUT, null, mediaTimeSec, 1280, 720, 405, 720, "worker", 1);
  /** A plain (no cut) detection result for the frame at `mediaTimeSec`, with one face. */
  const detect = (mediaTimeSec: number) =>
    internals.processDetectionResult(LEFT_FACE, NO_CUT, null, mediaTimeSec, 1280, 720, 405, 720, "worker", 1);
  /** Runs screen refreshes up to `untilMs`, returning the media time on screen after each one. */
  const refreshUntil = (fromMs: number, untilMs: number) => {
    const shown: (number | null)[] = [];
    for (let t = fromMs; t <= untilMs; t += REFRESH_MS) {
      runRefresh(t);
      shown.push(engine.getDisplayedMediaTime());
    }
    return shown;
  };
  return { engine, video, detectCut, detect, refreshUntil };
}

describe("VertixEngine lookahead", () => {
  beforeEach(() => {
    audio.setOutputDelay.mockClear();
    audio.muteFor.mockClear();
    pendingRefresh.clear();
  });
  afterEach(() => pendingRefresh.clear());

  it("is on by default and delays the audio by its length", () => {
    const { engine } = setUp();
    const { enabled, lengthMs, unavailableReason } = engine.getLookaheadStatus();
    expect({ enabled, unavailableReason }).toEqual({ enabled: true, unavailableReason: null });
    expect(lengthMs).toBeGreaterThanOrEqual(120);
    expect(audio.setOutputDelay).toHaveBeenLastCalledWith(lengthMs / 1000);
    engine.destroy();
  });

  it("shows a frame only once its display time plus the lookahead has come", () => {
    const { engine, video, refreshUntil } = setUp();
    const lengthMs = engine.getLookaheadStatus().lengthMs;
    video.presentFrame();
    const dueMs = FRAME_MS + lengthMs;
    expect(refreshUntil(FRAME_MS, dueMs - 2 * REFRESH_MS).every((t) => t === null)).toBe(true);
    refreshUntil(dueMs - REFRESH_MS, dueMs);
    expect(engine.getDisplayedMediaTime()).toBe(video.mediaTime);
    engine.destroy();
  });

  it("applies a cut decision on the displayed frame it belongs to, not before", () => {
    const { engine, video, detectCut } = setUp();
    for (let i = 0; i < 4; i++) video.presentFrame();
    const cutFrameSec = video.mediaTime;
    for (let i = 0; i < 3; i++) video.presentFrame();
    // The result arrives late (3 frames after the cut frame was decoded), but before it is shown.
    detectCut(cutFrameSec);

    const lengthMs = engine.getLookaheadStatus().lengthMs;
    let countWhenCutShown: number | null = null;
    let countBeforeCut: number | null = null;
    for (let t = FRAME_MS; t <= video.frame * FRAME_MS + lengthMs + 50; t += REFRESH_MS) {
      runRefresh(t);
      const shown = engine.getDisplayedMediaTime();
      if (shown !== null && shown < cutFrameSec) countBeforeCut = engine.getState().speakerCount;
      if (shown === cutFrameSec) countWhenCutShown = engine.getState().speakerCount;
    }
    expect(countBeforeCut).toBe(0);
    expect(countWhenCutShown).toBe(1);
    engine.destroy();
  });

  it("flushes the buffer on seek and silences the delayed audio", () => {
    const { engine, video } = setUp();
    for (let i = 0; i < 3; i++) video.presentFrame();
    expect(engine.getLookaheadStatus().bufferedFrames).toBe(3);
    video.emit("seeking");
    expect(engine.getLookaheadStatus().bufferedFrames).toBe(0);
    expect(engine.getDisplayedMediaTime()).toBeNull();
    expect(audio.muteFor).toHaveBeenCalledWith(engine.getLookaheadStatus().lengthMs / 1000);
    runRefresh(10_000);
    expect(engine.getDisplayedMediaTime()).toBeNull();
    engine.destroy();
  });

  it("switches off at runtime: no delay, frames drawn as decoded, buffer dropped", () => {
    const { engine, video } = setUp();
    video.presentFrame();
    engine.setLookaheadEnabled(false);
    expect(audio.setOutputDelay).toHaveBeenLastCalledWith(0);
    expect(engine.getLookaheadStatus()).toMatchObject({ enabled: false, lengthMs: 0, bufferedFrames: 0 });
    video.presentFrame();
    expect(engine.getDisplayedMediaTime()).toBe(video.mediaTime);
    engine.destroy();
  });

  it("switches back on at runtime: the delay returns and frames wait again", () => {
    const { engine, video } = setUp();
    engine.setLookaheadEnabled(false);
    video.presentFrame();
    engine.setLookaheadEnabled(true);
    const { lengthMs } = engine.getLookaheadStatus();
    expect(audio.setOutputDelay).toHaveBeenLastCalledWith(lengthMs / 1000);
    const shownBefore = engine.getDisplayedMediaTime();
    video.presentFrame();
    runRefresh(video.frame * FRAME_MS);
    expect(engine.getDisplayedMediaTime()).toBe(shownBefore);
    runRefresh(video.frame * FRAME_MS + lengthMs);
    expect(engine.getDisplayedMediaTime()).toBe(video.mediaTime);
    engine.destroy();
  });

  it("after a seek while paused, shows the new frame already cropped", () => {
    const { engine, video, detect } = setUp();
    video.presentFrame();
    video.presentFrame();
    video.paused = true;
    video.emit("seeking");
    video.presentFrame();
    const seekedFrameSec = video.mediaTime;
    expect(engine.getDisplayedMediaTime()).toBeNull();
    detect(seekedFrameSec);
    runRefresh(performance.now() + 1000);
    expect(engine.getDisplayedMediaTime()).toBe(seekedFrameSec);
    expect(engine.getState().speakerCount).toBe(1);
    engine.destroy();
  });

  it("keeps the normal debounce for the first detection without a seek", () => {
    const { engine, video, detect } = setUp();
    video.presentFrame();
    detect(video.mediaTime);
    runRefresh(10_000);
    expect(engine.getDisplayedMediaTime()).toBe(video.mediaTime);
    expect(engine.getState().speakerCount).toBe(0);
    engine.destroy();
  });

  it("drains the buffer after pause, ending on the last decoded frame", () => {
    const { engine, video } = setUp();
    for (let i = 0; i < 5; i++) video.presentFrame();
    video.paused = true;
    const lastDecoded = video.mediaTime;
    runRefresh(video.frame * FRAME_MS + engine.getLookaheadStatus().lengthMs);
    expect(engine.getDisplayedMediaTime()).toBe(lastDecoded);
    expect(engine.getLookaheadStatus().bufferedFrames).toBe(0);
    engine.destroy();
  });
});
