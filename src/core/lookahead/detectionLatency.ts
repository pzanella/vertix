import type { WasmBuildVariant } from "../wasmBuild";
import { RollingP95 } from "./lookaheadSizing";

/**
 * A new detector (worker or main-thread WASM instance) is slow for its
 * first detections: WASM instantiation, the model's first run, JIT tiering.
 * Detections within this time or count after it became ready are warm-up
 * and never feed the lookahead length.
 */
export const DETECTION_WARMUP_MS = 2000;
export const DETECTION_WARMUP_COUNT = 5;
/** Warm samples needed before the measured p95 replaces the stored or default one. */
export const MIN_WARM_SAMPLES = 10;

/** Detection round trips per WASM build, without warm-up detections. */
export class DetectionLatencyTracker {
  private readonly perBuild = new Map<WasmBuildVariant, RollingP95>();

  /**
   * Records one round trip of `build`'s detector, taken `msSinceReady` after
   * that detector reported ready, as its `detectionIndex`-th detection
   * (1-based). Returns whether it was kept.
   */
  record(build: WasmBuildVariant, latencyMs: number, msSinceReady: number, detectionIndex: number): boolean {
    if (msSinceReady < DETECTION_WARMUP_MS || detectionIndex <= DETECTION_WARMUP_COUNT) return false;
    let samples = this.perBuild.get(build);
    if (!samples) {
      samples = new RollingP95();
      this.perBuild.set(build, samples);
    }
    samples.push(latencyMs);
    return true;
  }

  /** p95 of `build`'s warm round trips, or null with fewer than MIN_WARM_SAMPLES. */
  p95(build: WasmBuildVariant): number | null {
    return this.perBuild.get(build)?.p95(MIN_WARM_SAMPLES) ?? null;
  }

  warmSamples(build: WasmBuildVariant): number {
    return this.perBuild.get(build)?.count ?? 0;
  }
}
