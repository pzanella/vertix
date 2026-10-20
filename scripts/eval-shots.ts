// Shot type against hand labels: reads a check-tracker result (.eval/tracker-check-<label>.json,
// with the shot type the engine recorded on every detection) and .eval/shot-labels.csv, and reports
// per clip the labelled time classified right, the time in grid on wide shots, shot-type changes per
// minute, and first-sample errors at cuts. Also prints the largest foreground face size per labelled
// segment (p10 / p50 / p90) and replays the tracker with other thresholds or hold times.
//
// Labels: a boundary snaps to the nearest detected cut within 1.0 s; a boundary with no cut nearby
// excludes 1.0 s on each side. Sample clips (no labels) count as close for their whole duration.
//
// Usage: npx vite-node scripts/eval-shots.ts --result=<label> [--close-min=0.3] [--wide-max=0.18]
//          [--hold=1.0] [--cut-hold=0.2] [--grid] [--held-out=<label>,<label>]
// Results go to stdout and .eval/shot-eval-<label>.json (gitignored).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SHOT_RULES,
  ShotTypeTracker,
  shotCandidate,
  type ShotRules,
  type ShotType,
} from "../src/core/tracking/shotType";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const resultLabel = option("result") ?? "current";
const SNAP_TOLERANCE_SEC = 1;
const EXCLUDE_SEC = 1;
// Tuning and held-out clip labels: .eval/shot-clip-sets.json (gitignored), {"tuning": [...], "heldOut": [...]}.
const CLIP_SETS: { tuning: string[]; heldOut: string[] } = JSON.parse(
  readFileSync(join(here, ".eval/shot-clip-sets.json"), "utf8")
);
const TUNING_CLIPS = CLIP_SETS.tuning;
const HELD_OUT = option("held-out")?.split(",") ?? CLIP_SETS.heldOut;

interface Snapshot {
  t: number;
  rule: string;
  shot?: ShotType;
  largest: number;
  cut: boolean;
  tracks: { fg: boolean; w: number; h: number }[];
}
interface Segment {
  startSec: number;
  endSec: number;
  shot: string;
}

const rules: ShotRules = {
  closeMinHmax: Number(option("close-min") ?? DEFAULT_SHOT_RULES.closeMinHmax),
  wideMaxHmax: Number(option("wide-max") ?? DEFAULT_SHOT_RULES.wideMaxHmax),
  shotHoldSec: Number(option("hold") ?? DEFAULT_SHOT_RULES.shotHoldSec),
  cutHoldSec: Number(option("cut-hold") ?? DEFAULT_SHOT_RULES.cutHoldSec),
  cutHoldWindowSec: DEFAULT_SHOT_RULES.cutHoldWindowSec,
};

const result = JSON.parse(readFileSync(join(here, `.eval/tracker-check-${resultLabel}.json`), "utf8"));

function labelOf(clip: string): string {
  return clip.replace(/^local-\d+-/, "").replace(/\.mp4$/, "");
}

function parseLabels(): Map<string, Segment[]> {
  const byClip = new Map<string, Segment[]>();
  const lines = readFileSync(join(here, ".eval/shot-labels.csv"), "utf8").trim().split("\n").slice(1);
  for (const line of lines) {
    const [clip, start, end, shot] = line.split(",");
    const list = byClip.get(clip) ?? [];
    list.push({ startSec: Number(start), endSec: Number(end), shot });
    byClip.set(clip, list);
  }
  return byClip;
}

/** Labelled segments with boundaries snapped to detected cuts, and excluded windows where no cut is near. */
function snapLabels(segments: Segment[], cutTimes: number[]) {
  const excluded: [number, number][] = [];
  const snapped = segments.map((segment) => ({ ...segment }));
  for (const segment of snapped) {
    for (const key of ["startSec", "endSec"] as const) {
      const boundary = segment[key];
      const nearest = cutTimes.reduce<number | null>(
        (best, cut) => (best === null || Math.abs(cut - boundary) < Math.abs(best - boundary) ? cut : best),
        null
      );
      if (nearest !== null && Math.abs(nearest - boundary) <= SNAP_TOLERANCE_SEC) segment[key] = nearest;
      else excluded.push([boundary - EXCLUDE_SEC, boundary + EXCLUDE_SEC]);
    }
  }
  return { segments: snapped, excluded };
}

function segmentAt(segments: Segment[], sec: number): Segment | undefined {
  return segments.find((segment) => sec >= segment.startSec && sec < segment.endSec);
}

