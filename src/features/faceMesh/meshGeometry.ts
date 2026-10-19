import type { DetectionTickTrack, OverlayView } from "../../core";

/** Crop side as a multiple of the detection box's longer side, so the face mesh model sees the face at about half the crop. */
export const CROP_MARGIN_FACTOR = 1.8;
/** Crops are resized to the face mesh model's own input size. */
export const CROP_SIZE_PX = 256;
/** Faces meshed per detection tick, largest first. */
export const MAX_MESHED_FACES = 3;

/** A square crop around a detection box, in source pixels. May extend past the frame edges. */
export interface CropRect {
  x: number;
  y: number;
  side: number;
}

export function cropRectFor(track: DetectionTickTrack, srcW: number, srcH: number): CropRect {
  const side = CROP_MARGIN_FACTOR * Math.max(track.w * srcW, track.h * srcH);
  return { x: track.cx * srcW - side / 2, y: track.cy * srcH - side / 2, side };
}

/** Confirmed foreground tracks, largest first, at most MAX_MESHED_FACES. */
export function tracksToMesh(tracks: readonly DetectionTickTrack[]): DetectionTickTrack[] {
  return tracks
    .filter((t) => t.confirmed && t.foreground)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, MAX_MESHED_FACES);
}

/** Mesh points normalised to their crop, as flat [x, y], to points normalised to the source frame. */
export function cropToSource(mesh: Float32Array, crop: CropRect, srcW: number, srcH: number): Float32Array {
  const out = new Float32Array(mesh.length);
  for (let i = 0; i < mesh.length; i += 2) {
    out[i] = (crop.x + mesh[i] * crop.side) / srcW;
    out[i + 1] = (crop.y + mesh[i + 1] * crop.side) / srcH;
  }
  return out;
}

/** Source-normalised flat [x, y] points to overlay pixels through one view, written into `out`. */
export function sourceToView(
  points: Float32Array,
  view: OverlayView,
  srcW: number,
  srcH: number,
  out: Float32Array
): Float32Array {
  const scaleX = view.dest.w / view.source.w;
  const scaleY = view.dest.h / view.source.h;
  for (let i = 0; i < points.length; i += 2) {
    out[i] = view.dest.x + (points[i] * srcW - view.source.x) * scaleX;
    out[i + 1] = view.dest.y + (points[i + 1] * srcH - view.source.y) * scaleY;
  }
  return out;
}
