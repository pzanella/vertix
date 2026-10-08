import { describe, expect, it } from "vitest";
import type { FaceBox } from "./layoutEngine";
import { ActiveSpeakerResolver, PersonCountDebouncer } from "./speakerTracking";

function face(cx: number, cy: number, size = 0.15): FaceBox {
  return { cx, cy, w: size, h: size, motion: 0, confidence: 0.9 };
}

const LEFT = face(0.2, 0.5);
const RIGHT = face(0.8, 0.5);
const FAR_RIGHT = face(0.9, 0.2);
const BIG_MIDDLE = face(0.5, 0.5, 0.3);

/** A slow phone: about 4 detections per second. */
const INTERVAL_SEC = 0.25;

/** A resolver locked onto BIG_MIDDLE, plus a `detect` that advances media time by INTERVAL_SEC per call. */
function lockedResolver() {
  const resolver = new ActiveSpeakerResolver();
  let atSec = 0;
  const detect = (faces: FaceBox[]) => {
    atSec += INTERVAL_SEC;
    return resolver.resolve(faces, null, atSec);
  };
  let resolved: FaceBox[] = [];
  for (let i = 0; i < 10 && resolved.length !== 1; i++) resolved = detect([LEFT, BIG_MIDDLE, RIGHT]);
  expect(resolved).toEqual([BIG_MIDDLE]);
  return { detect };
}

describe("ActiveSpeakerResolver lock release", () => {
  it("releases the lock when the locked face is gone, instead of framing whoever is nearest", () => {
    const { detect } = lockedResolver();
    expect(detect([LEFT, RIGHT, FAR_RIGHT])).toEqual([LEFT, RIGHT, FAR_RIGHT]);
  });

  it("releases the lock when the nearest face is farther than the maximum lock distance", () => {
    const { detect } = lockedResolver();
    const jumped = face(0.66, 0.5);
    expect(detect([LEFT, jumped, RIGHT])).toEqual([LEFT, jumped, RIGHT]);
  });

  it("follows the locked face while it moves slowly", () => {
    const { detect } = lockedResolver();
    for (let step = 1; step <= 6; step++) {
      const moved = face(0.5 + step * 0.05, 0.5);
      expect(detect([LEFT, moved, face(0.5 + step * 0.05, 0.9)])).toEqual([moved]);
    }
  });

  it("keeps the lock through a single missed detection (3 -> 2 -> 3 faces within 0.4s)", () => {
    const { detect } = lockedResolver();
    expect(detect([LEFT, BIG_MIDDLE])).toEqual([BIG_MIDDLE]);
    expect(detect([LEFT, BIG_MIDDLE, RIGHT])).toEqual([BIG_MIDDLE]);
  });

  it("clears the lock once the face count has stayed below 3 for 0.4s", () => {
    const { detect } = lockedResolver();
    detect([LEFT, BIG_MIDDLE]);
    detect([LEFT, BIG_MIDDLE]);
    expect(detect([LEFT, BIG_MIDDLE])).toEqual([LEFT, BIG_MIDDLE]);
    const sameSize = [LEFT, face(0.5, 0.5), RIGHT];
    expect(detect(sameSize)).toEqual(sameSize);
  });

  it("releases the lock right away when the locked face is gone below 3 faces", () => {
    const { detect } = lockedResolver();
    expect(detect([LEFT, RIGHT])).toEqual([LEFT, RIGHT]);
  });
});

describe("PersonCountDebouncer timing is the same in seconds at 25 and 50 fps", () => {
  /** Media time from the first agreeing detection to the commit, detecting every 5 frames. */
  function secondsToCommit(fps: number, from: number, to: number): number {
    const debouncer = new PersonCountDebouncer();
    const intervalSec = 5 / fps;
    let atSec = 0;
    for (let i = 0; i < 20; i++) debouncer.observe(from, true, (atSec += intervalSec));
    const startSec = atSec + intervalSec;
    while (debouncer.observe(to, true, (atSec += intervalSec)) !== to) {
      if (atSec > 10) throw new Error("never committed");
    }
    return Math.round((atSec - startSec) * 1000) / 1000;
  }

  it.each([25, 50])("changes the count after 1.0s at %i fps", (fps) => {
    expect(secondsToCommit(fps, 1, 2)).toBe(1);
  });

  it.each([25, 50])("drops to zero after 0.2s at %i fps", (fps) => {
    expect(secondsToCommit(fps, 1, 0)).toBe(0.2);
  });

  it("never commits on a single detection, however long after the previous one", () => {
    const debouncer = new PersonCountDebouncer();
    debouncer.observe(1, false, 0);
    expect(debouncer.observe(1, false, 0.2)).toBe(1);
    expect(debouncer.observe(2, true, 5)).toBe(1);
  });
});
