// Builds test clips with known hard cuts by joining parts of the sample
// clips, for scripts/eval-cuts.mjs and for checking cut handling in the
// browser. The sample clips themselves contain no cuts.
//
// Every part is scaled to 1280x720 at 25 fps (50 fps for clips that say so)
// without audio. Writes to
// .eval/cut-clips/ (gitignored), with each clip's join times in a .json
// next to it (the ground truth eval-cuts.mjs uses for these clips).
// With --bench (`npm run make:bench-clips`), writes only the clips the
// benchmark suite plays, to public/bench/ (gitignored; the deploy workflow
// runs this so they are on GitHub Pages). Their join times are also in
// src/components/Player/sampleClips.ts.
//
// Usage (needs ffmpeg on PATH): node scripts/make-cut-clips.mjs [--bench]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const samplesDir = join(root, "public/samples");
const bench = process.argv.includes("--bench");
const outDir = join(root, bench ? "public/bench" : ".eval/cut-clips");

const CLIPS = [
  {
    name: "cross-count",
    description: "different clips, face count changes at every cut",
    benchmark: true,
    parts: [
      ["1-speaker.mp4", 2, 6],
      ["2-speakers-a.mp4", 3, 7],
      ["3-speakers.mp4", 2, 6],
      ["1-speaker.mp4", 20, 24],
    ],
  },
  {
    name: "cross-same-count",
    description: "different clips, two faces in every part",
    benchmark: true,
    parts: [
      ["2-speakers-b.mp4", 1, 5],
      ["2-speakers-c.mp4", 2, 6],
      ["2-speakers-d.mp4", 1, 5],
      ["2-speakers-a.mp4", 8, 12],
    ],
  },
  {
    name: "cross-offset",
    description: "like cross-count, with cuts between detection frames (frames 102, 203, 304)",
    benchmark: true,
    parts: [
      ["1-speaker.mp4", 2, 6.08],
      ["2-speakers-a.mp4", 3, 7.04],
      ["3-speakers.mp4", 2, 6.04],
      ["1-speaker.mp4", 20, 24],
    ],
  },
  {
    name: "cross-50fps",
    description:
      "50 fps, cuts between detection frames on odd frames (203, 407, 609), some on frames the half-rate cut trigger skips",
    benchmark: true,
    fps: 50,
    parts: [
      ["2-speakers-b.mp4", 1, 5.06],
      ["1-speaker.mp4", 2, 6.08],
      ["3-speakers.mp4", 2, 6.04],
      ["2-speakers-a.mp4", 3, 7],
    ],
  },
  {
    name: "same-clip",
    description: "two parts of one clip far apart in time (same people, same room)",
    parts: [
      ["2-speakers-a.mp4", 0.5, 6],
      ["2-speakers-a.mp4", 11, 16.4],
    ],
  },
];

mkdirSync(outDir, { recursive: true });

for (const clip of CLIPS.filter((c) => !bench || c.benchmark)) {
  const inputs = clip.parts.flatMap(([file]) => ["-i", join(samplesDir, file)]);
  const filters = clip.parts.map(
    ([, start, end], i) =>
      `[${i}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=1280:720,fps=${clip.fps ?? 25},setsar=1[v${i}]`
  );
  const concatInputs = clip.parts.map((_, i) => `[v${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${clip.parts.length}:v=1:a=0[out]`);
  const output = join(outDir, `${clip.name}.mp4`);
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      output,
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed on ${clip.name}: ${result.stderr}`);

  let joinSec = 0;
  const joins = clip.parts
    .slice(0, -1)
    .map(([, start, end]) => (joinSec = Math.round((joinSec + end - start) * 1000) / 1000));
  writeFileSync(
    join(outDir, `${clip.name}.json`),
    JSON.stringify({ description: clip.description, joinsSec: joins }, null, 2)
  );
  console.log(`${clip.name}.mp4 (${clip.description}): joins at ${joins.map((t) => `${t.toFixed(2)} s`).join(", ")}`);
}
