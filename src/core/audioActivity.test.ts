import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioActivityMonitor } from "./audioActivity";

/** Time-domain byte the fake analyser returns: 128 is exact silence. */
let analyserLevel = 128;

const fakeNode = () => ({ connect() {}, disconnect() {} });

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  createMediaElementSource = fakeNode;
  createAnalyser() {
    return {
      ...fakeNode(),
      fftSize: 512,
      getByteTimeDomainData: (data: Uint8Array) => data.fill(analyserLevel),
    };
  }
  createDelay() {
    return { ...fakeNode(), delayTime: { value: 0, setValueAtTime() {} } };
  }
  createGain() {
    return {
      ...fakeNode(),
      gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} },
    };
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    return Promise.resolve();
  }
}

function fakeVideo(currentSrc: string) {
  return {
    currentSrc,
    paused: false,
    muted: false,
    volume: 1,
    webkitAudioDecodedByteCount: 4096,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLVideoElement;
}

const CROSS_ORIGIN = "https://cdn.example.com/video.mp4";

/** Checks the path every 300 ms (the engine's metrics cadence) from `fromMs` to `toMs`. */
function checkOver(monitor: AudioActivityMonitor, video: HTMLVideoElement, fromMs: number, toMs: number): boolean {
  let suspected = false;
  for (let t = fromMs; t <= toMs; t += 300) suspected = monitor.checkSilentPath(video, t);
  return suspected;
}

describe("AudioActivityMonitor silent-path check", () => {
  beforeEach(() => {
    analyserLevel = 128;
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    vi.stubGlobal("location", { href: "https://app.example.com/", origin: "https://app.example.com" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("suspects a cross-origin source that has only given exact silence for 3 s", () => {
    const monitor = new AudioActivityMonitor();
    const video = fakeVideo(CROSS_ORIGIN);
    monitor.attach(video);
    expect(checkOver(monitor, video, 0, 2700)).toBe(false);
    expect(checkOver(monitor, video, 3000, 3000)).toBe(true);
  });

  it("never suspects a source again once it has produced sound", () => {
    const monitor = new AudioActivityMonitor();
    const video = fakeVideo(CROSS_ORIGIN);
    monitor.attach(video);
    analyserLevel = 140;
    checkOver(monitor, video, 0, 300);
    analyserLevel = 128;
    expect(checkOver(monitor, video, 600, 60_000)).toBe(false);
    expect(monitor.silentPathSuspected).toBe(false);
  });

  it("judges a new source on its own after a reset", () => {
    const monitor = new AudioActivityMonitor();
    const video = fakeVideo(CROSS_ORIGIN);
    monitor.attach(video);
    analyserLevel = 140;
    checkOver(monitor, video, 0, 300);
    monitor.resetSilentPath();
    analyserLevel = 128;
    expect(checkOver(monitor, video, 1000, 4000)).toBe(true);
  });

  it("never suspects a same-origin source, whose silent track is real silence", () => {
    const monitor = new AudioActivityMonitor();
    const video = fakeVideo("https://app.example.com/samples/3-speakers.mp4");
    monitor.attach(video);
    expect(checkOver(monitor, video, 0, 10_000)).toBe(false);
  });
});
