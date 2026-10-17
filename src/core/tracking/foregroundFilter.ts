import { faceVisibleFraction } from "../layoutEngine";
import type { FaceTrack } from "./faceTracker";

// A face enters the foreground at this share of the largest visible face's
// area (about 0.59 of its height): a crowd behind a front row is usually at
// most half the front row's height, while two people in an interview stay
// above ~0.6 of each other's height. It leaves below the lower value, so a
// face near the limit does not make the count flicker.
export const FOREGROUND_ENTER_AREA_RATIO = 0.35;
export const FOREGROUND_LEAVE_AREA_RATIO = 0.25;
// Absolute size (max of width, height, as a fraction of the frame): the
// existing speaker-size minimum to enter, a little less to leave.
export const FOREGROUND_ENTER_MIN_SIZE = 0.12;
export const FOREGROUND_LEAVE_MIN_SIZE = 0.1;
// A face must be at least this visible within the frame (not cropped off
// at an edge) to count — see faceVisibleFraction.
const MIN_FACE_VISIBLE_FRACTION = 0.8;

export function trackArea(track: FaceTrack): number {
  return track.box.w * track.box.h;
}

/**
 * Marks which tracks count for the layout. Only tracks matched by the
 * latest detection are judged against each other; a coasting track keeps
 * its flag. Background tracks are kept, they just do not count.
 */
export function updateForeground(tracks: readonly FaceTrack[]): void {
  let largestArea = 0;
  for (const track of tracks) if (track.visible) largestArea = Math.max(largestArea, trackArea(track));

  for (const track of tracks) {
    if (!track.visible) continue;
    const size = Math.max(track.box.w, track.box.h);
    const areaRatio = largestArea > 0 ? trackArea(track) / largestArea : 0;
    const visibleEnough = faceVisibleFraction(track.lastDetection) >= MIN_FACE_VISIBLE_FRACTION;
    track.foreground =
      visibleEnough &&
      (track.foreground
        ? size >= FOREGROUND_LEAVE_MIN_SIZE && areaRatio >= FOREGROUND_LEAVE_AREA_RATIO
        : size >= FOREGROUND_ENTER_MIN_SIZE && areaRatio >= FOREGROUND_ENTER_AREA_RATIO);
  }
}
