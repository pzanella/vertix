export interface FaceBox {
  /** Fraction (0..1) of the source frame. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  motion: number;
  /** The detector's own confidence (0..1) for this detection. Already thresholded server-side (Rust drops anything below its own cutoff), so in practice this stays in a fairly narrow high band. */
  confidence: number;
}

export interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpeakerPane {
  /** Pixel rect to read from the source video. */
  source: PaneRect;
  /** Pixel rect to draw into on the output canvas. */
  dest: PaneRect;
}

/** Unpacks the `[cx, cy, w, h, motion, score, ...]` array returned by `ReframeEngine.update_faces`. */
export function unpackFaces(flat: Float64Array): FaceBox[] {
  const faces: FaceBox[] = [];
  for (let i = 0; i + 5 < flat.length; i += 6) {
    faces.push({
      cx: flat[i],
      cy: flat[i + 1],
      w: flat[i + 2],
      h: flat[i + 3],
      motion: flat[i + 4],
      confidence: flat[i + 5],
    });
  }
  return faces;
}

/**
 * Splits `n` panes into rows. 2 is special-cased to a vertical stack (one
 * person per row) rather than the general square-ish grid, since a 9:16
 * output is tall and narrow — a 2-wide single row would squeeze both faces
 * into thin vertical slivers instead of the top/bottom split viewers expect.
 * 3+ forms a grid as square as possible, remainder on the last row (3 ->
 * [2, 1], 4 -> [2, 2], 5 -> [3, 2]).
 */
function gridRows(n: number): number[] {
  if (n <= 0) return [];
  if (n === 2) return [1, 1];

  const cols = Math.ceil(Math.sqrt(n));
  const rows: number[] = [];
  let remaining = n;
  while (remaining > 0) {
    const take = Math.min(cols, remaining);
    rows.push(take);
    remaining -= take;
  }
  return rows;
}

// How many face-heights tall the crop is (crop height = face height ×
// this): LARGER -> wider/more zoomed-out crop, SMALLER -> tighter/more
// zoomed-in. Single-speaker fills the whole 9:16 frame, so it can afford a
// real chest-up framing; multi-speaker panes are much smaller, so the same
// wide framing would show mostly empty space around a tiny face.
const SINGLE_SPEAKER_ZOOM_FACTOR = 6.0;
const MULTI_SPEAKER_ZOOM_FACTOR = 2.75;
// Where the face's vertical center sits within the crop (0 = top, 1 =
// bottom), targeting a rule-of-thirds composition (eyes at roughly 1/3 from
// the top). The detector (UltraFace) gives a face bounding box, not eye
// landmarks, so this is an approximation: eyes typically sit a bit above a
// face box's own vertical center, so anchoring the *box* center a little
// below the true 1/3 line (here, 0.35 instead of 0.33) lands the eyes
// themselves close to it.
const FACE_VERTICAL_ANCHOR = 0.35;

/**
 * A "cover" crop of the source frame at the given aspect ratio, sized from
 * the face's own height (see `zoomFactor`) and clamped to the source
 * bounds. Vertically the face sits at FACE_VERTICAL_ANCHOR (rule of
 * thirds, not dead-center); horizontally it's exactly centered — the
 * crop's center-of-mass on the X axis is the face's own cx, full stop.
 */
function centeredCoverCrop(
  face: FaceBox,
  srcW: number,
  srcH: number,
  paneAspect: number,
  zoomFactor: number
): PaneRect {
  let h = Math.min(srcH, face.h * srcH * zoomFactor);
  let w = h * paneAspect;
  if (w > srcW) {
    w = srcW;
    h = w / paneAspect;
  }

  const x = Math.max(0, Math.min(face.cx * srcW - w / 2, srcW - w));
  const y = Math.max(0, Math.min(face.cy * srcH - h * FACE_VERTICAL_ANCHOR, srcH - h));
  return { x, y, w, h };
}

