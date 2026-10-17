import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VertixEngine, getActiveWasmBuild, switchWasmBuild } from "./VertixEngine";

// The main-thread fallback cannot load here: after the worker is given up, detection stops.
vi.mock("./wasm/simd/wasm.js", () => ({
  default: () => Promise.reject(new Error("no WASM in tests")),
  ReframeEngine: class {},
}));
vi.mock("./wasm/scalar/wasm.js", () => ({
  default: () => Promise.reject(new Error("no WASM in tests")),
  ReframeEngine: class {},
}));

vi.mock("./audioActivity", () => ({
  AudioActivityMonitor: class {
    available = false;
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
    setOutputDelay() {}
    muteFor() {}
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
    transferToImageBitmap() {
      return { close() {} };
    }
  }
);

type Handler = ((e: { data: unknown }) => void) | null;

/** A detection worker that answers "init" and, while `answering`, every "detect". Set `answering` false to simulate a worker killed without an error event. */
class FakeDetectionWorker {
  onmessage: Handler = null;
  onerror = null;
  answering = true;
  terminated = false;
  postMessage(message: { type: string; build?: string; requestId?: number }) {
    if (this.terminated) return;
    if (message.type === "init") queueMicrotask(() => this.reply({ type: "ready", build: message.build }));
    if (message.type === "detect" && this.answering) {
      queueMicrotask(() =>
        this.reply({
          type: "result",
          requestId: message.requestId,
          faces: new Float64Array(0).buffer,
          cutScores: new Float64Array([0, 0, 0]).buffer,
          tookMs: 5,
          readbackMs: 1,
        })
      );
    }
  }
  reply(data: unknown) {
    this.onmessage?.({ data });
  }
  terminate() {
    this.terminated = true;
  }
}

const detectionWorkers: FakeDetectionWorker[] = [];
vi.stubGlobal(
  "Worker",
  class {
    constructor(url: string) {
      if (url.includes("faceDetection")) {
        const worker = new FakeDetectionWorker();
        detectionWorkers.push(worker);
        return worker;
      }
      return { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
    }
  }
);

type FrameCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void;

class FakeVideo {
  paused = false;
  ended = false;
  videoWidth = 1280;
  videoHeight = 720;
  private presented = 0;
  private readonly pending = new Map<number, FrameCallback>();
  private nextId = 1;
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
  presentFrame(): void {
    this.presented += 1;
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    const metadata = {
      width: 1280,
      height: 720,
      mediaTime: this.presented / 25,
      presentedFrames: this.presented,
    } as VideoFrameCallbackMetadata;
    for (const callback of callbacks) callback(this.presented * 40, metadata);
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function setUp() {
  await switchWasmBuild(getActiveWasmBuild());
  const engine = new VertixEngine();
  const video = new FakeVideo();
  const canvas = { width: 0, height: 0, getContext: fake2dContext } as unknown as HTMLCanvasElement;
  engine.attach(video as unknown as HTMLVideoElement, canvas);
  await flush();
  let detections = 0;
  const internals = engine as unknown as { processDetectionResult: (...args: unknown[]) => void };
  const original = internals.processDetectionResult.bind(engine);
  internals.processDetectionResult = (...args: unknown[]) => {
    detections += 1;
    original(...args);
  };
  /** Presents `frames` frames, letting worker replies and bitmap promises settle after each. */
  const play = async (frames: number) => {
    for (let i = 0; i < frames; i++) {
      video.presentFrame();
      await flush();
    }
  };
  return { engine, play, detections: () => detections };
}

describe("VertixEngine detection watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces a worker killed in the middle of a run, and detection resumes", async () => {
    const { engine, play, detections } = await setUp();
    await play(25);
    expect(detections()).toBe(5);

    const killed = detectionWorkers.at(-1)!;
    const killedHandler = killed.onmessage!;
    killed.answering = false;
    await play(25);
    expect(detections()).toBe(5);

    const restartsBefore = engine.getDetectionHealth().workerRestarts;
    vi.advanceTimersByTime(2000);
    await flush();
    expect(detectionWorkers.at(-1)).not.toBe(killed);
    expect(engine.getDetectionHealth()).toMatchObject({ state: "worker", workerRestarts: restartsBefore + 1 });

    await play(25);
    expect(detections()).toBe(10);

    // A late answer from the replaced worker is ignored.
    killedHandler({
      data: {
        type: "result",
        requestId: 0,
        faces: new Float64Array(0).buffer,
        cutScores: new Float64Array([0, 0, 0]).buffer,
      },
    });
    expect(detections()).toBe(10);
    engine.destroy();
  });

  it("gives the worker up after 3 restarts within a minute; with no main-thread fallback, detection stops with a message", async () => {
    const { engine, play } = await setUp();
    await play(5);
    for (let restart = 0; restart < 4; restart++) {
      detectionWorkers.at(-1)!.answering = false;
      await play(5);
      vi.advanceTimersByTime(2000);
      await flush();
    }
    await play(5);
    await flush();
    const health = engine.getDetectionHealth();
    expect(health.state).toBe("stopped");
    expect(health.message).toMatch(/Face detection stopped/);
    expect(health.message).toMatch(/3 restarts within 60 s/);
    expect(engine.getMetrics().detectionHealth.state).toBe("stopped");
    engine.destroy();
  });

  it("tries the worker again after a deliberate build switch", async () => {
    const { engine } = await setUp();
    expect(engine.getDetectionHealth().state).toBe("worker");
    engine.destroy();
  });
});
