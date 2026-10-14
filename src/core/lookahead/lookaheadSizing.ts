import type { WasmBuildVariant } from "../wasmBuild";

export type DeviceClass = "desktop" | "mobile";

/**
 * Detection round-trip p95 (frame dispatched → result processed) used until
 * this device has measured its own. Measured on GitHub Pages, October 2026:
 * desktop ~45-60 ms SIMD / ~73-78 ms scalar, an Android phone ~100-120 ms
 * SIMD / ~190-220 ms scalar.
 */
export const DEFAULT_DETECTION_P95_MS: Record<DeviceClass, Record<WasmBuildVariant, number>> = {
  desktop: { simd: 60, scalar: 78 },
  mobile: { simd: 120, scalar: 220 },
};

/** Per-frame cut trigger (thumbnail → worker → verdict) p95 used until measured. */
export const DEFAULT_TRIGGER_P95_MS = 10;
export const DEFAULT_FRAME_INTERVAL_MS = 40;
/** Until the frame rate is measured (or hinted), the pool may hold frames for up to this rate. */
export const ASSUMED_MAX_FPS = 60;

export const MIN_LOOKAHEAD_MS = 120;
export const MAX_LOOKAHEAD_MS = 600;

/**
 * How far behind the decoded frame the output is shown. A cut frame's
 * decision needs: the trigger verdict, possibly waiting for a detection
 * already running on another frame, then its own detection — hence 2× the
 * detection time — plus one frame of margin for display timing.
 */
export function lookaheadLengthMs(detectionP95Ms: number, triggerP95Ms: number, frameIntervalMs: number): number {
  const needed = triggerP95Ms + 2 * detectionP95Ms + frameIntervalMs;
  return Math.round(Math.min(MAX_LOOKAHEAD_MS, Math.max(MIN_LOOKAHEAD_MS, needed)));
}

export function detectDeviceClass(): DeviceClass {
  if (typeof navigator === "undefined") return "desktop";
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return coarse && navigator.maxTouchPoints > 0 ? "mobile" : "desktop";
}

export interface FrameAlignedDelay {
  /** Whole frames of delay. */
  frames: number;
  /** frames × the frame interval in wall time. */
  lengthMs: number;
}

/**
 * Rounds a lookahead length up to whole frames (down if that would pass
 * MAX_LOOKAHEAD_MS), so each displayed frame is exactly the one decoded
 * `frames` frames earlier and appears together with a decoded frame.
 */
export function alignToFrames(
  lengthMs: number,
  frameIntervalMediaSec: number,
  playbackRate: number
): FrameAlignedDelay {
  const frameWallMs = (frameIntervalMediaSec * 1000) / (playbackRate || 1);
  let frames = Math.max(1, Math.ceil(lengthMs / frameWallMs - 1e-6));
  if (frames * frameWallMs > MAX_LOOKAHEAD_MS + 1e-6) frames = Math.max(1, Math.floor(MAX_LOOKAHEAD_MS / frameWallMs));
  return { frames, lengthMs: frames * frameWallMs };
}

/** Total memory the frame buffer may use (96 MiB). */
export const FRAME_BUFFER_BUDGET_BYTES = 96 * 1024 * 1024;
export const BYTES_PER_PIXEL = 4;
const MAX_SLOTS = 64;
// Smaller sizes tried, in order, when the source size does not fit.
const FALLBACK_SLOT_HEIGHTS = [1080, 720, 540];
/**
 * A crop never shows more than this many source pixels per output pixel of
 * height: a two-speaker pane shows about a third of the source height in
 * half the output height (1.5x); a single-speaker crop shows less.
 */
export const DISPLAY_CAP_FACTOR = 1.5;

/** Slots for a delay of `delayFrames` frames: those frames, the frame being captured, and one spare for a late callback. */
export function slotsForDelay(delayFrames: number): number {
  return delayFrames + 2;
}

export interface SlotSize {
  width: number;
  height: number;
  bytesPerSlot: number;
}

/**
 * The largest frame-copy size, never above the source, never above what
 * the output canvas can show (DISPLAY_CAP_FACTOR × its height on screen in
 * device pixels, when known), at which `neededSlots` copies fit
 * FRAME_BUFFER_BUDGET_BYTES. `maxHeight` caps it further (a reduced
 * copy size while the device struggles).
 */
export function chooseSlotSize(
  srcW: number,
  srcH: number,
  neededSlots: number,
  displayHeightPx: number | null,
  maxHeight: number | null = null
): SlotSize {
  const displayCap = displayHeightPx && displayHeightPx > 0 ? Math.ceil(displayHeightPx * DISPLAY_CAP_FACTOR) : srcH;
  const top = Math.min(srcH, displayCap, maxHeight ?? srcH);
  const heights = [top, ...FALLBACK_SLOT_HEIGHTS.filter((h) => h < top)];
  const sizeAt = (height: number) => {
    const width = Math.max(2, Math.round((srcW * height) / srcH / 2) * 2);
    return { width, height, bytesPerSlot: width * height * BYTES_PER_PIXEL };
  };
  return (
    heights.map(sizeAt).find((s) => s.bytesPerSlot * neededSlots <= FRAME_BUFFER_BUDGET_BYTES) ??
    sizeAt(heights[heights.length - 1])
  );
}

/** Pool limit for `neededSlots` copies of `size`: no more than needed, and no more than the budget holds. */
export function maxSlotsFor(size: SlotSize, neededSlots: number): number {
  return Math.max(1, Math.min(MAX_SLOTS, neededSlots, Math.floor(FRAME_BUFFER_BUDGET_BYTES / size.bytesPerSlot)));
}

/** Rolling sample window for a p95 that adapts to this device. */
export class RollingP95 {
  private readonly samples: number[] = [];

  constructor(private readonly capacity = 60) {}

  get count(): number {
    return this.samples.length;
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.samples.length === this.capacity) this.samples.shift();
    this.samples.push(value);
  }

  /** p95 (nearest rank), or null with fewer than `minSamples` samples. */
  p95(minSamples = 10): number | null {
    if (this.samples.length < minSamples) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  }
}

const STORAGE_PREFIX = "vertix.lookahead.detectionP95Ms.";

/** The detection p95 this device measured in an earlier session for `build`, if any. A per-viewer convenience: absent storage just means defaults. */
export function loadStoredDetectionP95(build: WasmBuildVariant): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_PREFIX + build));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function storeDetectionP95(build: WasmBuildVariant, valueMs: number): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + build, String(Math.round(valueMs)));
  } catch {
    // Private mode or blocked storage: the next session starts from the defaults.
  }
}
