import { describe, expect, it } from "vitest";
import { BENCHMARK_CLIPS } from "../Player/sampleClips";
import {
  CLIP_WARMUP_RANGE,
  DEFAULT_BENCHMARK_CONFIG,
  WASM_WARMUP_RANGE,
  baselineClipIndices,
  clampToRange,
  estimateSuiteSeconds,
} from "./benchmarkConfig";

describe("clampToRange", () => {
  it("keeps in-range values on the step", () => {
    expect(clampToRange(3, WASM_WARMUP_RANGE)).toBe(3);
    expect(clampToRange(1.5, CLIP_WARMUP_RANGE)).toBe(1.5);
  });

  it("snaps to the nearest step", () => {
    expect(clampToRange(1.26, CLIP_WARMUP_RANGE)).toBe(1.5);
    expect(clampToRange(2.4, WASM_WARMUP_RANGE)).toBe(2);
  });

  it("clamps to the range and handles non-finite input", () => {
    expect(clampToRange(-1, WASM_WARMUP_RANGE)).toBe(0);
    expect(clampToRange(99, CLIP_WARMUP_RANGE)).toBe(3);
    expect(clampToRange(NaN, CLIP_WARMUP_RANGE)).toBe(0);
  });
});

describe("estimateSuiteSeconds", () => {
  it("adds the baseline clips only when enabled", () => {
    const withBaseline = estimateSuiteSeconds(DEFAULT_BENCHMARK_CONFIG, false);
    const withoutBaseline = estimateSuiteSeconds({ ...DEFAULT_BENCHMARK_CONFIG, baseline: false }, false);
    const baselineSec = baselineClipIndices(DEFAULT_BENCHMARK_CONFIG).reduce(
      (sum, i) => sum + BENCHMARK_CLIPS[i].durationSec + 1,
      0
    );
    expect(withBaseline - withoutBaseline).toBeCloseTo(baselineSec);
  });

  it("grows with the WASM warm-up", () => {
    const base = estimateSuiteSeconds(DEFAULT_BENCHMARK_CONFIG, false);
    expect(estimateSuiteSeconds({ ...DEFAULT_BENCHMARK_CONFIG, wasmWarmupSec: 5 }, false) - base).toBeCloseTo(2);
  });

  it("runs the 16:9 baseline on the first clip and on the first clip above 30 fps without cuts", () => {
    const indices = baselineClipIndices(DEFAULT_BENCHMARK_CONFIG);
    expect(indices.map((i) => BENCHMARK_CLIPS[i].file)).toEqual(["1-speaker.mp4", "2-speakers-b.mp4"]);
    expect(baselineClipIndices({ ...DEFAULT_BENCHMARK_CONFIG, baseline: false })).toEqual([]);
  });
});