function isExcluded(excluded: [number, number][], sec: number): boolean {
  return excluded.some(([from, to]) => sec >= from && sec <= to);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Shot type per snapshot, replayed with the given rules (equal to the engine's when the rules match). */
function replay(snapshots: Snapshot[], replayRules: ShotRules): ShotType[] {
  const tracker = new ShotTypeTracker(replayRules);
  return snapshots.map((snapshot) => {
    const foreground = snapshot.tracks.filter((track) => track.fg);
    return tracker.observe(
      { largestFaceSize: snapshot.largest, foregroundCount: foreground.length },
      snapshot.t,
      snapshot.cut
    );
  });
}

function matches(label: string, predicted: ShotType): boolean {
  if (label === "close") return predicted === "close";
  if (label === "wide") return predicted === "wide" || predicted === "none";
  if (label === "graphics") return predicted === "wide" || predicted === "none";
  return false;
}

const labelsByClip = parseLabels();
const perClip: Record<string, unknown>[] = [];
const distributionRows: Record<string, string | number>[] = [];
let tuningCorrect = 0;
let tuningTotal = 0;
const heldOutRows: Record<string, unknown>[] = [];

for (const run of result.runs) {
  const clip = labelOf(run.clip);
  const snapshots: Snapshot[] = run.snapshots;
  const engineShot = snapshots.map((s) => s.shot ?? null);
  const cutTimes = snapshots.filter((s) => s.cut).map((s) => s.t);
  const labelled = labelsByClip.get(clip);
  const full = snapshots.map((s) => s.t);
  const lastT = full[full.length - 1] ?? 0;
  const segmentsForClip: Segment[] = labelled ?? [{ startSec: 0, endSec: lastT + 1, shot: "close" }];
  const { segments, excluded } = snapLabels(segmentsForClip, cutTimes);
  const predicted = replay(snapshots, rules);
  const mismatches = engineShot.filter((shot, i) => shot !== null && shot !== predicted[i]).length;

  for (const shotName of ["close", "wide", "none", "graphics"]) {
    const sizes = snapshots
      .filter((s) => {
        const seg = segmentAt(segments, s.t);
        return seg !== undefined && seg.shot === shotName && !isExcluded(excluded, s.t) && s.largest > 0;
      })
      .map((s) => s.largest)
      .sort((a, b) => a - b);
    if (sizes.length === 0) continue;
    distributionRows.push({
      clip,
      segment: shotName,
      n: sizes.length,
      p10: percentile(sizes, 0.1).toFixed(3),
      p50: percentile(sizes, 0.5).toFixed(3),
      p90: percentile(sizes, 0.9).toFixed(3),
    });
  }

  let labelledSec = 0;
  let correctSec = 0;
  let wideSec = 0;
  let wideGridSec = 0;
  for (let i = 0; i < snapshots.length; i++) {
    const seg = segmentAt(segments, snapshots[i].t);
    if (!seg || isExcluded(excluded, snapshots[i].t)) continue;
    const dt = i + 1 < snapshots.length ? snapshots[i + 1].t - snapshots[i].t : 0;
    const shotName = labelled ? seg.shot : "close";
    labelledSec += dt;
    if (matches(shotName, predicted[i])) correctSec += dt;
    if (predicted[i] !== "close") {
      wideSec += dt;
      if (snapshots[i].rule === "grid") wideGridSec += dt;
    }
  }

  const changes = predicted.slice(1).filter((shot, i) => shot !== predicted[i]).length;
  const minutes = lastT / 60;
  const cutFirst = cutTimes.map((cutSec) => {
    const first = snapshots.findIndex((s) => s.t >= cutSec);
    const seg = segmentAt(segments, cutSec);
    if (first < 0 || !seg) return null;
    const shotName = labelled ? seg.shot : "close";
    return {
      cutSec,
      label: shotName,
      first:
        shotCandidate(
          {
            largestFaceSize: snapshots[first].largest,
            foregroundCount: snapshots[first].tracks.filter((t) => t.fg).length,
          },
          rules
        ) ?? "close",
    };
  });
  const firstErrors = cutFirst.filter((c) => c !== null && !matches(c.label, c.first as ShotType)).length;

  const row = {
    clip,
    labelledSec: Number(labelledSec.toFixed(1)),
    accuracyPct: labelledSec > 0 ? Number(((100 * correctSec) / labelledSec).toFixed(1)) : null,
    wideSec: Number(wideSec.toFixed(1)),
    timeInGridOnWideSec: Number(wideGridSec.toFixed(1)),
    shotChangesPerMin: Number((changes / minutes).toFixed(2)),
    layoutChanges: run.layoutChanges,
    cutsFound: cutTimes.length,
    firstSampleErrors: `${firstErrors}/${cutFirst.filter((c) => c !== null).length}`,
    engineReplayMismatches: mismatches,
  };
  perClip.push(row);
  if (labelled && !HELD_OUT.includes(clip)) {
    tuningCorrect += correctSec;
    tuningTotal += labelledSec;
  }
  if (HELD_OUT.includes(clip)) heldOutRows.push(row);
  if (!labelled) console.log(`[eval] ${clip}: no labels; close assumed for the whole clip`);
}

const tuningSet = perClip.filter((r) => TUNING_CLIPS.includes(r.clip as string));
console.log("Thresholds:", JSON.stringify(rules));
console.table(perClip);
console.table(distributionRows);
console.log(
  `Tuning accuracy (labelled seconds, ${TUNING_CLIPS.join(", ")}): ${
    tuningTotal > 0 ? ((100 * tuningCorrect) / tuningTotal).toFixed(1) : "n/a"
  }%`
);
console.log(`Tuning rows: ${tuningSet.length}; held out (indicative only, 4 labelled rows): see table.`);

writeFileSync(
  join(here, `.eval/shot-eval-${resultLabel}.json`),
  JSON.stringify({ rules, perClip, distributionRows, heldOut: heldOutRows }, null, 2)
);
