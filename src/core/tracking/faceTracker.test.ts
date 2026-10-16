import { describe, expect, it } from "vitest";
import { FaceTracker } from "./faceTracker";
import { detectionTimes, testFace } from "./testFaces";

describe("FaceTracker matching", () => {
  it("keeps the ID of a face that moves a little between detections", () => {
    const tracker = new FaceTracker();
    const [first] = tracker.update([testFace(0.3, 0.5, 0.15)], 0.2);
    const [moved] = tracker.update([testFace(0.33, 0.51, 0.15)], 0.4);
    expect(moved.id).toBe(first.id);
    expect(tracker.tracks).toHaveLength(1);
  });

  it("does not match a face too far away or of a very different size: it starts a new track", () => {
    const tracker = new FaceTracker();
    const [first] = tracker.update([testFace(0.2, 0.5, 0.15)], 0.2);
    tracker.update([testFace(0.6, 0.5, 0.15)], 0.4);
    tracker.update([testFace(0.2, 0.5, 0.4)], 0.6);
    const ids = tracker.tracks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tracker.tracks.find((t) => t.id === first.id)?.visible).toBe(false);
  });

  it("does not swap the IDs of two people crossing, even while one hides the other", () => {
    const tracker = new FaceTracker();
    const speed = 0.25;
    let leftId: number | null = null;
    let rightId: number | null = null;
    for (const t of detectionTimes(3)) {
      const a = testFace(0.2 + speed * t, 0.48, 0.15);
      const b = testFace(0.8 - speed * t, 0.52, 0.15);
      const overlapping = Math.abs(a.cx - b.cx) < 0.05;
      const tracks = tracker.update(overlapping ? [a] : [a, b], t);
      const trackA = tracks.find((track) => track.visible && Math.abs(track.lastDetection.cx - a.cx) < 1e-9)!;
      leftId ??= trackA.id;
      expect(trackA.id).toBe(leftId);
      if (!overlapping) {
        const trackB = tracks.find((track) => track.visible && Math.abs(track.lastDetection.cx - b.cx) < 1e-9)!;
        rightId ??= trackB.id;
        expect(trackB.id).toBe(rightId);
      }
    }
  });
});

describe("FaceTracker confirmation and removal", () => {
  it("confirms the tracks of the first detection after a reset at once", () => {
    const tracker = new FaceTracker();
    const tracks = tracker.update([testFace(0.3, 0.5, 0.15), testFace(0.7, 0.5, 0.15)], 0.2);
    expect(tracks.every((t) => t.confirmed)).toBe(true);
  });

  it("confirms a later new face after 3 matches", () => {
    const tracker = new FaceTracker();
    tracker.update([testFace(0.3, 0.5, 0.15)], 0.2);
    const newcomer = () => tracker.tracks.find((t) => t.box.cx > 0.5)!;
    tracker.update([testFace(0.3, 0.5, 0.15), testFace(0.7, 0.5, 0.15)], 0.4);
    expect(newcomer().confirmed).toBe(false);
    tracker.update([testFace(0.3, 0.5, 0.15), testFace(0.7, 0.5, 0.15)], 0.6);
    expect(newcomer().confirmed).toBe(false);
    tracker.update([testFace(0.3, 0.5, 0.15), testFace(0.7, 0.5, 0.15)], 0.8);
    expect(newcomer().confirmed).toBe(true);
  });

  it("keeps a confirmed track for 0.8s without a match, then removes it", () => {
    const tracker = new FaceTracker();
    const [track] = tracker.update([testFace(0.3, 0.5, 0.15)], 1.0);
    tracker.update([], 1.6);
    expect(tracker.tracks.map((t) => t.id)).toEqual([track.id]);
    tracker.update([], 1.8);
    expect(tracker.tracks).toHaveLength(0);
  });

  it("removes an unconfirmed track after 0.3s without a match", () => {
    const tracker = new FaceTracker();
    tracker.update([testFace(0.3, 0.5, 0.15)], 0.2);
    tracker.update([testFace(0.3, 0.5, 0.15), testFace(0.7, 0.5, 0.15)], 0.4);
    tracker.update([testFace(0.3, 0.5, 0.15)], 0.6);
    expect(tracker.tracks).toHaveLength(2);
    tracker.update([testFace(0.3, 0.5, 0.15)], 0.8);
    expect(tracker.tracks).toHaveLength(1);
  });

  it("drops every track on reset and gives new IDs", () => {
    const tracker = new FaceTracker();
    const [before] = tracker.update([testFace(0.3, 0.5, 0.15)], 0.2);
    tracker.reset();
    const [after] = tracker.update([testFace(0.3, 0.5, 0.15)], 0.4);
    expect(after.id).not.toBe(before.id);
    expect(after.confirmed).toBe(true);
    expect(tracker.tracks).toHaveLength(1);
  });

  it("does not age or remove tracks when media time goes backwards", () => {
    const tracker = new FaceTracker();
    const [track] = tracker.update([testFace(0.3, 0.5, 0.15)], 1.0);
    tracker.update([testFace(0.3, 0.5, 0.15)], 0.9);
    expect(tracker.tracks.map((t) => t.id)).toEqual([track.id]);
    expect(tracker.tracks[0].lastSeenSec).toBe(1.0);
  });
});

describe("FaceTracker smoothing", () => {
  it("smooths the box over time, the same at 5 and 10 detections per second", () => {
    const smoothedAfterOneSecond = (intervalSec: number) => {
      const tracker = new FaceTracker();
      tracker.update([testFace(0.3, 0.5, 0.1)], 0);
      for (const t of detectionTimes(1, intervalSec)) tracker.update([testFace(0.3, 0.5, 0.2)], t);
      return tracker.tracks[0].box.w;
    };
    const at5Hz = smoothedAfterOneSecond(0.2);
    expect(at5Hz).toBeGreaterThan(0.19);
    expect(at5Hz).toBeLessThan(0.2);
    expect(smoothedAfterOneSecond(0.1)).toBeCloseTo(at5Hz, 6);
  });
});
