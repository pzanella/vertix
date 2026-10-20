// Fails if the library's output mentions the face mesh demo's third-party
// code or assets: the library (src/core) must stay free of MediaPipe. Checks
// the library entry bundled the way a host would bundle it (esbuild,
// minified, so comments do not count) and the library's own workers in
// public/workers/ (run `npm run build:worker` first).
//
// Usage: node scripts/check-library-bundle.mjs
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = [
  "landmark",
  "mediapipe",
  "tasks-vision",
  "face_landmarker",
  "vision_wasm",
  "vision_bundle",
  "face-mesh",
];
const LIBRARY_WORKERS = ["faceDetectionWorker.js", "cutTriggerWorker.js"];

const entry = await build({
  entryPoints: [join(root, "src/core/index.ts")],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  logLevel: "silent",
  outdir: "out",
  loader: { ".wasm": "file" },
  logOverride: { "empty-import-meta": "silent" },
});

const outputs = [
  ...entry.outputFiles
    .filter((file) => file.path.endsWith(".js"))
    .map((file) => ({ name: "library entry (src/core/index.ts)", text: file.text })),
  ...LIBRARY_WORKERS.map((file) => ({
    name: `public/workers/${file}`,
    text: readFileSync(join(root, "public/workers", file), "utf8"),
  })),
];

let failed = false;
for (const { name, text } of outputs) {
  const lower = text.toLowerCase();
  const found = FORBIDDEN.filter((word) => lower.includes(word));
  if (found.length > 0) {
    failed = true;
    console.error(`${name}: contains ${found.map((w) => `"${w}"`).join(", ")}`);
  } else {
    console.log(`${name}: clean (${Math.round(text.length / 1024)} KiB)`);
  }
}
if (failed) process.exit(1);
