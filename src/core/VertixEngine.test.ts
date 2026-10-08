import { describe, expect, it, vi } from "vitest";
import { VertixEngine } from "./VertixEngine";

vi.mock("./wasm/wasm.js", () => ({
  default: () => new Promise(() => {}),
  ReframeEngine: class {},
}));

vi.mock("./audioActivity", () => ({
  AudioActivityMonitor: class {
    available = false;
    attach() {}
    detach() {}
    energy() {
      return null;
    }
  },
}));

const fake2dContext = () => ({ drawImage() {}, clearRect() {}, filter: "none", globalAlpha: 1 });

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

type FrameCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void;

/** Just enough of HTMLVideoElement for the render loop: frame callbacks and play events. */
class FakeVideo {
  paused = false;
  ended = false;
  videoWidth = 1280;
  videoHeight = 720;
  private nextId = 1;
  private presentedFrames = 0;
  private readonly pending = new Map<number, FrameCallback>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get pendingFrameCallbacks(): number {
    return this.pending.size;
  }

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

  play(): void {
    this.paused = false;
    this.listeners.get("play")?.forEach((listener) => listener());
  }

  /** Presents one frame: runs (and clears) every pending callback, like the browser does. */
  presentFrame(): void {
    this.presentedFrames += 1;
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    const metadata = {
      width: 1280,
      height: 720,
      mediaTime: this.presentedFrames / 25,
      presentedFrames: this.presentedFrames,
    } as VideoFrameCallbackMetadata;
    for (const callback of callbacks) callback(this.presentedFrames * 40, metadata);
  }
}

function fakeCanvas(): HTMLCanvasElement {
  return { width: 0, height: 0, getContext: fake2dContext } as unknown as HTMLCanvasElement;
}

function setUp() {
  const engine = new VertixEngine();
  const video = new FakeVideo();
  const asElement = video as unknown as HTMLVideoElement;
  return { engine, video, asElement };
}

describe("VertixEngine render loop", () => {
  it("keeps exactly one frame callback pending while playing", () => {
    const { engine, video, asElement } = setUp();
    engine.attach(asElement, fakeCanvas());
    for (let i = 0; i < 10; i++) video.presentFrame();
    expect(video.pendingFrameCallbacks).toBe(1);
    engine.destroy();
  });

  it("does not start a second loop when re-attached to a new canvas while playing", () => {
    const { engine, video, asElement } = setUp();
    engine.attach(asElement, fakeCanvas());
    video.presentFrame();
    engine.attach(asElement, fakeCanvas());
    for (let i = 0; i < 10; i++) video.presentFrame();
    expect(video.pendingFrameCallbacks).toBe(1);
    engine.destroy();
  });

  it("does not start a second loop after a source change (pause, re-attach, play)", () => {
    const { engine, video, asElement } = setUp();
    engine.attach(asElement, fakeCanvas());
    video.presentFrame();
    video.paused = true;
    engine.attach(asElement, fakeCanvas());
    video.play();
    for (let i = 0; i < 10; i++) video.presentFrame();
    expect(video.pendingFrameCallbacks).toBe(1);
    engine.destroy();
  });

  it("leaves no frame callback pending after detach", () => {
    const { engine, video, asElement } = setUp();
    engine.attach(asElement, fakeCanvas());
    video.presentFrame();
    engine.detach();
    expect(video.pendingFrameCallbacks).toBe(0);
    engine.destroy();
  });
});

interface TestFace {
  cx: number;
  cy: number;
  size: number;
  motion?: number;
}

/** Engine internals the speaker-tracking tests drive directly, bypassing the worker. */
interface EngineInternals {
  lastResolvedFaces: { cx: number; cy: number }[];
  processDetectionResult(
    facesFlat: Float64Array,
    audioEnergy: number | null,
    srcW: number,
    srcH: number,
    cropW: number,
    cropH: number,
    detectionMode: "worker" | "main-thread",
    inferenceMs: number
  ): void;
}

function packFaces(faces: TestFace[]): Float64Array {
  return new Float64Array(faces.flatMap((f) => [f.cx, f.cy, f.size, f.size, f.motion ?? 0, 0.9]));
}

function setUpTracking() {
  const { engine, video, asElement } = setUp();
  engine.attach(asElement, fakeCanvas());
  const internals = engine as unknown as EngineInternals;
  /** One detection result, followed by one rendered frame (which commits the layout). */
  const detect = (faces: TestFace[]) => {
    internals.processDetectionResult(packFaces(faces), null, 1280, 720, 405, 720, "worker", 1);
    video.presentFrame();
  };
  const speakerCount = () => engine.getState().speakerCount;
  const resolved = () => internals.lastResolvedFaces;
  return { engine, detect, speakerCount, resolved };
}

const LEFT = { cx: 0.2, cy: 0.5, size: 0.15 };
const MIDDLE = { cx: 0.5, cy: 0.5, size: 0.15 };
const RIGHT = { cx: 0.8, cy: 0.5, size: 0.15 };
const FAR_RIGHT = { cx: 0.9, cy: 0.2, size: 0.15 };
const BIG_MIDDLE = { cx: 0.5, cy: 0.5, size: 0.3 };

describe("VertixEngine speaker tracking (25 fps detection cadence)", () => {
  it("commits the first layout after 6 agreeing detections, because the first rendered frame already commits the no-crop layout", () => {
    const { engine, detect, speakerCount } = setUpTracking();
    for (let i = 0; i < 5; i++) {
      detect([LEFT]);
      expect(speakerCount()).toBe(0);
    }
    detect([LEFT]);
    expect(speakerCount()).toBe(1);
    engine.destroy();
  });

  it("needs 6 agreeing detections to change an existing layout", () => {
    const { engine, detect, speakerCount } = setUpTracking();
    for (let i = 0; i < 6; i++) detect([LEFT]);
    for (let i = 0; i < 5; i++) {
      detect([LEFT, RIGHT]);
      expect(speakerCount()).toBe(1);
    }
    detect([LEFT, RIGHT]);
    expect(speakerCount()).toBe(2);
    engine.destroy();
  });

  it("drops to no crop after 2 detections without faces", () => {
    const { engine, detect, speakerCount } = setUpTracking();
    for (let i = 0; i < 6; i++) detect([LEFT]);
    detect([]);
    expect(speakerCount()).toBe(1);
    detect([]);
    expect(speakerCount()).toBe(0);
    engine.destroy();
  });

  it("shows the 3-face grid until a size-dominant face has won 5 detections in a row", () => {
    const { engine, detect, resolved } = setUpTracking();
    for (let i = 0; i < 4; i++) {
      detect([LEFT, BIG_MIDDLE, RIGHT]);
      expect(resolved()).toHaveLength(3);
    }
    detect([LEFT, BIG_MIDDLE, RIGHT]);
    expect(resolved()).toEqual([expect.objectContaining({ cx: BIG_MIDDLE.cx })]);
    engine.destroy();
  });

  it("frames nobody when 4+ faces have no clear winner", () => {
    const { engine, detect, resolved } = setUpTracking();
    detect([LEFT, MIDDLE, RIGHT, FAR_RIGHT]);
    expect(resolved()).toEqual([]);
    engine.destroy();
  });

  it("keeps the lock while no face clearly wins", () => {
    const { engine, detect, resolved } = setUpTracking();
    for (let i = 0; i < 5; i++) detect([LEFT, BIG_MIDDLE, RIGHT]);
    detect([LEFT, MIDDLE, RIGHT]);
    expect(resolved()).toEqual([expect.objectContaining({ cx: MIDDLE.cx })]);
    engine.destroy();
  });
});
