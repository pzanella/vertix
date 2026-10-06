import type { BenchmarkConfig } from "../../core";

export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  wasmWarmupSec: 3,
  clipWarmupSec: 1,
  baseline: true,
};

const MAX_WARMUP_SEC = 60;

function readSeconds(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_WARMUP_SEC) : fallback;
}

/**
 * Benchmark mode is on only with `?bench=1`. Optional parameters:
 * `wasmWarmup` (seconds of unrecorded playback before the suite),
 * `clipWarmup` (recorded-but-excluded seconds at the start of each clip),
 * `baseline=0` (skip the 16:9 baseline run).
 */
export function readBenchmarkConfig(search: string): BenchmarkConfig | null {
  const params = new URLSearchParams(search);
  if (params.get("bench") !== "1") return null;
  return {
    wasmWarmupSec: readSeconds(params, "wasmWarmup", DEFAULT_BENCHMARK_CONFIG.wasmWarmupSec),
    clipWarmupSec: readSeconds(params, "clipWarmup", DEFAULT_BENCHMARK_CONFIG.clipWarmupSec),
    baseline: params.get("baseline") !== "0",
  };
}