/**
 * Blends `out` toward `target` by `alpha` (0-1 per call), in place — lets a
 * pane glide toward a subject's new position between detection ticks
 * instead of snapping, for gentle camera-follow motion within an otherwise
 * stable layout. Deliberately *not* used to decide layout (panes/count) —
 * only to smooth a pane's own crop position once it's already assigned.
 * Mutates `out` (and returns it) rather than allocating a new rect, so the
 * per-frame render loop doesn't churn the GC calling this every frame.
 */
export function lerpPaneRectInto(out: PaneRect, target: PaneRect, alpha: number): PaneRect {
  out.x += (target.x - out.x) * alpha;
  out.y += (target.y - out.y) * alpha;
  out.w += (target.w - out.w) * alpha;
  out.h += (target.h - out.h) * alpha;
  return out;
}

/**
 * Fraction of a face's bounding box that actually lies within the visible
 * frame (0..1) — a box extending past the frame edge (a partially
 * off-camera face) scores below 1 here, even though its *reported* w/h are
 * unaffected. Used to reject truncated detections before they can trigger
 * a split.
 */
export function faceVisibleFraction(face: FaceBox): number {
  const left = face.cx - face.w / 2;
  const right = face.cx + face.w / 2;
  const top = face.cy - face.h / 2;
  const bottom = face.cy + face.h / 2;

  const visibleW = Math.max(0, Math.min(1, right) - Math.max(0, left));
  const visibleH = Math.max(0, Math.min(1, bottom) - Math.max(0, top));
  const totalArea = face.w * face.h;
  return totalArea > 0 ? (visibleW * visibleH) / totalArea : 0;
}

export interface PaneTarget {
  pane: SpeakerPane;
  /** The face this pane's crop is currently keyed to — pass back as `previous` for deadzone comparison on the next call. */
  face: FaceBox;
}

/**
 * Composes a stable speaker layout: 1 face fills the whole frame, 2 stack
 * vertically, 3+ form a grid (as square as possible). Each pane is an
 * independent cover-crop centered on its face, not a shared crop split in
 * half, so each person stays centered in their own pane regardless of where
 * they sit in the frame.
 *
 * `previous` + `deadzone` add a dead zone: a pane's crop only moves if its
 * face has drifted more than `deadzone` (a fraction of frame width/height)
 * from the face that produced the *previous* result for that pane —
 * otherwise the previous pane (same crop, unchanged) is returned as-is, so
 * ordinary small gestures don't reopen the camera's LERP chase. Pass an
 * empty array for `previous` (or omit it) for a fresh, unconditional
 * layout — every pane counts as "moved", which is what a genuine layout
 * change (a new committed face count) wants.
 *
 * Deliberately stateless and cheap to call — callers decide *when* to call
 * it (typically: once, when the face count changes, or at a detection
 * tick) rather than this function deciding how much to trust a detection.
 */
export function computeSpeakerLayout(
  faces: FaceBox[],
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  previous: PaneTarget[] = [],
  deadzone = 0
): PaneTarget[] {
  if (faces.length === 0) return [];

  const zoomFactor = faces.length === 1 ? SINGLE_SPEAKER_ZOOM_FACTOR : MULTI_SPEAKER_ZOOM_FACTOR;

  // Stable left-to-right order so panes don't swap between frames just
  // because detection happened to return faces in a different order.
  const ordered = [...faces].sort((a, b) => a.cx - b.cx);
  const rows = gridRows(ordered.length);
  const rowH = outH / rows.length;

  const results: PaneTarget[] = [];
  let idx = 0;
  rows.forEach((count, rowIdx) => {
    const paneW = outW / count;
    const paneAspect = paneW / rowH;
    for (let col = 0; col < count; col++) {
      const face = ordered[idx];
      const dest: PaneRect = { x: col * paneW, y: rowIdx * rowH, w: paneW, h: rowH };
      const prev = previous[idx];
      const moved = !prev || Math.abs(face.cx - prev.face.cx) > deadzone || Math.abs(face.cy - prev.face.cy) > deadzone;

      results.push(
        moved
          ? { pane: { source: centeredCoverCrop(face, srcW, srcH, paneAspect, zoomFactor), dest }, face }
          : { pane: { source: prev.pane.source, dest }, face: prev.face }
      );
      idx++;
    }
  });

  return results;
}
