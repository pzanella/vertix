// Builds the Rust crate twice with wasm-pack: once with WebAssembly SIMD
// (simd128) and once without (scalar). Both builds come from the same
// source and expose the same JS API; the app picks one at runtime (see
// src/core/wasmBuild.ts).
//
// Each build gets its own Cargo target dir so switching RUSTFLAGS doesn't
// invalidate the other build's cache. After building, each binary is
// parsed with SIMD disabled: the scalar build must parse, the SIMD build
// must not (proof that the feature flag actually took effect). The binary
// sizes are written to src/core/wasm/buildInfo.json for the benchmark.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initWabt from "wabt";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = join(root, "wasm");
const outRoot = join(root, "src/core/wasm");

const VARIANTS = [
  { name: "simd", rustflags: "-C target-feature=+simd128", expectsSimd: true },
  { name: "scalar", rustflags: "", expectsSimd: false },
];

for (const variant of VARIANTS) {
  console.log(`\n[build-wasm] Building the ${variant.name} variant`);
  execFileSync(
    "wasm-pack",
    ["build", "--release", "--target", "web", "--out-dir", join(outRoot, variant.name), "--no-pack"],
    {
      cwd: crateDir,
      stdio: "inherit",
      env: {
        ...process.env,
        RUSTFLAGS: variant.rustflags,
        CARGO_TARGET_DIR: join(crateDir, "target", variant.name),
      },
    }
  );
}

const wabt = await initWabt();

// rustc's default wasm32 features (bulk memory, multi-value, ...) stay
// enabled so only SIMD can make the scalar build fail to parse.
const FEATURES_WITHOUT_SIMD = {
  mutable_globals: true,
  sat_float_to_int: true,
  sign_extension: true,
  multi_value: true,
  bulk_memory: true,
  reference_types: true,
  simd: false,
  relaxed_simd: false,
};

function parsesWithoutSimd(bytes) {
  try {
    const module = wabt.readWasm(bytes, { check: true, ...FEATURES_WITHOUT_SIMD });
    module.validate();
    module.destroy();
    return true;
  } catch {
    return false;
  }
}

const binarySizes = {};
for (const variant of VARIANTS) {
  const wasmPath = join(outRoot, variant.name, "wasm_bg.wasm");
  const containsSimd = !parsesWithoutSimd(readFileSync(wasmPath));
  if (containsSimd !== variant.expectsSimd) {
    console.error(
      `[build-wasm] The ${variant.name} build ${containsSimd ? "contains" : "does not contain"} SIMD instructions, expected the opposite.`
    );
    process.exit(1);
  }
  binarySizes[variant.name] = statSync(wasmPath).size;
}

writeFileSync(join(outRoot, "buildInfo.json"), `${JSON.stringify({ binarySizes }, null, 2)}\n`);
console.log("\n[build-wasm] Binary sizes (bytes):", binarySizes);
