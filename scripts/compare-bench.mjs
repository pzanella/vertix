// Compares benchmark reports (JSON from the in-app suite, desktop or phone)
// side by side: the metrics the face mesh demo must not worsen, and the
// schema-7 faceMesh blocks (extensions.faceMesh) when present.
//
// Usage: node scripts/compare-bench.mjs <name>=<report.json> [<name>=<report.json> ...]
// Runs are grouped by WASM build and lookahead; dropped frames are split by
// clip frame rate (25-30 fps vs 50 fps). Values are medians over the
// group's runs of each run's own p95 (or p50), so one slow clip does not dominate.
import { readFileSync } from "node:fs";

const reports = process.argv.slice(2).map((arg) => {
  const [name, path] = arg.split("=");
  return { name, report: JSON.parse(readFileSync(path, "utf8")) };
});

const median = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};
const fixed = (value, digits = 1) => (value === null || value === undefined ? "-" : value.toFixed(digits));
const sum = (values) => values.reduce((a, b) => a + (b ?? 0), 0);

const rows = [];
for (const { name, report } of reports) {
  const runs = report.results.filter((r) => r.mode === "9:16" && !r.failure);
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.wasmBuild.variant} / lookahead ${run.lookahead.enabled && !run.lookahead.unavailableReason ? "on" : "off"}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  for (const [key, group] of [...groups].sort()) {
    const fps = (run) => run.summary.frames.fpsUsed ?? 0;
    const dropped = (filter) => sum(group.filter(filter).map((r) => r.summary.frames.droppedFramesEstimate));
    const mesh = group.map((r) => r.extensions?.faceMesh).filter((m) => m && !m.error);
    const heapMb = median(group.map((r) => r.resources?.end?.jsHeap?.usedBytes)) / 1048576;
    rows.push({
      report: name,
      group: key,
      runs: group.length,
      "detection p95 ms": fixed(median(group.map((r) => r.summary.detection.totalMs.p95))),
      "wasm p50 ms": fixed(median(group.map((r) => r.summary.detection.wasmMs.p50))),
      "L ms": fixed(median(group.map((r) => (r.lookahead.enabled ? r.lookahead.lengthMs : null))), 0),
      "trigger p95 ms": fixed(median(group.map((r) => r.summary.trigger?.mainThreadMs?.p95))),
      "dropped ≤30fps": dropped((r) => fps(r) <= 31),
      "dropped 50fps": dropped((r) => fps(r) > 31),
      "mesh face p50/p95": mesh.length
        ? `${fixed(median(mesh.map((m) => m.landmark.perFaceMs.p50)))} / ${fixed(median(mesh.map((m) => m.landmark.perFaceMs.p95)))}`
        : "-",
      "mesh tick p95": mesh.length ? fixed(median(mesh.map((m) => m.landmark.perTickMs.p95))) : "-",
      "mesh skipped": mesh.length ? sum(mesh.map((m) => m.landmark.skippedTicks)) : "-",
      "draw p50/p95": mesh.length
        ? `${fixed(median(mesh.map((m) => m.drawMs.p50)), 2)} / ${fixed(median(mesh.map((m) => m.drawMs.p95)), 2)}`
        : "-",
      "interp/step/held/empty %": mesh.length
        ? ["interpolated", "stepped", "held", "empty"]
            .map((k) => fixed(100 * median(mesh.map((m) => m.frames[k])), 0))
            .join("/")
        : "-",
      "flicker/min": mesh.length ? fixed(median(mesh.map((m) => m.flickerEventsPerMinute))) : "-",
      "cut events/min": mesh.length ? fixed(median(mesh.map((m) => m.cutEventsPerMinute))) : "-",
      "L base ms": mesh.length ? fixed(median(mesh.map((m) => m.lookahead.baseLengthMs || null)), 0) : "-",
      "JS heap MB": fixed(heapMb, 0),
      "mesh WASM MB": mesh.length ? fixed(median(mesh.map((m) => m.wasmMemoryBytes)) / 1048576, 0) : "-",
      blocked: mesh.length ? sum(mesh.map((m) => m.blockedRequests.count)) : "-",
    });
  }
  const hidden = report.results.filter((r) => r.pageHiddenDuringRun).length;
  const firstMesh = report.results.map((r) => r.extensions?.faceMesh).find((m) => m?.init);
  const init = firstMesh
    ? `, face mesh init: download ${fixed(firstMesh.init.downloadMs, 0)} ms, load ${fixed(firstMesh.init.loadMs, 0)} ms`
    : "";
  console.log(
    `${name}: schema ${report.schemaVersion}, ${report.results.length} runs, ${report.failures.length} failures, ${hidden} hidden${init}`
  );
}
console.table(rows);
