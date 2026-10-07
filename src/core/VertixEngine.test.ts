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
