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

/** Total memory the frame buffer may use (96 MiB). */
export const FRAME_BUFFER_BUDGET_BYTES = 96 * 1024 * 1024;
const BYTES_PER_PIXEL = 4;
// Slots beyond length × fps: the frame being drawn, the one being captured,
// and one for timing jitter.
const SLOT_HEADROOM = 3;
const MAX_SLOTS = 64;
// Smaller sizes tried, in order, when the source size does not fit.
const FALLBACK_SLOT_HEIGHTS = [1080, 720, 540];

export interface SlotSize {
  width: number;
  height: number;
  /** Slots the lookahead needs at the assumed frame rate and speed. */
  neededSlots: number;
  /** Pool limit: as many as fit the budget (for higher frame rates or speeds), at least neededSlots. */
  maxSlots: number;
  bytesPerSlot: number;
}

/**
 * Picks the largest frame size (source size first, never upscaled) at which
 * the frames the lookahead needs fit FRAME_BUFFER_BUDGET_BYTES.
 */
export function chooseSlotSize(
  srcW: number,
  srcH: number,
  lengthMs: number,
  fps: number,
  playbackRate: number
): SlotSize {
  const neededSlots = Math.ceil((lengthMs / 1000) * fps * Math.max(1, playbackRate)) + SLOT_HEADROOM;
  const heights = [srcH, ...FALLBACK_SLOT_HEIGHTS.filter((h) => h < srcH)];
  const sizeAt = (height: number) => {
    const width = Math.max(2, Math.round((srcW * height) / srcH / 2) * 2);
    return { width, height, bytesPerSlot: width * height * BYTES_PER_PIXEL };
  };
  const fitting = heights.map(sizeAt).find((s) => s.bytesPerSlot * neededSlots <= FRAME_BUFFER_BUDGET_BYTES);
  const size = fitting ?? sizeAt(heights[heights.length - 1]);
  const fitInBudget = Math.floor(FRAME_BUFFER_BUDGET_BYTES / size.bytesPerSlot);
  return {
    ...size,
    neededSlots,
    maxSlots: Math.min(MAX_SLOTS, Math.max(neededSlots, fitInBudget)),
  };
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
