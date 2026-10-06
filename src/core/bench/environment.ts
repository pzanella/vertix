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
  /** Whether Vertix's own WASM binary was compiled with SIMD instructions. */
  wasmBuiltWithSimd: boolean;
  requestVideoFrameCallbackSupported: boolean;
  longTasksSupported: boolean;
  /** Smallest observed non-zero step of performance.now(), in ms. */
  timerResolutionMs: number | null;
}

// wasm/Cargo.toml and the build:wasm script do not enable the simd128
// target feature, and rustc does not enable it by default for wasm32.
// Update this when SIMD is turned on.
export const WASM_BUILT_WITH_SIMD = false;

// i32.const 0; i8x16.splat; i8x16.popcnt; drop — a module that only
// validates if the engine supports the SIMD proposal (same probe as the
// wasm-feature-detect library).
const SIMD_PROBE_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

const TIMER_PROBE_SAMPLES = 50;
const TIMER_PROBE_MAX_SPINS = 1_000_000;

export function isWasmSimdSupported(): boolean {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE_MODULE);
  } catch {
    return false;
  }
}

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
    wasmBuiltWithSimd: WASM_BUILT_WITH_SIMD,
    requestVideoFrameCallbackSupported: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
    longTasksSupported: PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false,
    timerResolutionMs: measureTimerResolutionMs(),
  };
}
