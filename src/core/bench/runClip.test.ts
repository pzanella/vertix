import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VertixEngine } from "../VertixEngine";
import { BenchmarkRunError, runBenchmarkClip, SOURCE_LOAD_TIMEOUT_MS } from "./runClip";

vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });

/** A video whose source never loads: no loadedmetadata, ever. */
function stuckVideo(): HTMLVideoElement {
  return {
    currentTime: 0,
    duration: NaN,
    readyState: 0,
    networkState: 2,
    paused: true,
    ended: false,
    error: null,
    addEventListener() {},
    removeEventListener() {},
    pause() {},
  } as unknown as HTMLVideoElement;
}

function stubEngine(): VertixEngine {
  return {
    setMode() {},
    setLookaheadEnabled() {},
    setBenchmarkProbe() {},
    getResourceStats: () => Promise.resolve(null),
    getLookaheadStatus: () => ({ bufferedFrames: 0 }),
    getDetectionHealth: () => ({ state: "worker", workerRestarts: 0, message: null }),
  } as unknown as VertixEngine;
}

describe("runBenchmarkClip, source load timeout", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("fails with a recorded failure when the source does not load within 30 s", async () => {
    const run = runBenchmarkClip(stubEngine(), stuckVideo(), {
      clipName: "never-loads.mp4",
      mode: "9:16",
      nominalFps: 25,
      warmupSec: 1,
      lookahead: true,
      loadSource: () => {},
      wasmBuild: { variant: "scalar", reason: "benchmark-suite", runOrder: null },
    });
    const outcome = run.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SOURCE_LOAD_TIMEOUT_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(BenchmarkRunError);
    const { failure, partial } = error as BenchmarkRunError;
    expect(failure.message).toBe("Source did not load within 30 s");
    expect(failure).toMatchObject({ clip: "never-loads.mp4", build: "scalar", lookahead: true, mode: "9:16" });
    expect(failure.video).toMatchObject({ readyState: 0, currentTimeSec: 0 });
    expect(partial).toBeNull();
  });
});

/** A video that loads at once and ends right after. */
function shortVideo(): HTMLVideoElement & { fire(type: string): void } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    currentTime: 0,
    duration: 1,
    videoWidth: 1280,
    videoHeight: 720,
    readyState: 4,
    paused: false,
    ended: false,
    muted: false,
    error: null,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    pause() {},
    fire(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  } as unknown as HTMLVideoElement & { fire(type: string): void };
}

describe("runBenchmarkClip, host extension", () => {
  const run = (video: ReturnType<typeof shortVideo>, finish: () => Promise<unknown>) => {
    const started: { warmupSec: number }[] = [];
    const result = runBenchmarkClip(stubEngine(), video, {
      clipName: "short.mp4",
      mode: "9:16",
      nominalFps: 25,
      warmupSec: 2,
      loadSource: () => {
        video.fire("loadedmetadata");
        queueMicrotask(() => video.fire("ended"));
      },
      wasmBuild: { variant: "simd", reason: "benchmark-suite", runOrder: null },
      extension: { key: "overlay", start: (context) => started.push(context), finish },
    });
    return { result, started };
  };

  it("starts with the recording and stores its block under its key", async () => {
    const { result, started } = run(shortVideo(), () => Promise.resolve({ drawn: 3 }));
    const clip = await result;
    expect(started).toEqual([{ warmupSec: 2 }]);
    expect(clip.extensions).toEqual({ overlay: { drawn: 3 } });
  });

  it("leaves the field out for a null block, and records a failing extension without failing the run", async () => {
    expect((await run(shortVideo(), () => Promise.resolve(null)).result).extensions).toBeUndefined();
    const failed = await run(shortVideo(), () => Promise.reject(new Error("no worker"))).result;
    expect(failed.extensions).toEqual({ overlay: { error: "no worker" } });
  });
});
