// Builds a clip for checking audio/video sync by eye and ear: 20 s of
// black, 1280x720 at 25 fps, with a white frame and a 1 kHz beep of the
// same length (40 ms) at the start of every second. Played with lookahead
// on, every flash must land on its beep. No faces, so the app shows the
// whole frame (no crop).
//
// Writes .eval/av-sync.mp4 (gitignored). Needs ffmpeg on PATH.
// Usage: node scripts/make-av-sync-clip.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".eval");
const out = join(outDir, "av-sync.mp4");
const DURATION_SEC = 20;
const FPS = 25;
const FLASH_SEC = 1 / FPS;

mkdirSync(outDir, { recursive: true });
const result = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-hide_banner",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=1280x720:r=${FPS}:d=${DURATION_SEC}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=1000:sample_rate=48000:duration=${DURATION_SEC}`,
    "-filter_complex",
    [
      `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),${FLASH_SEC})'[v]`,
      `[1:a]volume=enable='gte(mod(t,1),${FLASH_SEC})':volume=0[a]`,
    ].join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    out,
  ],
  { stdio: "inherit" }
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Wrote ${out}`);
