import { buildSuitePlan, type BenchmarkConfig, type SuiteStep } from "../../core";
import { SAMPLE_CLIPS } from "../Player/sampleClips";

export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  wasmWarmupSec: 3,
  clipWarmupSec: 1,
  baseline: true,
};

export interface SecondsRange {
  min: number;
  max: number;
  step: number;
}

export const WASM_WARMUP_RANGE: SecondsRange = { min: 0, max: 10, step: 1 };
export const CLIP_WARMUP_RANGE: SecondsRange = { min: 0, max: 3, step: 0.5 };

// Idle gap between clips so teardown of the previous source (decoder,
// Shaka, GC) does not land inside the next clip's measurements.
export const SETTLE_BETWEEN_CLIPS_MS = 1000;

/** Snaps `value` to the range's step and clamps it into the range. */
export function clampToRange(value: number, { min, max, step }: SecondsRange): number {
  if (!Number.isFinite(value)) return min;
  const snapped = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, Number(snapped.toFixed(3))));
}

/** The suite's stages on this device: with SIMD, every clip runs once per WASM build. */
export function suiteStageKinds(config: BenchmarkConfig, simdSupported: boolean): SuiteStep["kind"][] {
  return buildSuitePlan(SAMPLE_CLIPS.length, config.baseline, simdSupported).map((step) => step.kind);
}

/** Rough wall-clock length of a full suite: every warm-up, every clip run at 1× plus settle gaps, and the optional baseline. */
export function estimateSuiteSeconds(config: BenchmarkConfig, simdSupported: boolean): number {
  const settleSec = SETTLE_BETWEEN_CLIPS_MS / 1000;
  return buildSuitePlan(SAMPLE_CLIPS.length, config.baseline, simdSupported).reduce(
    (sum, step) =>
      sum + (step.kind === "warmup" ? config.wasmWarmupSec : SAMPLE_CLIPS[step.clipIndex].durationSec + settleSec),
    0
  );
}
