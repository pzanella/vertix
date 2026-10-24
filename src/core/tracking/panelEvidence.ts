/**
 * Evidence that 2+ faces are a panel (a still group, such as an interview),
 * and the seats of that panel. A panel is still: its faces hold their place
 * from one detection to the next. A crowd moves. Multi-pane layouts are shown
 * only with this evidence; without it the whole frame is shown.
 *
 * A seat is a pane's place in the panel. It outlives its track: a face that
 * goes missing keeps its seat for MULTIPANE_HOLD_SEC, and a new confirmed
 * face at the same place takes the seat over (a face lost on profile comes
 * back with a new track ID).
 */

// The panel is entered after this long of consecutive still pairs.
export const PANEL_STILL_SEC = 1;
// The panel is left after this long of consecutive moving pairs (one moving
// pair, such as a head turn, does not drop it).
export const PANEL_EXIT_SEC = 0.6;
// 3+ faces: a pair is still when its median track shift is at most this many
// face heights. Panels measured at most 0.024; the crowd in licensed clip B (4-6 s) moved
// at least 0.025 in every pair it had.
export const PANEL_MAX_SHIFT_HEIGHTS = 0.04;
// 2 faces: a pair is still when the mean of the two shifts is at most this.
// 2-speakers-b (people talking with their hands) held still runs of 18 pairs
// at this value; the crowd in licensed clip B (0-17 s) at most 2.
export const PANEL_MAX_SHIFT_HEIGHTS_2 = 0.08;
// A seat whose face goes missing keeps its pane this long: above the longest
// gap measured on licensed clip C (2.2 s).
export const MULTIPANE_HOLD_SEC = 2.5;
// A new confirmed face takes over a held seat when its centre is within this
// many of the seat's face widths (and heights) of the seat.
const SEAT_TAKEOVER_SIZES = 1;
const TIME_EPSILON_SEC = 1e-3;

/** A confirmed foreground track: centre and size as fractions of the frame, and whether the latest detection matched it. */
export interface PanelFace {
  id: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  visible: boolean;
}

/** One pane's place in the panel; `held` while its face is missing. */
export interface PanelSeat {
  trackId: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  held: boolean;
}

export interface PanelState {
  evidence: boolean;
  /** The seats in pane order (left to right when the panel formed); empty without evidence. */
  seats: PanelSeat[];
}

interface Pose {
  cx: number;
  cy: number;
  h: number;
}

interface Seat {
  trackId: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  lastSeenSec: number;
}

const NO_PANEL: PanelState = { evidence: false, seats: [] };

/** The stillness threshold for a pair of `faceCount` faces. */
export function panelShiftThreshold(faceCount: number): number {
  return faceCount === 2 ? PANEL_MAX_SHIFT_HEIGHTS_2 : PANEL_MAX_SHIFT_HEIGHTS;
}

function shiftHeights(face: Pose, before: Pose): number {
  return Math.max(Math.abs(face.cx - before.cx), Math.abs(face.cy - before.cy)) / Math.max(face.h, before.h, 1e-6);
}

/**
 * How much the faces matched to the previous detection moved, in face
 * heights (the largest of the x and y shift per face): the mean for two
 * faces, the median for three or more; null with fewer than two matches.
 */
export function panelPairShift(
  faces: readonly (Pose & { id: number })[],
  previous: ReadonlyMap<number, Pose>
): number | null {
  const shifts: number[] = [];
  for (const face of faces) {
    const before = previous.get(face.id);
    if (before) shifts.push(shiftHeights(face, before));
  }
  if (shifts.length < 2) return null;
  if (shifts.length === 2) return (shifts[0] + shifts[1]) / 2;
  shifts.sort((a, b) => a - b);
  return shifts[Math.floor(shifts.length / 2)];
}

/**
 * Follows the confirmed foreground faces, in media time, one detection pair
 * at a time. Entry: the visible faces still for PANEL_STILL_SEC (the run
 * restarts when the set of faces changes). Exit: PANEL_EXIT_SEC of
 * consecutive moving pairs of the seated faces, a cut, or fewer than two
 * seats. A new face joins as a seat only once it has itself been still for
 * PANEL_STILL_SEC.
 */
export class PanelEvidence {
  private previous = new Map<number, Pose>();
  private evidence = false;
  private seats: Seat[] = [];
  private entryKey = "";
  private stillSinceSec: number | null = null;
  private movingSinceSec: number | null = null;
  private readonly joiningSinceSec = new Map<number, number>();

  observe(faces: readonly PanelFace[], atSec: number, cut: boolean): PanelState {
    if (cut) this.reset();
    const visible = faces.filter((face) => face.visible);
    if (this.evidence) this.followSeats(visible, atSec);
    else this.tryEnter(visible, atSec);
    this.previous = new Map(visible.map((face) => [face.id, { cx: face.cx, cy: face.cy, h: face.h }]));
    if (!this.evidence) return NO_PANEL;
    return {
      evidence: true,
      seats: this.seats.map((seat) => ({
        trackId: seat.trackId,
        cx: seat.cx,
        cy: seat.cy,
        w: seat.w,
        h: seat.h,
        held: seat.lastSeenSec < atSec - TIME_EPSILON_SEC,
      })),
    };
  }

