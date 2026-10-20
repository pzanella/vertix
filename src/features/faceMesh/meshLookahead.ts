import type { DeviceClass } from "../../core";

/** Added to the measured need, for display timing. */
export const MESH_LOOKAHEAD_MARGIN_MS = 30;
/** Measurements of each kind needed before the minimum is set. */
export const MESH_LOOKAHEAD_MIN_SAMPLES = 10;
/** The minimum is only moved when the computed value changes by more than this, so the lookahead does not ramp on noise. */
export const MESH_LOOKAHEAD_HYSTERESIS_MS = 40;
/** Longer gaps between detection frames are a pause or a seek, not a tick interval. */
export const MAX_TICK_INTERVAL_MS = 1000;
const WINDOW = 100;

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * Interpolating the mesh of the frame on screen needs the next tick's mesh
 * before that frame is shown. The frame right after a tick waits longest:
 * the next tick's frame is captured one tick interval later, and its mesh
 * arrives one result age (capture to mesh) after that. Plus one frame and
 * a margin.
 */
export function meshLookaheadMinimumMs(tickIntervalP95Ms: number, resultAgeP95Ms: number, frameIntervalMs: number) {
  return tickIntervalP95Ms + resultAgeP95Ms + frameIntervalMs + MESH_LOOKAHEAD_MARGIN_MS;
}

/** Measures what the demo-only minimum lookahead is made of. */
export class MeshLatency {
  private tickIntervals: number[] = [];
  private resultAges: number[] = [];

  recordTickInterval(ms: number): void {
    if (Number.isFinite(ms) && ms > 0 && ms <= MAX_TICK_INTERVAL_MS) this.push(this.tickIntervals, ms);
  }

  recordResultAge(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.push(this.resultAges, ms);
  }

  reset(): void {
    this.tickIntervals = [];
    this.resultAges = [];
  }

  get tickIntervalP50Ms(): number | null {
    return percentile(this.tickIntervals, 0.5);
  }

  get tickIntervalP95Ms(): number | null {
    return percentile(this.tickIntervals, 0.95);
  }

  get resultAgeP95Ms(): number | null {
    return percentile(this.resultAges, 0.95);
  }

  /** Null on phones (no raise: the mesh steps there) and until enough has been measured. */
  minimumMs(frameIntervalMs: number, device: DeviceClass): number | null {
    if (device === "mobile") return null;
    if (this.tickIntervals.length < MESH_LOOKAHEAD_MIN_SAMPLES || this.resultAges.length < MESH_LOOKAHEAD_MIN_SAMPLES) {
      return null;
    }
    return Math.round(meshLookaheadMinimumMs(this.tickIntervalP95Ms!, this.resultAgeP95Ms!, frameIntervalMs));
  }

  private push(values: number[], value: number): void {
    values.push(value);
    if (values.length > WINDOW) values.shift();
  }
}

/** The minimum to apply now: `next` once it differs from `applied` by more than the hysteresis (or either is null). */
export function nextMinimumMs(applied: number | null, next: number | null): number | null {
  if (applied === null || next === null) return next;
  return Math.abs(next - applied) > MESH_LOOKAHEAD_HYSTERESIS_MS ? next : applied;
}
