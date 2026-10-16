import { describe, expect, it } from "vitest";
import { FaceTracker } from "./faceTracker";
import { updateForeground } from "./foregroundFilter";
import { testFace } from "./testFaces";

function foregroundAfter(sizes: number[][]): boolean[] {
  const tracker = new FaceTracker();
  let t = 0;
  for (const row of sizes) {
    t += 0.2;
    // Same size for long enough that the smoothed size has settled.
    for (let i = 0; i < 10; i++, t += 0.2) {
      updateForeground(tracker.update([testFace(0.3, 0.5, row[0]), testFace(0.7, 0.5, row[1])], t));
    }
  }
  return [...tracker.tracks].sort((a, b) => a.box.cx - b.box.cx).map((track) => track.foreground);
}

describe("updateForeground", () => {
  it("counts a face of at least 35% of the largest face's area", () => {
    expect(foregroundAfter([[0.3, 0.3 * Math.sqrt(0.36)]])).toEqual([true, true]);
    expect(foregroundAfter([[0.3, 0.3 * Math.sqrt(0.3)]])).toEqual([true, false]);
  });

  it("keeps a foreground face until it falls below 25%: no flicker near the limit", () => {
    const enter = 0.3 * Math.sqrt(0.4);
    const between = 0.3 * Math.sqrt(0.3);
    const below = 0.3 * Math.sqrt(0.2);
    expect(
      foregroundAfter([
        [0.3, enter],
        [0.3, between],
      ])
    ).toEqual([true, true]);
    expect(
      foregroundAfter([
        [0.3, enter],
        [0.3, below],
      ])
    ).toEqual([true, false]);
  });

  it("needs a size of 0.12 to enter and keeps the face down to 0.10", () => {
    expect(foregroundAfter([[0.11, 0.11]])).toEqual([false, false]);
    expect(
      foregroundAfter([
        [0.13, 0.13],
        [0.11, 0.11],
      ])
    ).toEqual([true, true]);
    expect(
      foregroundAfter([
        [0.13, 0.13],
        [0.09, 0.09],
      ])
    ).toEqual([false, false]);
  });

  it("ignores a face cut off at the frame edge", () => {
    const tracker = new FaceTracker();
    updateForeground(tracker.update([testFace(0.02, 0.5, 0.2), testFace(0.5, 0.5, 0.2)], 0.2));
    expect(tracker.tracks.map((t) => t.foreground)).toEqual([false, true]);
  });
});
