import { afterEach, describe, expect, it, vi } from "vitest";
import { VertixEngine } from "./VertixEngine";
import type { SceneCutScores } from "./layoutEngine";
import type { DetectionTick, OverlayFrame } from "./hostHooks";
import { MAX_LOOKAHEAD_MS } from "./lookahead/lookaheadSizing";

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
    setOutputDelay() {}
    rampOutputDelay() {}
    muteFor() {}
    resetSilentPath() {}
  },
}));

const fake2dContext = () => ({
  drawImage() {},
  clearRect() {},
  fillRect() {},
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
      return (this.ctx ??= fake2dContext());
    }
    transferToImageBitmap() {
      return { close() {} };
    }
  }
);

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror = null;
  readonly messages: { type: string; build?: string }[] = [];
  constructor(readonly url: string) {
    FakeWorker.all.push(this);
  }
  postMessage(message: { type: string; build?: string }) {
    this.messages.push(message);
  }
  terminate() {}
}
vi.stubGlobal("Worker", FakeWorker);
vi.stubGlobal("createImageBitmap", () => Promise.resolve({ close() {} }));
vi.stubGlobal("requestAnimationFrame", () => 0);
vi.stubGlobal("cancelAnimationFrame", () => {});

type FrameCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void;

class FakeVideo {
  paused = false;
  ended = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  videoWidth = 1280;
  videoHeight = 720;
  mediaTime = 0;
  clockMs = 0;
  presented = 0;
  private nextId = 1;
  private readonly pending = new Map<number, FrameCallback>();
  requestVideoFrameCallback(callback: FrameCallback): number {
    const id = this.nextId++;
    this.pending.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id: number): void {
    this.pending.delete(id);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  get currentTime(): number {
    return this.mediaTime;
  }
  getVideoPlaybackQuality() {
    return { droppedVideoFrames: 0, totalVideoFrames: this.presented };
  }
  presentFrame(): void {
    this.mediaTime = Math.round((this.mediaTime + 0.04) * 1e6) / 1e6;
    this.clockMs += 40;
    this.presented += 1;
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    const metadata = {
      width: 1280,
      height: 720,
      mediaTime: this.mediaTime,
      presentedFrames: this.presented,
      expectedDisplayTime: this.clockMs,
    } as VideoFrameCallbackMetadata;
    for (const callback of callbacks) callback(this.clockMs, metadata);
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

const LEFT_FACE = new Float64Array([0.3, 0.5, 0.2, 0.2, 0, 0.9, 0, 0]);
const NO_CUT: SceneCutScores = { hist: 0, grid: 0, isCut: false };
const CUT: SceneCutScores = { hist: 0.5, grid: 0.5, isCut: true };

function fakeCanvas(): HTMLCanvasElement {
  const ctx = fake2dContext();
  return { width: 0, height: 0, clientHeight: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function readyDetectionWorker(): void {
  for (const worker of FakeWorker.all) {
    const init = worker.messages.find((m) => m.type === "init" && m.build);
    if (worker.url.includes("faceDetectionWorker") && init) {
      worker.onmessage?.({ data: { type: "ready", build: init.build } });
    }
  }
}

function setUp({ lookahead = true } = {}) {
  const engine = new VertixEngine();
  const video = new FakeVideo();
  vi.spyOn(performance, "now").mockImplementation(() => video.clockMs);
  const canvas = fakeCanvas();
  engine.attach(video as unknown as HTMLVideoElement, canvas);
  engine.setLookaheadEnabled(lookahead);
  const internals = engine as unknown as EngineInternals;
  const detect = (mediaTimeSec: number, sceneCut = NO_CUT) =>
    internals.processDetectionResult(LEFT_FACE, sceneCut, null, mediaTimeSec, 1280, 720, 405, 720, "worker", 1);
  const play = (count: number) => {
    for (let i = 0; i < count; i++) video.presentFrame();
  };
  return { engine, video, detect, play };
}

describe("VertixEngine host hooks", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("minimum lookahead length", () => {
    it("raises the length to whole frames at or above the minimum, and null restores exactly the engine's own", () => {
      const { engine, play } = setUp();
      play(10);
      const own = engine.getLookaheadStatus().lengthMs;
      engine.setMinimumLookaheadMs(300);
      play(30);
      expect(engine.getLookaheadLengths()).toEqual({ lengthMs: 320, baseLengthMs: own, minimumMs: 300 });
      expect(engine.getLookaheadStatus()).toMatchObject({ lengthMs: 320, delayFrames: 8 });
      engine.setMinimumLookaheadMs(null);
      play(30);
      expect(engine.getLookaheadStatus().lengthMs).toBe(own);
      expect(engine.getLookaheadLengths()).toEqual({ lengthMs: own, baseLengthMs: own, minimumMs: null });
      engine.destroy();
    });

    it("never goes above MAX_LOOKAHEAD_MS, and a minimum below the engine's length changes nothing", () => {
      const { engine, play } = setUp();
      play(10);
      const own = engine.getLookaheadStatus().lengthMs;
      engine.setMinimumLookaheadMs(5000);
      expect(engine.getLookaheadStatus().lengthMs).toBe(MAX_LOOKAHEAD_MS);
      engine.setMinimumLookaheadMs(own - 40);
      expect(engine.getLookaheadStatus().lengthMs).toBe(own);
      engine.destroy();
    });

    it("does nothing while lookahead is off", () => {
      const { engine, play } = setUp({ lookahead: false });
      engine.setMinimumLookaheadMs(300);
      play(10);
      expect(engine.getLookaheadLengths()).toEqual({ lengthMs: 0, baseLengthMs: 0, minimumMs: 300 });
      engine.destroy();
    });
  });

  describe("detection observers", () => {
    it("get the frame sent to detection, then the tick for the same media time with the tracks of that detection", () => {
      const { engine, play, detect } = setUp({ lookahead: false });
      readyDetectionWorker();
      const frames: number[] = [];
      const ticks: DetectionTick[] = [];
      const stop = engine.observeDetections({
        onFrame: (_source, mediaTimeSec) => frames.push(mediaTimeSec),
        onTick: (tick) => ticks.push(tick),
      });
      play(5);
      expect(frames).toHaveLength(1);
      detect(frames[0]);
      expect(ticks).toHaveLength(1);
      expect(ticks[0]).toMatchObject({ mediaTimeSec: frames[0], srcW: 1280, srcH: 720, cutAtSec: null });
      expect(ticks[0].tracks).toEqual([
        expect.objectContaining({ cx: 0.3, cy: 0.5, w: 0.2, h: 0.2, foreground: true }),
      ]);
      detect(frames[0] + 0.2, CUT);
      expect(ticks[1].cutAtSec).toBe(frames[0] + 0.2);
      stop();
      detect(frames[0] + 0.4);
      expect(ticks).toHaveLength(2);
      engine.destroy();
    });

    it("in 16:9, get nothing unless source-view detection is on; then ticks come without layout or lookahead", () => {
      const { engine, play, detect } = setUp();
      readyDetectionWorker();
      engine.setMode("16:9");
      const frames: number[] = [];
      const ticks: DetectionTick[] = [];
      engine.observeDetections({ onFrame: (_s, t) => frames.push(t), onTick: (tick) => ticks.push(tick) });
      play(20);
      expect(frames).toHaveLength(0);

      engine.setSourceViewDetection(true);
      play(5);
      expect(frames).toHaveLength(1);
      detect(frames[0]);
      expect(ticks).toHaveLength(1);
      expect(ticks[0].tracks).toHaveLength(1);
      expect(engine.getState().speakerCount).toBe(0);
      expect(engine.getLookaheadStatus()).toMatchObject({ bypassed: true, lengthMs: 0 });
      engine.destroy();
    });
  });

  describe("overlay renderer", () => {
    it("is called after every output frame with that frame's media time, the overlay sized like the output", () => {
      const { engine, video, play } = setUp({ lookahead: false });
      const frames: OverlayFrame[] = [];
      const overlay = fakeCanvas();
      engine.setOverlayRenderer(overlay, (frame) => frames.push({ ...frame }));
      play(3);
      expect(frames).toHaveLength(3);
      expect(frames[2]).toMatchObject({
        mediaTimeSec: video.mediaTime,
        width: 405,
        height: 720,
        srcW: 1280,
        srcH: 720,
      });
      expect(frames[2].views).toHaveLength(1);
      expect(overlay.width).toBe(405);
      engine.setMode("16:9");
      play(1);
      expect(frames.at(-1)).toMatchObject({ width: 1280, height: 720 });
      expect(frames.at(-1)!.views).toEqual([
        { source: { x: 0, y: 0, w: 1280, h: 720 }, dest: { x: 0, y: 0, w: 1280, h: 720 } },
      ]);
      const count = frames.length;
      engine.setOverlayRenderer(null, null);
      play(2);
      expect(frames).toHaveLength(count);
      engine.destroy();
    });
  });
});
