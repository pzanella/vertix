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
// With --aspect, writes instead the non-landscape test clips to public/bench/
// (gitignored, never committed): portrait 9:16, square 1:1, and portrait
// stored as a landscape frame plus rotation metadata (like a phone video).
//
// Usage (needs ffmpeg on PATH): node scripts/make-cut-clips.mjs [--bench | --aspect]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const samplesDir = join(root, "public/samples");
const bench = process.argv.includes("--bench");
const aspect = process.argv.includes("--aspect");
const outDir = join(root, bench || aspect ? "public/bench" : ".eval/cut-clips");

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

// Non-landscape clips from 1-speaker.mp4 (1280x720): `filter` makes the
// frame; `rotation` is display rotation metadata (degrees counter-clockwise).
const ASPECT_CLIPS = [
  { name: "aspect-portrait", description: "portrait 9:16, 720x1280", filter: "crop=405:720,scale=720:1280" },
  { name: "aspect-square", description: "square 1:1, 720x720", filter: "crop=720:720" },
  {
    name: "aspect-rotated",
    description: "portrait 9:16 stored as a 1280x720 frame rotated by metadata (a phone video)",
    filter: "crop=405:720,scale=720:1280,transpose=clock",
    rotation: 90,
  },
];

function ffmpeg(args, name) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg failed on ${name}: ${result.stderr}`);
}

mkdirSync(outDir, { recursive: true });

if (aspect) {
  for (const clip of ASPECT_CLIPS) {
    const output = join(outDir, `${clip.name}.mp4`);
    const encoded = clip.rotation ? join(outDir, `${clip.name}.unrotated.mp4`) : output;
    ffmpeg(
      [
        "-i",
        join(samplesDir, "1-speaker.mp4"),
        "-t",
        "8",
        "-vf",
        `${clip.filter},setsar=1`,
        "-an",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        encoded,
      ],
      clip.name
    );
    if (clip.rotation) {
      // -display_rotation is an input option: remuxed without re-encoding,
      // the rotation is written to the output as metadata.
      ffmpeg(["-display_rotation", String(clip.rotation), "-i", encoded, "-c", "copy", output], clip.name);
      rmSync(encoded);
    }
    console.log(`${clip.name}.mp4 (${clip.description})`);
  }
  process.exit(0);
}

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
