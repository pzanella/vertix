import type { BenchmarkConfig } from "../../core";
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

/** Rough wall-clock length of a full suite: warm-up, every clip at 1× plus settle gaps, and the optional baseline. */
export function estimateSuiteSeconds(config: BenchmarkConfig): number {
  const settleSec = SETTLE_BETWEEN_CLIPS_MS / 1000;
  const clipsSec = SAMPLE_CLIPS.reduce((sum, clip) => sum + clip.durationSec + settleSec, 0);
  const baselineSec = config.baseline ? SAMPLE_CLIPS[0].durationSec + settleSec : 0;
  return config.wasmWarmupSec + clipsSec + baselineSec;
}
