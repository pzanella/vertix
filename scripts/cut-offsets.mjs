// Signed cut offsets (displayed frames from the source cut to the crop change;
// negative = early, positive = late) from check-lookahead raw output
// (.eval/lookahead-raw-<label>.json, written with --save-raw=<label>).
// Groups the files by the label's prefix before the last "-<n>" (for example
// main-1, main-2 -> main) and prints min / median / max per clip and cut,
// with lookahead on.
//
// Usage: node scripts/cut-offsets.mjs .eval/lookahead-raw-main-1.json .eval/lookahead-raw-branch-1.json ...
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { cutOffsets } from "./lib/cut-offsets.mjs";

const KNOWN_CUTS = {
  "cross-count.mp4": { fps: 25, cuts: [4, 8, 12] },
  "cross-same-count.mp4": { fps: 25, cuts: [4, 8, 12] },
  "cross-offset.mp4": { fps: 25, cuts: [4.08, 8.12, 12.16] },
  "cross-50fps.mp4": { fps: 50, cuts: [4.06, 8.14, 12.18] },
};

const groups = new Map();
for (const file of process.argv.slice(2)) {
  const group = basename(file, ".json")
    .replace(/^lookahead-raw-/, "")
    .replace(/-\d+$/, "");
  for (const run of JSON.parse(readFileSync(file, "utf8"))) {
    const known = KNOWN_CUTS[run.clip];
    if (!known || run.label !== "clips" || !run.lookahead?.enabled) continue;
    for (const cut of cutOffsets(
      known.cuts,
      run.cutsShown,
      known.fps,
      run.displayedMediaTimeSec ?? run.raw.displays.mediaTimeSec
    )) {
      const key = `${group}|${run.clip}|${cut.timeSec}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cut.offsetFrames);
    }
  }
}

const rows = [];
for (const [key, offsets] of groups) {
  const [build, clip, cutSec] = key.split("|");
  const found = offsets.filter((o) => o !== null).sort((a, b) => a - b);
  rows.push({
    build,
    clip,
    "cut s": Number(cutSec),
    rows: offsets.length,
    min: found.length ? found[0] : "-",
    median: found.length ? found[Math.floor(found.length / 2)] : "-",
    max: found.length ? found.at(-1) : "-",
    missed: offsets.length - found.length,
  });
}
rows.sort((a, b) => a.clip.localeCompare(b.clip) || a["cut s"] - b["cut s"] || a.build.localeCompare(b.build));
console.table(rows);