  reset(): void {
    this.previous = new Map();
    this.leave();
  }

  private tryEnter(visible: readonly PanelFace[], atSec: number): void {
    const key = visible
      .map((face) => face.id)
      .sort((a, b) => a - b)
      .join(",");
    if (key !== this.entryKey) {
      this.entryKey = key;
      this.stillSinceSec = null;
    }
    const shift = panelPairShift(visible, this.previous);
    if (shift === null || shift > panelShiftThreshold(visible.length)) {
      this.stillSinceSec = null;
      return;
    }
    this.stillSinceSec ??= atSec;
    if (atSec - this.stillSinceSec < PANEL_STILL_SEC - TIME_EPSILON_SEC) return;
    this.evidence = true;
    this.movingSinceSec = null;
    this.seats = [...visible].sort((a, b) => a.cx - b.cx).map((face) => toSeat(face, atSec));
  }

  private followSeats(visible: readonly PanelFace[], atSec: number): void {
    const seated = new Set<number>();
    for (const seat of this.seats) {
      const face = visible.find((candidate) => candidate.id === seat.trackId);
      if (face) {
        moveSeat(seat, face, atSec);
        seated.add(face.id);
      }
    }
    for (const seat of this.seats) {
      if (seated.has(seat.trackId)) continue;
      const taker = visible.find((face) => !seated.has(face.id) && !this.isSeated(face.id) && nearSeat(face, seat));
      if (taker) {
        seat.trackId = taker.id;
        moveSeat(seat, taker, atSec);
        seated.add(taker.id);
      }
    }
    this.seats = this.seats.filter((seat) => atSec - seat.lastSeenSec <= MULTIPANE_HOLD_SEC + TIME_EPSILON_SEC);
    this.admitJoiners(visible, seated, atSec);

    const seatedFaces = visible.filter((face) => seated.has(face.id));
    const shift = panelPairShift(seatedFaces, this.previous);
    if (shift === null || shift <= panelShiftThreshold(seatedFaces.length)) {
      this.movingSinceSec = null;
    } else {
      this.movingSinceSec ??= atSec;
      if (atSec - this.movingSinceSec >= PANEL_EXIT_SEC - TIME_EPSILON_SEC) this.leave();
    }
    if (this.seats.length < 2) this.leave();
  }

  /** A visible face without a seat becomes one once it has been still on its own for PANEL_STILL_SEC. */
  private admitJoiners(visible: readonly PanelFace[], seated: ReadonlySet<number>, atSec: number): void {
    const present = new Set<number>();
    for (const face of visible) {
      if (seated.has(face.id) || this.isSeated(face.id)) continue;
      present.add(face.id);
      const before = this.previous.get(face.id);
      if (!before || shiftHeights(face, before) > PANEL_MAX_SHIFT_HEIGHTS) {
        this.joiningSinceSec.delete(face.id);
        continue;
      }
      const since = this.joiningSinceSec.get(face.id) ?? atSec;
      this.joiningSinceSec.set(face.id, since);
      if (atSec - since >= PANEL_STILL_SEC - TIME_EPSILON_SEC) {
        const index = this.seats.findIndex((seat) => seat.cx > face.cx);
        this.seats.splice(index < 0 ? this.seats.length : index, 0, toSeat(face, atSec));
        this.joiningSinceSec.delete(face.id);
      }
    }
    for (const id of [...this.joiningSinceSec.keys()]) if (!present.has(id)) this.joiningSinceSec.delete(id);
  }

  private isSeated(trackId: number): boolean {
    return this.seats.some((seat) => seat.trackId === trackId);
  }

  private leave(): void {
    this.evidence = false;
    this.seats = [];
    this.entryKey = "";
    this.stillSinceSec = null;
    this.movingSinceSec = null;
    this.joiningSinceSec.clear();
  }
}

function toSeat(face: PanelFace, atSec: number): Seat {
  return { trackId: face.id, cx: face.cx, cy: face.cy, w: face.w, h: face.h, lastSeenSec: atSec };
}

function moveSeat(seat: Seat, face: PanelFace, atSec: number): void {
  seat.cx = face.cx;
  seat.cy = face.cy;
  seat.w = face.w;
  seat.h = face.h;
  seat.lastSeenSec = atSec;
}

function nearSeat(face: PanelFace, seat: Seat): boolean {
  return (
    Math.abs(face.cx - seat.cx) <= seat.w * SEAT_TAKEOVER_SIZES &&
    Math.abs(face.cy - seat.cy) <= seat.h * SEAT_TAKEOVER_SIZES
  );
}
