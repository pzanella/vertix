// Bundles the face-detection and cut-trigger workers (library) and the face
// mesh demo worker (app) with esbuild into public/workers/, served as plain
// static files in both dev and prod, and copies the face mesh WASM from
// @mediapipe/tasks-vision into public/face-mesh/.
// Vite's own worker bundling hung indefinitely for the detection worker for reasons that never
// produced an error — see README.md's Known Limitations.
//
// Run after `npm run build:wasm` (needs src/core/wasm/ to already exist).
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmDir = join(root, "src/core/wasm");
const outDir = join(root, "public/workers");

const WASM_BUILDS = ["simd", "scalar"];

if (!WASM_BUILDS.every((build) => existsSync(join(wasmDir, build, "wasm_bg.wasm")))) {
  console.error("public/workers build skipped: src/core/wasm/ doesn't exist yet — run `npm run build:wasm` first.");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: {
    faceDetectionWorker: join(root, "src/core/faceDetectionWorker.ts"),
    cutTriggerWorker: join(root, "src/core/cutTriggerWorker.ts"),
  },
  bundle: true,
  // Classic script, not ESM — needs less from the browser than
  // `new Worker(url, {type: "module"})`. Because of that, the wasm-bindgen
  // bindings' default `import.meta.url` resolution doesn't work here, so
  // faceDetectionWorker.ts passes initWasm() an explicit URL instead.
  // esbuild still warns about that unused branch (empty-import-meta),
  // silenced below.
  format: "iife",
  platform: "browser",
  target: "es2022",
  outdir: outDir,
  logLevel: "info",
  logOverride: { "empty-import-meta": "silent" },
});

// The bundled worker resolves the selected .wasm binary next to itself at
// runtime (faceDetectionWorker.ts passes initWasm() an explicit
// same-directory URL) — esbuild doesn't do anything with that reference
// (it's a runtime string, not a static import), so both binaries have to
// actually sit next to the bundled worker file for that URL to resolve.
// The worker only fetches the one it was told to load.
for (const build of WASM_BUILDS) {
  copyFileSync(join(wasmDir, build, "wasm_bg.wasm"), join(outDir, `wasm_${build}_bg.wasm`));
}

// The "Face mesh" demo worker. Kept out of the library build above; its
// Apache-2.0 license comments stay in the bundle.
await build({
  entryPoints: { faceMeshWorker: join(root, "src/features/faceMesh/faceMeshWorker.ts") },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outdir: outDir,
  legalComments: "eof",
  logLevel: "info",
  logOverride: { "empty-import-meta": "silent" },
});

const tasksVisionWasmDir = join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const faceMeshDir = join(root, "public/face-mesh");
for (const file of [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
]) {
  copyFileSync(join(tasksVisionWasmDir, file), join(faceMeshDir, file));
}

console.log("Worker bundles + both wasm binaries written to public/workers/, face mesh WASM to public/face-mesh/");
