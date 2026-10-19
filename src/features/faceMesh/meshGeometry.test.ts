import { describe, expect, it } from "vitest";
import type { DetectionTickTrack } from "../../core";
import { CROP_MARGIN_FACTOR, cropRectFor, cropToSource, sourceToView, tracksToMesh } from "./meshGeometry";

const track = (id: number, w: number, extra: Partial<DetectionTickTrack> = {}): DetectionTickTrack => ({
  id,
  confirmed: true,
  foreground: true,
  cx: 0.5,
  cy: 0.5,
  w,
  h: w,
  ...extra,
});

describe("face mesh geometry", () => {
  it("crops a square of CROP_MARGIN_FACTOR × the box's longer side, centred on it", () => {
    const crop = cropRectFor({ ...track(1, 0.1), h: 0.25 }, 1280, 720);
    expect(crop.side).toBeCloseTo(CROP_MARGIN_FACTOR * 180, 6);
    expect(crop.x + crop.side / 2).toBeCloseTo(640, 6);
    expect(crop.y + crop.side / 2).toBeCloseTo(360, 6);
  });

  it("maps a point from the crop to the frame, and through a 9:16 pane to the overlay", () => {
    const crop = { x: 400, y: 100, side: 200 };
    const inFrame = cropToSource(new Float32Array([0.5, 0.25]), crop, 1280, 720);
    expect(inFrame[0]).toBeCloseTo(500 / 1280, 6);
    expect(inFrame[1]).toBeCloseTo(150 / 720, 6);
    // A pane showing source x 300..705 (405 px wide, full height) on a 405×720 output.
    const view = { source: { x: 300, y: 0, w: 405, h: 720 }, dest: { x: 0, y: 0, w: 405, h: 720 } };
    const onOverlay = sourceToView(inFrame, view, 1280, 720, new Float32Array(2));
    expect(onOverlay[0]).toBeCloseTo(200, 4);
    expect(onOverlay[1]).toBeCloseTo(150, 4);
  });

  it("maps through a stacked pane (lower half, zoomed) and the whole 16:9 frame", () => {
    const point = new Float32Array([0.5, 0.5]);
    const lower = { source: { x: 540, y: 180, w: 200, h: 180 }, dest: { x: 0, y: 360, w: 405, h: 360 } };
    const onLower = sourceToView(point, lower, 1280, 720, new Float32Array(2));
    expect(onLower[0]).toBeCloseTo(((640 - 540) * 405) / 200, 4);
    expect(onLower[1]).toBeCloseTo(360 + ((360 - 180) * 360) / 180, 4);
    const whole = { source: { x: 0, y: 0, w: 1280, h: 720 }, dest: { x: 0, y: 0, w: 1280, h: 720 } };
    expect([...sourceToView(point, whole, 1280, 720, new Float32Array(2))]).toEqual([640, 360]);
  });

  it("meshes confirmed foreground tracks only, at most 3, largest first", () => {
    const picked = tracksToMesh([
      track(1, 0.1),
      track(2, 0.3),
      track(3, 0.2, { confirmed: false }),
      track(4, 0.25, { foreground: false }),
      track(5, 0.15),
      track(6, 0.12),
    ]);
    expect(picked.map((t) => t.id)).toEqual([2, 5, 6]);
  });
});
