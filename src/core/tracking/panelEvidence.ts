/**
 * Evidence that 3+ faces are a panel (a static group), not a crowd. A panel
 * is still: its faces hold their place from one detection to the next. A
 * crowd moves. The grid is shown only with this evidence; without it the
 * whole frame is shown.
 */

// The grid is entered after this long of consecutive still pairs.
export const PANEL_STILL_SEC = 1;
// The grid is left after this long of consecutive moving pairs (one moving
// pair, such as a head turn, does not drop it).
export const PANEL_EXIT_SEC = 0.6;
// A pair is still when its median track shift is at most this many face
// heights. Panels measured at most 0.024; the crowd in licensed clip B (4-6 s) moved
// at least 0.025 in every pair it had.
export const PANEL_MAX_SHIFT_HEIGHTS = 0.04;
// Fewer matched tracks than this give no pair (the median would be noise).
const MIN_PAIR_TRACKS = 3;
const TIME_EPSILON_SEC = 1e-3;

/** A confirmed foreground track as the evidence sees it: centre and height as fractions of the frame. */
export interface PanelFace {
  id: number;
  cx: number;
  cy: number;
  h: number;
}

interface Pose {
  cx: number;
  cy: number;
  h: number;
}

/**
 * The median, over the faces matched to the previous detection, of their
 * largest centre shift in face heights; null without enough matches.
 */
export function panelPairShift(faces: readonly PanelFace[], previous: ReadonlyMap<number, Pose>): number | null {
  const shifts: number[] = [];
  for (const face of faces) {
    const before = previous.get(face.id);
    if (!before) continue;
    shifts.push(
      Math.max(Math.abs(face.cx - before.cx), Math.abs(face.cy - before.cy)) / Math.max(face.h, before.h, 1e-6)
    );
  }
  if (shifts.length < MIN_PAIR_TRACKS) return null;
  shifts.sort((a, b) => a - b);
  return shifts[Math.floor(shifts.length / 2)];
}

/**
 * Tracks the still and moving runs of the confirmed foreground faces, in
 * media time. Each detection is one pair with the previous one. Any break in
 * a run (no pair, a cut, a change of face count) ends it.
 */
export class PanelEvidence {
  private previous = new Map<number, Pose>();
  private previousCount: number | null = null;
  private stillSinceSec: number | null = null;
  private movingSinceSec: number | null = null;
  private evidence = false;

  /** True while the faces are a panel. */
  observe(faces: readonly PanelFace[], atSec: number, cut: boolean): boolean {
    const countChanged = this.previousCount !== null && this.previousCount !== faces.length;
    const shift = cut || countChanged ? null : panelPairShift(faces, this.previous);
    if (cut || countChanged) this.evidence = false;
    this.remember(faces);

    if (shift === null) {
      this.stillSinceSec = null;
      this.movingSinceSec = null;
      return this.evidence;
    }
    if (shift <= PANEL_MAX_SHIFT_HEIGHTS) {
      this.movingSinceSec = null;
      this.stillSinceSec ??= atSec;
      if (atSec - this.stillSinceSec >= PANEL_STILL_SEC - TIME_EPSILON_SEC) this.evidence = true;
    } else {
      this.stillSinceSec = null;
      this.movingSinceSec ??= atSec;
      if (atSec - this.movingSinceSec >= PANEL_EXIT_SEC - TIME_EPSILON_SEC) this.evidence = false;
    }
    return this.evidence;
  }

  reset(): void {
    this.previous = new Map();
    this.previousCount = null;
    this.stillSinceSec = null;
    this.movingSinceSec = null;
    this.evidence = false;
  }

  private remember(faces: readonly PanelFace[]): void {
    this.previous = new Map(faces.map((face) => [face.id, { cx: face.cx, cy: face.cy, h: face.h }]));
    this.previousCount = faces.length;
  }
}
