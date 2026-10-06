import { useEffect, useMemo } from "react";
import { benchmarkSummaryRows, type BenchmarkConfig, type VertixEngine } from "../../core";
import { useBenchmark } from "../../hooks/useBenchmark";

interface BenchmarkPanelProps {
  config: BenchmarkConfig;
  getEngine: () => VertixEngine | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  load: (src: string) => void;
  /** Whether a source is loaded, so "Run current clip" has something to replay. */
  hasSource: boolean;
  onRunningChange: (running: boolean) => void;
}

const BUTTON =
  "px-3 py-1.5 rounded-full border text-base transition active:scale-95 disabled:opacity-40 disabled:pointer-events-none";
const PRIMARY_BUTTON = `${BUTTON} border-brand-500 text-brand-300 hover:bg-brand-950/40`;
const SECONDARY_BUTTON = `${BUTTON} border-neutral-700 text-neutral-300 hover:border-neutral-500`;

const STATUS_LABEL = {
  idle: "Ready",
  running: "Running…",
  done: "Done",
  cancelled: "Cancelled",
  error: "Failed",
} as const;

function formatCell(value: string | number | null): string {
  return value === null ? "—" : String(value);
}

export function BenchmarkPanel({ config, getEngine, videoRef, load, hasSource, onRunningChange }: BenchmarkPanelProps) {
  const { status, step, report, error, runSuite, runCurrentClip, cancel, downloadJson, downloadCsv } = useBenchmark({
    config,
    getEngine,
    videoRef,
    load,
  });
  const running = status === "running";

  useEffect(() => onRunningChange(running), [running, onRunningChange]);

  const rows = useMemo(() => (report ? benchmarkSummaryRows(report) : []), [report]);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return (
    <section className="shrink-0 flex flex-col gap-3 p-3 rounded-xl border border-amber-500/30 bg-neutral-950">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-display font-semibold text-amber-300">Benchmark mode</h2>
        <span className="text-base text-neutral-500">
          WASM warm-up {config.wasmWarmupSec}s · clip warm-up {config.clipWarmupSec}s · baseline{" "}
          {config.baseline ? "on" : "off"}
        </span>
        <span className="text-base text-neutral-300">· {STATUS_LABEL[status]}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button className={PRIMARY_BUTTON} onClick={runSuite} disabled={running}>
          Run suite (6 clips)
        </button>
        <button className={SECONDARY_BUTTON} onClick={runCurrentClip} disabled={running || !hasSource}>
          Run current clip
        </button>
        {running && (
          <button className={SECONDARY_BUTTON} onClick={cancel}>
            Cancel
          </button>
        )}
        <button className={SECONDARY_BUTTON} onClick={downloadJson} disabled={!report}>
          Download JSON
        </button>
        <button className={SECONDARY_BUTTON} onClick={downloadCsv} disabled={!report}>
          Download CSV
        </button>
      </div>

      {step && <p className="text-base text-neutral-400">{step}</p>}
      {running && (
        <p className="text-base text-neutral-500">Keep this tab visible and in the foreground until the run ends.</p>
      )}
      {report?.results.some((result) => result.summary.frames.duplicateCallbacks > 0) && (
        <p className="text-base text-red-400">
          More than one render loop was running (duplicate frame callbacks) — those results are not valid. Reload the
          page and run the benchmark before playing anything else.
        </p>
      )}
      {report?.results.some((result) => result.pageHiddenDuringRun) && (
        <p className="text-base text-red-400">
          The page was hidden during at least one clip — those results are not valid. Run again with the tab visible.
        </p>
      )}
      {error && <p className="text-base text-red-400">{error}</p>}
      {report && report.precisionWarnings.length > 0 && (
        <p className="text-base text-amber-400">
          {report.precisionWarnings.length} timing(s) are within 10× the timer resolution (
          {report.environment.timerResolutionMs?.toFixed(3)} ms) — see the console or JSON.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-base text-neutral-300 whitespace-nowrap">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} className="px-2 py-1 text-left font-medium text-neutral-500">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-neutral-800">
                  {columns.map((column) => (
                    <td key={column} className="px-2 py-1 tabular-nums">
                      {formatCell(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
