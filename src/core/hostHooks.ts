import type { PaneRect } from "./layoutEngine";

/** A face track as one detection tick saw it, with the box of that detection (normalised to the source). */
export interface DetectionTickTrack {
  id: number;
  confirmed: boolean;
  foreground: boolean;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** What one face detection found, after tracking. */
export interface DetectionTick {
  /** Media time of the detected frame: the same value its DetectionObserver.onFrame call had. */
  mediaTimeSec: number;
  srcW: number;
  srcH: number;
  /** Tracks with a detection on this frame. */
  tracks: readonly DetectionTickTrack[];
  /** Media time from which a hard cut found by this detection is shown (the cut frame itself with lookahead), else null. */
  cutAtSec: number | null;
}

/**
 * Follows face detection from the host. Called synchronously on the main
 * thread; keep both callbacks cheap. With no observer registered the
 * engine does no extra work.
 */
export interface DetectionObserver {
  /** A frame is about to go to detection. `source` is only valid during the call: copy what you need. */
  onFrame?(source: HTMLVideoElement | OffscreenCanvas, mediaTimeSec: number): void;
  onTick?(tick: DetectionTick): void;
}

/** Where a part of the source (in source pixels) is drawn on the output (in output pixels). */
export interface OverlayView {
  source: PaneRect;
  dest: PaneRect;
}

/** The frame the engine has just drawn on the output, for a host overlay laid exactly over it. */
export interface OverlayFrame {
  ctx: CanvasRenderingContext2D;
  /** Overlay size in pixels: the same as the output canvas. */
  width: number;
  height: number;
  /** Media time of the frame on the output. */
  mediaTimeSec: number;
  srcW: number;
  srcH: number;
  /** Empty when nothing on the output maps to source coordinates (a portrait source shown as is). */
  views: readonly OverlayView[];
}

/** Draws on a cleared overlay after every output frame. */
export type OverlayRenderer = (frame: OverlayFrame) => void;

/** The lookahead length and what it was made of, in ms. */
export interface LookaheadLengths {
  /** Applied now (a running ramp aside); 0 when lookahead is not running. */
  lengthMs: number;
  /** What the length would be without the host's minimum. */
  baseLengthMs: number;
  /** The host's minimum (setMinimumLookaheadMs), or null. */
  minimumMs: number | null;
}
