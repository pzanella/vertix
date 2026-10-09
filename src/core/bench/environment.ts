import {
  defaultWasmBuild,
  isWasmSimdSupported,
  WASM_BINARY_SIZES,
  type WasmBuildReason,
  type WasmBuildVariant,
} from "../wasmBuild";

export interface BenchmarkEnvironment {
  collectedAt: string;
  pageUrl: string;
  userAgent: string;
  hardwareConcurrency: number | null;
  /** navigator.deviceMemory (GB, rounded and capped by the browser). Chromium only. */
  deviceMemoryGb: number | null;
  screen: { width: number; height: number };
  devicePixelRatio: number;
  crossOriginIsolated: boolean;
  /** Whether this browser can run WebAssembly SIMD. */
  wasmSimdSupported: boolean;
  /**
   * Kept from schema v2. Since v3 there are two builds; this is true when the
   * build this device loads by default is the SIMD one. Each result's
   * `wasmBuild` says which build that run actually used.
   */
  wasmBuiltWithSimd: boolean;
  /** The build this device loads outside the benchmark, and why. Schema v3. */
  wasmBuild: { defaultVariant: WasmBuildVariant; defaultReason: WasmBuildReason };
  /** Size in bytes of each .wasm binary. Schema v3. */
  wasmBinarySizes: Record<WasmBuildVariant, number>;
  requestVideoFrameCallbackSupported: boolean;
  longTasksSupported: boolean;
  /** Smallest observed non-zero step of performance.now(), in ms. */
  timerResolutionMs: number | null;
}

const TIMER_PROBE_SAMPLES = 50;
const TIMER_PROBE_MAX_SPINS = 1_000_000;

/** Busy-waits for performance.now() to tick, a few dozen times, and keeps the smallest step. Takes a few ms at most. */
export function measureTimerResolutionMs(): number | null {
  let smallest = Infinity;
  for (let sample = 0; sample < TIMER_PROBE_SAMPLES; sample++) {
    const start = performance.now();
    let next = start;
    for (let spin = 0; spin < TIMER_PROBE_MAX_SPINS && next === start; spin++) next = performance.now();
    const step = next - start;
    if (step > 0 && step < smallest) smallest = step;
  }
  return Number.isFinite(smallest) ? smallest : null;
}

export function collectBenchmarkEnvironment(): BenchmarkEnvironment {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const defaultBuild = defaultWasmBuild();
  return {
    collectedAt: new Date().toISOString(),
    pageUrl: location.href,
    userAgent: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height },
    devicePixelRatio: window.devicePixelRatio,
    crossOriginIsolated: window.crossOriginIsolated === true,
    wasmSimdSupported: isWasmSimdSupported(),
    wasmBuiltWithSimd: defaultBuild.variant === "simd",
    wasmBuild: { defaultVariant: defaultBuild.variant, defaultReason: defaultBuild.reason },
    wasmBinarySizes: { ...WASM_BINARY_SIZES },
    requestVideoFrameCallbackSupported: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
    longTasksSupported: PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false,
    timerResolutionMs: measureTimerResolutionMs(),
  };
}
