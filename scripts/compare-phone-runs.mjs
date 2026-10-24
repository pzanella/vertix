// Compares phone benchmark reports of main and the branch, run alternately:
// .eval/bench-phone-main-<n>.json and .eval/bench-phone-branch-<n>.json.
// Per build and clip: whole-frame draw p95, dropped frames on whole-frame and
// cropped frames (branch only: main records no displayed rule times), detection
// p95, lookahead length, cut lateness, and failures.
//
// Usage: node scripts/compare-phone-runs.mjs [.eval]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".eval";
const fixed = (x, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : "-");
const median = (values) => {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  return finite.length ? finite[Math.floor(finite.length / 2)] : NaN;
};

function ruleAt(events, sec) {
  let rule = null;
  for (let i = 0; i < events.mediaTimeSec.length; i++) {
    if (events.mediaTimeSec[i] > sec + 1e-6) break;
    rule = events.rule[i];
  }
  return rule;
}

/** Dropped frames (presentedFrames gaps) after warm-up, split by the rule on screen when the branch records it. */
function droppedFrames(raw) {
  const frames = raw.frames;
  const out = { total: 0, whole: 0, crop: 0 };
  for (let i = 1; i < frames.mediaTimeSec.length; i++) {
    if (frames.warmup[i]) continue;
    const gap = frames.presentedFrames[i] - frames.presentedFrames[i - 1] - 1;
    if (gap <= 0) continue;
    out.total += gap;
    if (!raw.layoutRules) continue;
    if (ruleAt(raw.layoutRules, frames.mediaTimeSec[i]) === "broll") out.whole += gap;
    else out.crop += gap;
  }
  return out;
}

const files = existsSync(dir)
  ? readdirSync(dir).filter((name) => /^bench-phone-(main|branch)-\d+\.json$/.test(name))
  : [];
if (files.length === 0) {
  console.log(`No bench-phone-<main|branch>-<n>.json in ${dir}.`);
  process.exit(0);
}

const rows = [];
const failures = [];
for (const name of files.sort()) {
  const build = name.match(/^bench-phone-(main|branch)/)[1];
  const report = JSON.parse(readFileSync(join(dir, name), "utf8"));
  failures.push({
    file: name,
    failures: report.failures?.length ?? 0,
    hidden: report.results.filter((r) => r.pageHiddenDuringRun).length,
  });
  for (const result of report.results.filter((r) => r.mode === "9:16")) {
    const summary = result.summary;
    const dropped = droppedFrames(result.raw);
    const late = (summary.knownCuts ?? []).map((cut) => cut.framesLate);
    rows.push({
      build,
      file: name,
      clip: result.clip,
      wasm: result.wasmBuild?.variant ?? "-",
      lookahead: result.lookahead?.enabled ? "on" : "off",
      L: result.lookahead?.enabled ? result.lookahead.lengthMs : null,
      detectP95: summary.detection.totalMs.p95,
      wholeDrawP95: summary.tracking?.fullSceneDrawMs?.p95 ?? NaN,
      droppedTotal: dropped.total,
      droppedWhole: result.raw.layoutRules ? dropped.whole : NaN,
      droppedCrop: result.raw.layoutRules ? dropped.crop : NaN,
      cutsLate: late.filter((n) => n !== null && n > 0).length,
      cutsMissed: late.filter((n) => n === null).length,
    });
  }
}

const groups = new Map();
for (const row of rows) {
  const key = `${row.clip}|${row.wasm}|${row.lookahead}`;
  if (!groups.has(key)) groups.set(key, { main: [], branch: [] });
  groups.get(key)[row.build].push(row);
}
const table = [];
for (const [key, { main, branch }] of groups) {
  const [clip, wasm, lookahead] = key.split("|");
  const cell = (list, field, digits) => (list.length ? fixed(median(list.map((r) => r[field])), digits) : "-");
  table.push({
    clip,
    wasm,
    lookahead,
    "runs main/branch": `${main.length}/${branch.length}`,
    "L ms main/branch": `${cell(main, "L", 0)} / ${cell(branch, "L", 0)}`,
    "detect p95 ms main/branch": `${cell(main, "detectP95")} / ${cell(branch, "detectP95")}`,
    "whole draw p95 ms (branch)": cell(branch, "wholeDrawP95", 2),
    "dropped main / branch (whole + crop)": `${cell(main, "droppedTotal", 0)} / ${cell(branch, "droppedTotal", 0)} (${cell(branch, "droppedWhole", 0)} + ${cell(branch, "droppedCrop", 0)})`,
    "cuts late/missed main": `${main.reduce((s, r) => s + r.cutsLate, 0)}/${main.reduce((s, r) => s + r.cutsMissed, 0)}`,
    "cuts late/missed branch": `${branch.reduce((s, r) => s + r.cutsLate, 0)}/${branch.reduce((s, r) => s + r.cutsMissed, 0)}`,
  });
}
console.log("Medians over the runs of each build; dropped frames after warm-up.");
console.table(table);
console.table(failures);
