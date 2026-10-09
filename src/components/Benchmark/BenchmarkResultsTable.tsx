import { useMemo } from "react";
import { benchmarkSummaryRows, type BenchmarkReport } from "../../core";
import { isClipInvalid } from "./benchmarkOutcome";

const CLIP_KEYS = new Set(["clip", "mode", "build"]);

function formatCell(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

/**
 * Transposed metric × clip table: a handful of clip columns stays readable
 * on a phone, whereas 20 metric columns would not. Header row and metric
 * column stay pinned while scrolling.
 */
export function BenchmarkResultsTable({ report }: { report: BenchmarkReport }) {
  const rows = useMemo(() => benchmarkSummaryRows(report), [report]);
  const metrics = rows.length > 0 ? Object.keys(rows[0]).filter((key) => !CLIP_KEYS.has(key)) : [];
  const invalidByClip = report.results.map(isClipInvalid);

  return (
    <div className="max-h-[45dvh] sm:max-h-[22rem] overflow-auto overscroll-contain rounded-xl border border-neutral-800">
      <table className="w-full text-neutral-300 whitespace-nowrap border-separate border-spacing-0">
        <caption className="sr-only">Benchmark metrics per clip</caption>
        <thead className="sticky top-0 z-10">
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 px-2.5 py-1.5 text-left font-medium text-neutral-500 bg-neutral-900 border-b border-neutral-800"
            >
              metric
            </th>
            {rows.map((row, clipIndex) => (
              <th
                key={clipIndex}
                scope="col"
                className="px-2.5 py-1.5 text-right align-bottom font-medium bg-neutral-900 border-b border-neutral-800"
              >
                <span
                  className={`block max-w-[9rem] ml-auto truncate ${invalidByClip[clipIndex] ? "text-red-400" : "text-neutral-200"}`}
                  title={formatCell(row.clip)}
                >
                  {formatCell(row.clip)}
                </span>
                <span className="block font-normal text-neutral-500">
                  {formatCell(row.mode)}
                  {row.build !== "n/a" && ` · ${formatCell(row.build)}`}
                  {invalidByClip[clipIndex] && <span className="text-red-400"> · invalid</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric} className="group">
              <th
                scope="row"
                className="sticky left-0 px-2.5 py-1 text-left font-normal text-neutral-400 bg-neutral-950 group-odd:bg-neutral-900 border-t border-neutral-800/70"
              >
                {metric}
              </th>
              {rows.map((row, clipIndex) => (
                <td
                  key={clipIndex}
                  className="px-2.5 py-1 text-right font-mono tabular-nums group-odd:bg-neutral-900/60 border-t border-neutral-800/70"
                >
                  {formatCell(row[metric])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
