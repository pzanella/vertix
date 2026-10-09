// Builds test clips with known hard cuts by joining parts of the sample
// clips, for scripts/eval-cuts.mjs and for checking cut handling in the
// browser. The sample clips themselves contain no cuts.
//
// Every part is scaled to 1280x720 at 25 fps without audio. Writes to
// .eval/cut-clips/ (gitignored), with each clip's join times in a .json
// next to it (the ground truth eval-cuts.mjs uses for these clips).
//
// Usage (needs ffmpeg on PATH): node scripts/make-cut-clips.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const samplesDir = join(root, "public/samples");
const outDir = join(root, ".eval/cut-clips");

const CLIPS = [
  {
    name: "cross-count",
    description: "different clips, face count changes at every cut",
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
    parts: [
      ["2-speakers-b.mp4", 1, 5],
      ["2-speakers-c.mp4", 2, 6],
      ["2-speakers-d.mp4", 1, 5],
      ["2-speakers-a.mp4", 8, 12],
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

for (const clip of CLIPS) {
  const inputs = clip.parts.flatMap(([file]) => ["-i", join(samplesDir, file)]);
  const filters = clip.parts.map(
    ([, start, end], i) =>
      `[${i}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=1280:720,fps=25,setsar=1[v${i}]`
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
  const joins = clip.parts.slice(0, -1).map(([, start, end]) => (joinSec += end - start));
  writeFileSync(
    join(outDir, `${clip.name}.json`),
    JSON.stringify({ description: clip.description, joinsSec: joins }, null, 2)
  );
  console.log(`${clip.name}.mp4 (${clip.description}): joins at ${joins.map((t) => `${t.toFixed(2)} s`).join(", ")}`);
}
