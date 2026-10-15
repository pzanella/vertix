import { describe, expect, it } from "vitest";
import { avClockErrorsMs } from "./avClock";

/** 25 fps frames on a 60 Hz screen: each shown on the first refresh at or after its audio time (5000 ms + media time). */
function jitteryPlayback(frames: number) {
  const mediaSec: number[] = [];
  const displayMs: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i * 0.04;
    mediaSec.push(t);
    displayMs.push(Math.ceil((5000 + t * 1000) / (1000 / 60)) * (1000 / 60));
  }
  return { mediaSec, displayMs };
}

describe("avClockErrorsMs", () => {
  it("is the video element's own jitter without lookahead, within a refresh", () => {
    const { mediaSec, displayMs } = jitteryPlayback(250);
    const errors = avClockErrorsMs(
      mediaSec,
      displayMs,
      mediaSec.map((t, i) => ({ mediaTimeSec: t, onScreenAtMs: displayMs[i], delayMs: 0 }))
    );
    expect(Math.max(...errors.map(Math.abs))).toBeLessThan(1000 / 60);
  });

  it("is the same with lookahead when the right frame is shown, and a frame off when it is not", () => {
    const { mediaSec, displayMs } = jitteryPlayback(250);
    const delayFrames = 8;
    const displays = mediaSec.slice(delayFrames).map((_, i) => ({
      mediaTimeSec: mediaSec[i],
      onScreenAtMs: displayMs[i + delayFrames],
      delayMs: delayFrames * 40,
    }));
    const errors = avClockErrorsMs(mediaSec, displayMs, displays);
    expect(Math.max(...errors.map(Math.abs))).toBeLessThan(1000 / 60);

    const oneFrameOld = avClockErrorsMs(mediaSec, displayMs, [{ ...displays[100], mediaTimeSec: mediaSec[99] }]);
    expect(oneFrameOld[0]).toBeGreaterThan(40 - 1000 / 60);
  });

  it("is NaN with no frame callback nearby", () => {
    expect(avClockErrorsMs([0], [5000], [{ mediaTimeSec: 10, onScreenAtMs: 15000, delayMs: 0 }])).toEqual([NaN]);
  });
});
