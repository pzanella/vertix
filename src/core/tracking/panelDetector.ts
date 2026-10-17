import type { FaceTrack } from "./faceTracker";
import { trackArea } from "./foregroundFilter";

/**
 * How a panel (several people shown as a grid) is recognised:
 * - "evidence" (B): the foreground faces must have been still for
 *   PANEL_EVIDENCE_SEC since the cut or since the set of faces changed.
 * - "until-moved" (A): a panel is assumed from the start and ruled out as
 *   soon as a face moves.
 * B avoids grid -> single right after a cut on a handheld shot.
 */
export type PanelVariant = "evidence" | "until-moved";
export const PANEL_VARIANT: PanelVariant = "evidence";

// Panels are 3 or 4 people; more go to the main-subject rule.
const PANEL_MIN_FACES = 3;
const PANEL_MAX_FACES = 4;
// Similar size: the smallest face has at least this share of the largest one's area.
const PANEL_MIN_AREA_RATIO = 0.5;
// A face "moves" when its centre spans more than this (fraction of frame)
// within PANEL_MOTION_WINDOW_SEC. Moving rules the panel out until the set
// of faces changes or there is a cut.
const PANEL_MAX_DRIFT = 0.04;
const PANEL_MOTION_WINDOW_SEC = 2;
// Variant B: how long the faces must have been still before the grid is used.
export const PANEL_EVIDENCE_SEC = 1.0;

interface PositionSample {
  atSec: number;
  cx: number;
  cy: number;
}

export class PanelDetector {
  private setKey = "";
  private setSinceSec = 0;
  private ruledOut = false;
  private history = new Map<number, PositionSample[]>();

  constructor(private readonly variant: PanelVariant = PANEL_VARIANT) {}

  /** Feeds the foreground tracks of one detection; returns whether they form a panel. */
  observe(foreground: readonly FaceTrack[], atSec: number): boolean {
    const key = foreground
      .map((t) => t.id)
      .sort((a, b) => a - b)
      .join(",");
    if (key !== this.setKey) {
      this.setKey = key;
      this.setSinceSec = atSec;
      this.ruledOut = false;
      this.history.clear();
    }

    for (const track of foreground) {
      const samples = this.history.get(track.id) ?? [];
      samples.push({ atSec, cx: track.box.cx, cy: track.box.cy });
      while (samples.length > 0 && samples[0].atSec < atSec - PANEL_MOTION_WINDOW_SEC) samples.shift();
      this.history.set(track.id, samples);
      if (drift(samples) > PANEL_MAX_DRIFT) this.ruledOut = true;
    }

    if (this.ruledOut || foreground.length < PANEL_MIN_FACES || foreground.length > PANEL_MAX_FACES) return false;
    if (!similarSizes(foreground)) return false;
    return this.variant === "until-moved" || atSec - this.setSinceSec >= PANEL_EVIDENCE_SEC - 1e-3;
  }

  reset(): void {
    this.setKey = "";
    this.ruledOut = false;
    this.history.clear();
  }
}

function drift(samples: readonly PositionSample[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.cx);
    maxX = Math.max(maxX, s.cx);
    minY = Math.min(minY, s.cy);
    maxY = Math.max(maxY, s.cy);
  }
  return samples.length < 2 ? 0 : Math.max(maxX - minX, maxY - minY);
}

function similarSizes(tracks: readonly FaceTrack[]): boolean {
  const areas = tracks.map(trackArea);
  return Math.min(...areas) >= Math.max(...areas) * PANEL_MIN_AREA_RATIO;
}
