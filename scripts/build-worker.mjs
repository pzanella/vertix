// Bundles the face-detection worker with esbuild into public/workers/,
// served as a plain static file in both dev and prod. Vite's own worker
// bundling hung indefinitely for this file for reasons that never
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

if (!existsSync(join(wasmDir, "wasm_bg.wasm"))) {
  console.error("public/workers build skipped: src/core/wasm/ doesn't exist yet — run `npm run build:wasm` first.");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src/core/faceDetectionWorker.ts")],
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
  outfile: join(outDir, "faceDetectionWorker.js"),
  logLevel: "info",
  logOverride: { "empty-import-meta": "silent" },
});

// The bundled worker still resolves the .wasm binary next to itself at
// runtime (faceDetectionWorker.ts passes initWasm() an explicit
// same-directory URL) — esbuild doesn't do anything with that reference
// (it's a runtime string, not a static import), so the binary has to
// actually sit next to the bundled worker file for that URL to resolve.
copyFileSync(join(wasmDir, "wasm_bg.wasm"), join(outDir, "wasm_bg.wasm"));

console.log("Worker bundle + wasm binary written to public/workers/");
