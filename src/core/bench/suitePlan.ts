import type { WasmBuildSelection, WasmBuildVariant } from "../wasmBuild";

/** Where a run sits in its clip's SIMD/scalar pair. */
export interface WasmBuildRunOrder {
  /** 1 for the first run of this clip, 2 for the second. */
  position: 1 | 2;
  /** Both builds of this clip, in the order they ran. */
  sequence: WasmBuildVariant[];
}

/** The build a result was measured with, why, and (in the A/B suite) its place in the clip's pair. */
export interface BenchmarkWasmBuild extends WasmBuildSelection {
  runOrder: WasmBuildRunOrder | null;
}

export type SuiteStep =
  /** Switch to `build` (a fresh worker), then play the clip's start unrecorded. */
  | { kind: "warmup"; clipIndex: number; build: WasmBuildSelection }
  | { kind: "clip"; clipIndex: number; build: BenchmarkWasmBuild }
  /** 16:9 without detection, so the build does not matter. */
  | { kind: "baseline"; clipIndex: number };

/**
 * Even clips run SIMD then scalar, odd clips scalar then SIMD, so neither
 * build always runs on a hotter device (thermal throttling on phones).
 */
export function wasmBuildSequenceForClip(clipIndex: number): WasmBuildVariant[] {
  return clipIndex % 2 === 0 ? ["simd", "scalar"] : ["scalar", "simd"];
}

/**
 * The full suite: every clip once per build when SIMD is supported (A/B),
 * else once with the scalar build. A warm-up precedes every build switch,
 * which recreates the worker cold.
 */
export function buildSuitePlan(clipCount: number, baseline: boolean, simdSupported: boolean): SuiteStep[] {
  const steps: SuiteStep[] = [];
  let loaded: WasmBuildVariant | null = null;

  const runClip = (clipIndex: number, build: WasmBuildSelection, runOrder: WasmBuildRunOrder | null) => {
    if (build.variant !== loaded) {
      steps.push({ kind: "warmup", clipIndex, build });
      loaded = build.variant;
    }
    steps.push({ kind: "clip", clipIndex, build: { ...build, runOrder } });
  };

  for (let clipIndex = 0; clipIndex < clipCount; clipIndex++) {
    if (!simdSupported) {
      runClip(clipIndex, { variant: "scalar", reason: "not-supported" }, null);
      continue;
    }
    const sequence = wasmBuildSequenceForClip(clipIndex);
    sequence.forEach((variant, index) =>
      runClip(clipIndex, { variant, reason: "benchmark-suite" }, { position: index === 0 ? 1 : 2, sequence })
    );
  }

  if (baseline && clipCount > 0) steps.push({ kind: "baseline", clipIndex: 0 });
  return steps;
}
