import buildInfo from "./wasm/buildInfo.json";

/**
 * The detector ships as two WASM builds of the same Rust crate with the same
 * JS API: one compiled with WebAssembly SIMD (simd128), one without
 * (scalar). See scripts/build-wasm.mjs. Only the selected build is ever
 * downloaded.
 */
export type WasmBuildVariant = "simd" | "scalar";

/**
 * Why a build is in use: `supported` / `not-supported` is the automatic
 * choice from the SIMD probe below; `benchmark-suite` means the benchmark
 * suite switched to it explicitly for its A/B comparison.
 */
export type WasmBuildReason = "supported" | "not-supported" | "benchmark-suite";

export interface WasmBuildSelection {
  variant: WasmBuildVariant;
  reason: WasmBuildReason;
}

export type WasmBindings = typeof import("./wasm/simd/wasm.js");

/** Size in bytes of each .wasm binary, recorded at build time. */
export const WASM_BINARY_SIZES: Record<WasmBuildVariant, number> = buildInfo.binarySizes;

// i32.const 0; i8x16.splat; i8x16.popcnt; drop — a module that only
// validates if the engine supports the SIMD proposal (same probe as the
// wasm-feature-detect library).
const SIMD_PROBE_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function isWasmSimdSupported(): boolean {
  try {
    return typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE_MODULE);
  } catch {
    return false;
  }
}

export function defaultWasmBuild(): WasmBuildSelection {
  return isWasmSimdSupported()
    ? { variant: "simd", reason: "supported" }
    : { variant: "scalar", reason: "not-supported" };
}

/** Separate dynamic imports so the bundler emits each build as its own chunk and only the requested one is fetched. */
export function importWasmBindings(variant: WasmBuildVariant): Promise<WasmBindings> {
  return variant === "simd" ? import("./wasm/simd/wasm.js") : import("./wasm/scalar/wasm.js");
}
