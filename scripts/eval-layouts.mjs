// Displayed layout against hand labels (.eval/multipane-labels.csv: clip,start_s,end_s,expected,note
// with expected = multipane | single | whole). For each clip and run: labelled seconds per expected
// layout, the share shown as expected, multi-pane seconds on labelled single/whole time, and grid
// seconds. Reads production benchmark reports (raw.layoutRules) and/or check-tracker results
// (displayedRuleEvents); both give the displayed rule by media time.
//
// Usage: node scripts/eval-layouts.mjs [--bench=.eval/bench-a.json,...] [--tracker=.eval/tracker-check-x.json,...]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const list = (name) =>
  args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(",")
    .filter(Boolean) ?? [];
const STEP_SEC = 0.04;
const SHOWN_AS = {
  multipane: (rule) => rule === "stacked" || rule === "grid",
  single: (rule) => rule === "single" || rule === "subject" || rule === "group",
  whole: (rule) => rule === "broll",
};

const labels = new Map();
for (const line of readFileSync(join(here, ".eval/multipane-labels.csv"), "utf8").trim().split("\n").slice(1)) {
  const [clip, start, end, expected] = line.split(",");
  if (!labels.has(clip)) labels.set(clip, []);
  labels.get(clip).push({ startSec: Number(start), endSec: Number(end), expected });
}

const labelOf = (clip) => clip.replace(/^local-\d+-/, "").replace(/\.mp4$/, "");

/** Runs as { source, clip, endSec, events: [{ t, rule }] } in media-time order. */
function runs() {
  const out = [];
  for (const file of list("bench")) {
    const report = JSON.parse(readFileSync(file, "utf8"));
    for (const result of report.results) {
      if (result.mode !== "9:16" || !result.raw?.layoutRules) continue;
      const { mediaTimeSec, rule } = result.raw.layoutRules;
      const events = mediaTimeSec.map((t, i) => ({ t, rule: rule[i] })).filter((e) => Number.isFinite(e.t));
      out.push({ source: file.split("/").pop(), clip: labelOf(result.clip), endSec: lastFrameSec(result), events });
    }
  }
  for (const file of list("tracker")) {
    const report = JSON.parse(readFileSync(file, "utf8"));
    for (const run of report.runs) {
      if (!run.displayedRuleEvents) continue;
      const events = run.displayedRuleEvents;
      out.push({ source: file.split("/").pop(), clip: labelOf(run.clip), endSec: events.at(-1)?.t ?? 0, events });
    }
  }
  return out;
}

function lastFrameSec(result) {
  const times = result.raw.frames?.mediaTimeSec ?? [];
  return times.length ? times[times.length - 1] : 0;
}

function ruleAt(events, sec) {
  let rule = null;
  for (const event of events) {
    if (event.t > sec + 1e-6) break;
    rule = event.rule;
  }
  return rule;
}

const rows = [];
for (const run of runs()) {
  const clipLabels = labels.get(run.clip);
  if (!clipLabels) continue;
  const stats = { multipane: [0, 0], single: [0, 0], whole: [0, 0] };
  let multipaneOnSingleOrWhole = 0;
  let grid = 0;
  for (const label of clipLabels) {
    for (let t = label.startSec; t < Math.min(label.endSec, run.endSec); t += STEP_SEC) {
      const rule = ruleAt(run.events, t);
      if (rule === null) continue;
      stats[label.expected][0] += STEP_SEC;
      if (SHOWN_AS[label.expected](rule)) stats[label.expected][1] += STEP_SEC;
      if (label.expected !== "multipane" && SHOWN_AS.multipane(rule)) multipaneOnSingleOrWhole += STEP_SEC;
      if (rule === "grid") grid += STEP_SEC;
    }
  }
  const share = ([total, right]) =>
    total > 0 ? `${((100 * right) / total).toFixed(1)}% of ${total.toFixed(1)} s` : "-";
  rows.push({
    run: run.source,
    clip: run.clip,
    multipane: share(stats.multipane),
    single: share(stats.single),
    whole: share(stats.whole),
    "multi-pane s on single/whole": Number(multipaneOnSingleOrWhole.toFixed(1)),
    "grid s": Number(grid.toFixed(1)),
  });
}
console.table(rows);
