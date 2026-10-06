import { describe, expect, it } from "vitest";
import { DEFAULT_BENCHMARK_CONFIG, readBenchmarkConfig } from "./benchmarkConfig";

describe("readBenchmarkConfig", () => {
  it("is off without bench=1", () => {
    expect(readBenchmarkConfig("")).toBeNull();
    expect(readBenchmarkConfig("?bench=0")).toBeNull();
    expect(readBenchmarkConfig("?bench=true")).toBeNull();
  });

  it("uses defaults with bench=1 only", () => {
    expect(readBenchmarkConfig("?bench=1")).toEqual(DEFAULT_BENCHMARK_CONFIG);
  });

  it("reads warm-up and baseline overrides", () => {
    expect(readBenchmarkConfig("?bench=1&wasmWarmup=5&clipWarmup=0&baseline=0")).toEqual({
      wasmWarmupSec: 5,
      clipWarmupSec: 0,
      baseline: false,
    });
  });

  it("falls back to defaults for invalid values and caps large ones", () => {
    const config = readBenchmarkConfig("?bench=1&wasmWarmup=-2&clipWarmup=abc");
    expect(config?.wasmWarmupSec).toBe(DEFAULT_BENCHMARK_CONFIG.wasmWarmupSec);
    expect(config?.clipWarmupSec).toBe(DEFAULT_BENCHMARK_CONFIG.clipWarmupSec);
    expect(readBenchmarkConfig("?bench=1&wasmWarmup=999")?.wasmWarmupSec).toBe(60);
  });
});
