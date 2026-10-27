import { describe, expect, it } from "vitest";
import {
  computeSpeakerLayout,
  faceInsideCropMargin,
  lerpPaneRectInto,
  mouthActivity,
  paneSmoothingAlpha,
  unpackDetections,
  type FaceBox,
} from "./layoutEngine";

/** Glides a pane from x=0 toward x=100 for `seconds` at `fps`, one blend per rendered frame. */
function glideX(fps: number, seconds: number): number {
  const pane = { x: 0, y: 0, w: 100, h: 100 };
  const target = { x: 100, y: 0, w: 100, h: 100 };
  const alpha = paneSmoothingAlpha(1 / fps);
  for (let i = 0; i < Math.round(seconds * fps); i++) lerpPaneRectInto(pane, target, alpha);
  return pane.x;
}

describe("paneSmoothingAlpha", () => {
  it("matches the old fixed 0.06 per frame at 25 fps", () => {
    expect(paneSmoothingAlpha(1 / 25)).toBeCloseTo(0.06, 4);
  });

  it("moves a pane the same distance in one second at 25 and 50 fps", () => {
    const at25 = glideX(25, 1);
    const at50 = glideX(50, 1);
    expect(Math.abs(at25 - at50) / at25).toBeLessThan(0.01);
  });

  it("caps long gaps instead of snapping straight to the target", () => {
    expect(paneSmoothingAlpha(5)).toBe(paneSmoothingAlpha(0.25));
    expect(paneSmoothingAlpha(5)).toBeLessThan(1);
  });

  it("does not move on the first frame or on a negative gap", () => {
    expect(paneSmoothingAlpha(0)).toBe(0);
    expect(paneSmoothingAlpha(-1)).toBe(0);
  });
});

describe("unpackDetections", () => {
  it("splits skin-rejected detections from faces", () => {
    const flat = new Float64Array([0.2, 0.5, 0.1, 0.1, 5, 0.9, 0, 2, 0.7, 0.5, 0.2, 0.2, 0, 0.85, 1, 0]);
    const { faces, skinRejected } = unpackDetections(flat);
    expect(faces).toEqual([
      { cx: 0.2, cy: 0.5, w: 0.1, h: 0.1, motion: mouthActivity(5, 2), lowerFaceMotion: 5, confidence: 0.9 },
    ]);
    expect(skinRejected).toEqual([
      { cx: 0.7, cy: 0.5, w: 0.2, h: 0.2, motion: 0, lowerFaceMotion: 0, confidence: 0.85 },
    ]);
  });
});

describe("stationary camera", () => {
  const face = (cx: number, cy: number): FaceBox => ({
    cx,
    cy,
    w: 0.1,
    h: 0.15,
    motion: 0,
    lowerFaceMotion: 0,
    confidence: 0.9,
  });
  const SRC = { w: 1920, h: 1080 };
  const OUT = { w: 608, h: 1080 };

  it("keeps the crop while the face stays inside the margin", () => {
    const first = computeSpeakerLayout([face(0.5, 0.4)], SRC.w, SRC.h, OUT.w, OUT.h);
    const next = computeSpeakerLayout([face(0.52, 0.41)], SRC.w, SRC.h, OUT.w, OUT.h, first, true);
    expect(next[0].pane.source).toEqual(first[0].pane.source);
  });

  it("aims again once the face leaves the margin", () => {
    const first = computeSpeakerLayout([face(0.5, 0.4)], SRC.w, SRC.h, OUT.w, OUT.h);
    const crop = first[0].pane.source;
    const outside = face((crop.x + crop.w) / SRC.w - 0.001, 0.4);
    const next = computeSpeakerLayout([outside], SRC.w, SRC.h, OUT.w, OUT.h, first, true);
    expect(next[0].pane.source.x).toBeGreaterThan(crop.x);
  });

  it("measures the margin around where the crop aims the face", () => {
    const crop = { x: 100, y: 0, w: 400, h: 1000 };
    const at = (x: number, y: number) => face(x / SRC.w, y / SRC.h);
    expect(faceInsideCropMargin(at(300, 350), crop, SRC.w, SRC.h)).toBe(true);
    expect(faceInsideCropMargin(at(300 + 100, 350), crop, SRC.w, SRC.h)).toBe(true);
    expect(faceInsideCropMargin(at(300 + 101, 350), crop, SRC.w, SRC.h)).toBe(false);
    expect(faceInsideCropMargin(at(300, 350 + 201), crop, SRC.w, SRC.h)).toBe(false);
  });
});
