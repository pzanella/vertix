import { describe, expect, it } from "vitest";
import { MESH_FADE_IN_SEC, MESH_FADE_OUT_SEC, MESH_HOLD_SEC, MeshTimeline, type ShownMesh } from "./meshTimeline";

const mesh = (x: number, y = 0.5) => new Float32Array([x, y, x + 0.1, y]);
const check = (mediaTimeSec: number, meshes: [number, Float32Array | null][]) => ({
  mediaTimeSec,
  meshes: new Map(meshes),
});
const only = (shown: ShownMesh[]) => {
  expect(shown).toHaveLength(1);
  return shown[0];
};

describe("MeshTimeline", () => {
  it("shows nothing before the first check", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    expect(timeline.meshesAt(0.9)).toEqual([]);
  });

  it("interpolates each point linearly between the checks around the frame, per track", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(
      check(1, [
        [1, mesh(0.2)],
        [2, mesh(0.6)],
      ])
    );
    timeline.addCheck(
      check(1.2, [
        [1, mesh(0.4)],
        [2, mesh(0.6, 0.7)],
      ])
    );
    const shown = timeline.meshesAt(1.05);
    const one = shown.find((m) => m.trackId === 1)!;
    const two = shown.find((m) => m.trackId === 2)!;
    expect(one.kind).toBe("interpolated");
    expect(one.points[0]).toBeCloseTo(0.25, 6);
    expect(one.points[2]).toBeCloseTo(0.35, 6);
    expect(two.points[0]).toBeCloseTo(0.6, 6);
    expect(two.points[1]).toBeCloseTo(0.55, 6);
  });

  it("shows the latest mesh as a step while the next check is not in yet", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    const shown = only(timeline.meshesAt(1.3));
    expect(shown.kind).toBe("stepped");
    expect(shown.points[0]).toBeCloseTo(0.2, 6);
  });

  it("never interpolates between different track IDs", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    timeline.addCheck(check(1.2, [[2, mesh(0.4)]]));
    const shown = timeline.meshesAt(1.1);
    expect(shown.map((m) => [m.trackId, m.kind])).toEqual([[1, "stepped"]]);
    expect(shown[0].points[0]).toBeCloseTo(0.2, 6);
  });

  it("never interpolates across a cut, and the old mesh disappears on the cut frame", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    timeline.addCut(1.12);
    timeline.addCheck(check(1.2, [[1, mesh(0.8)]]));
    expect(only(timeline.meshesAt(1.08))).toMatchObject({ kind: "stepped" });
    expect(only(timeline.meshesAt(1.08)).points[0]).toBeCloseTo(0.2, 6);
    expect(timeline.meshesAt(1.12)).toEqual([]);
    expect(timeline.meshesAt(1.16)).toEqual([]);
    expect(only(timeline.meshesAt(1.2)).points[0]).toBeCloseTo(0.8, 6);
  });

  it("holds the last mesh for MESH_HOLD_SEC after it was found, then fades it out over MESH_FADE_OUT_SEC", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    timeline.addCheck(check(1.2, [[1, null]]));
    timeline.addCheck(check(1.4, [[1, null]]));
    timeline.addCheck(check(1.6, [[1, null]]));
    timeline.addCheck(check(1.8, [[1, null]]));
    expect(only(timeline.meshesAt(1.2))).toMatchObject({ kind: "held", alpha: 1 });
    expect(only(timeline.meshesAt(1 + MESH_HOLD_SEC)).alpha).toBe(1);
    expect(only(timeline.meshesAt(1 + MESH_HOLD_SEC + MESH_FADE_OUT_SEC / 2)).alpha).toBeCloseTo(0.5, 6);
    expect(timeline.meshesAt(1 + MESH_HOLD_SEC + MESH_FADE_OUT_SEC + 0.01)).toEqual([]);
  });

  it("keeps showing the latest mesh however late it came (no lookahead on a slow phone)", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    timeline.addCheck(check(1.5, [[1, mesh(0.4)]]));
    expect(only(timeline.meshesAt(2.4))).toMatchObject({ kind: "stepped", alpha: 1 });
  });

  it("holds and fades on check time, so a late result does not cut the hold short", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    timeline.addCheck(check(1.2, [[1, null]]));
    // Shown 0.6 s after the check without a mesh, but only 0.4 s of check time (one interval) has passed.
    expect(only(timeline.meshesAt(1.8))).toMatchObject({ kind: "held", alpha: 1 });
    timeline.addCheck(check(1.6, [[1, null]]));
    expect(only(timeline.meshesAt(1.7)).alpha).toBeCloseTo(1 - (0.7 - MESH_HOLD_SEC) / MESH_FADE_OUT_SEC, 6);
  });

  it("treats a track missing from a check like a check without a mesh", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    timeline.addCheck(check(1.2, [[2, mesh(0.5)]]));
    expect(timeline.meshesAt(1.25).find((m) => m.trackId === 1)).toMatchObject({ kind: "held", alpha: 1 });
    timeline.addCheck(check(2, [[2, mesh(0.5)]]));
    expect(timeline.meshesAt(2).map((m) => m.trackId)).toEqual([2]);
  });

  it("tells whether a cut is shown between two frames", () => {
    const timeline = new MeshTimeline();
    timeline.addCut(1.12);
    expect(timeline.cutBetween(1.08, 1.12)).toBe(true);
    expect(timeline.cutBetween(1.12, 1.16)).toBe(false);
  });

  it("does not hold a mesh across a cut", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, mesh(0.2)]]));
    timeline.addCut(1.2);
    timeline.addCheck(check(1.2, [[1, null]]));
    expect(timeline.meshesAt(1.25)).toEqual([]);
  });

  it("fades a mesh in over MESH_FADE_IN_SEC when it appears", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(1, [[1, null]]));
    timeline.addCheck(check(1.2, [[1, mesh(0.2)]]));
    timeline.addCheck(check(1.4, [[1, mesh(0.2)]]));
    expect(only(timeline.meshesAt(1.2)).alpha).toBe(0);
    expect(only(timeline.meshesAt(1.2 + MESH_FADE_IN_SEC / 2)).alpha).toBeCloseTo(0.5, 6);
    expect(only(timeline.meshesAt(1.2 + MESH_FADE_IN_SEC)).alpha).toBeCloseTo(1, 9);
  });

  it("starts over on a check older than the latest (a seek)", () => {
    const timeline = new MeshTimeline();
    timeline.addCheck(check(5, [[1, mesh(0.2)]]));
    timeline.addCheck(check(2, [[1, mesh(0.6)]]));
    expect(only(timeline.meshesAt(2.1)).points[0]).toBeCloseTo(0.6, 6);
    expect(timeline.latestCheckSec).toBe(2);
  });
});
