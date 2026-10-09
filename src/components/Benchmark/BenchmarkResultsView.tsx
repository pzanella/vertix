import { useMemo } from "react";
import type { BenchmarkReport } from "../../core";
import { BenchmarkIcon } from "./BenchmarkIcon";
import {
  benchmarkHighlights,
  isClipInvalid,
  TONE_CHIP,
  TONE_TEXT,
  VERDICT_LABEL,
  VERDICT_TONE,
  type BenchmarkTone,
  type BenchmarkVerdict,
} from "./benchmarkOutcome";
import { BenchmarkPanelHeader } from "./BenchmarkPanelHeader";
import { BenchmarkResultsTable } from "./BenchmarkResultsTable";
import { GHOST_BUTTON, PRIMARY_BUTTON, TONAL_BUTTON } from "./benchmarkStyles";

interface BenchmarkResultsViewProps {
  titleId: string;
  verdict: BenchmarkVerdict;
  report: BenchmarkReport | null;
  error: string | null;
  onRunAgain: () => void;
  onBack: () => void;
  onDownloadJson: () => void;
  onDownloadCsv: () => void;
  onClose: () => void;
}

interface Highlight {
  label: string;
  value: string;
  hint: string;
  tone?: BenchmarkTone;
  wide?: boolean;
}

const VERDICT_HINT: Record<BenchmarkVerdict, string> = {
  valid: "tab visible, one render loop",
  invalid: "see warnings below",
  partial: "stopped early",
  failed: "run aborted",
};

function formatNumber(value: number | null, digits = 0): string {
  return value === null ? "—" : value.toFixed(digits);
}

function buildHighlights(report: BenchmarkReport, verdict: BenchmarkVerdict): Highlight[] {
  const stats = benchmarkHighlights(report);
  const baselineRuns = stats.runs - stats.reframedRuns;
  return [
    {
      label: "Runs",
      value: String(stats.runs),
      hint: baselineRuns > 0 ? `${stats.reframedRuns} × 9:16 + baseline` : `${stats.reframedRuns} × 9:16`,
    },
    {
      label: "Dropped frames",
      value: formatNumber(stats.droppedFrames),
      hint: stats.expectedFrames !== null ? `of ${stats.expectedFrames} expected` : "estimate",
      tone: stats.droppedFrames ? "running" : undefined,
    },
    ...stats.wasmP50MsByBuild.map(({ build, p50Ms }) => ({
      label: `WASM p50 · ${build}`,
      value: `${formatNumber(p50Ms, 1)} ms`,
      hint: "median over 9:16 clips",
    })),
    { label: "Detection", value: `${formatNumber(stats.detectionHz, 1)} Hz`, hint: "median rate" },
    {
      label: "Validity",
      value: VERDICT_LABEL[verdict],
      hint: VERDICT_HINT[verdict],
      tone: VERDICT_TONE[verdict],
      wide: true,
    },
  ];
}

function Callout({ tone, children }: { tone: "danger" | "warning" | "muted"; children: React.ReactNode }) {
  const style = {
    danger: "border-red-500/60 bg-red-500/10 text-red-200",
    warning: "border-amber-500/60 bg-amber-500/10 text-amber-100",
    muted: "border-neutral-600 bg-neutral-900 text-neutral-300",
  }[tone];
  return (
    <p className={`flex items-start gap-2 rounded-r-lg border-l-2 px-2.5 py-1.5 leading-relaxed ${style}`}>
      <BenchmarkIcon name="warning" className="mt-0.5 w-3.5 h-3.5 opacity-80" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

export function BenchmarkResultsView({
  titleId,
  verdict,
  report,
  error,
  onRunAgain,
  onBack,
  onDownloadJson,
  onDownloadCsv,
  onClose,
}: BenchmarkResultsViewProps) {
  const highlights = useMemo(() => (report ? buildHighlights(report, verdict) : []), [report, verdict]);
  const results = report?.results ?? [];
  const hasDuplicateCallbacks = results.some((result) => result.summary.frames.duplicateCallbacks > 0);
  const hasHiddenPage = results.some((result) => result.pageHiddenDuringRun);
  const invalidCount = results.filter(isClipInvalid).length;
  const environment = report?.environment;
  const verdictTone = VERDICT_TONE[verdict];

  return (
    <>
      <BenchmarkPanelHeader
        titleId={titleId}
        title="Benchmark results"
        leading={
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to benchmark options"
            className="grid place-items-center w-8 h-8 -ml-1.5 rounded-full text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800 active:scale-95 transition"
          >
            <BenchmarkIcon name="back" className="w-4 h-4" />
          </button>
        }
        accessory={
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CHIP[verdictTone]}`}>
            {VERDICT_LABEL[verdict]}
          </span>
        }
        onClose={onClose}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain flex flex-col gap-3 px-4 pb-3">
        {highlights.length > 0 && (
          <dl className={`grid grid-cols-2 gap-1.5 ${highlights.length > 5 ? "sm:grid-cols-3" : "sm:grid-cols-5"}`}>
            {highlights.map(({ label, value, hint, tone, wide }) => (
              <div
                key={label}
                className={`rounded-xl border border-neutral-800 bg-gradient-to-b from-neutral-900 to-neutral-950 px-3 py-2 ${
                  wide && highlights.length % 2 === 1 ? "col-span-2 sm:col-span-1" : ""
                }`}
              >
                <dt className="text-[11px] text-neutral-500">{label}</dt>
                <dd
                  className={`font-display text-lg font-semibold leading-tight tabular-nums ${tone ? TONE_TEXT[tone] : "text-neutral-100"}`}
                >
                  {value}
                </dd>
                <dd className="truncate text-[11px] text-neutral-500">{hint}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="flex flex-col gap-1.5 empty:hidden" role="list" aria-label="Warnings">
          {error && (
            <div role="listitem">
              <Callout tone="danger">{error}</Callout>
            </div>
          )}
          {verdict === "partial" && (
            <div role="listitem">
              <Callout tone="muted">
                Stopped early:{" "}
                {results.length === 0 ? "no clip finished." : `showing the ${results.length} finished clip(s).`}
              </Callout>
            </div>
          )}
          {hasDuplicateCallbacks && (
            <div role="listitem">
              <Callout tone="danger">
                More than one render loop was running (duplicate frame callbacks), so {invalidCount} clip(s) are not
                valid. Reload the page and run the benchmark again.
              </Callout>
            </div>
          )}
          {hasHiddenPage && (
            <div role="listitem">
              <Callout tone="danger">
                The page was hidden during at least one clip, so those results are not valid. Run again with the tab
                visible.
              </Callout>
            </div>
          )}
          {report && report.precisionWarnings.length > 0 && (
            <div role="listitem">
              <Callout tone="warning">
                {report.precisionWarnings.length} timing(s) have a median within 10× the timer resolution. Treat them as
                indicative only (details in the JSON).
              </Callout>
            </div>
          )}
        </div>

        {report && results.length > 0 && <BenchmarkResultsTable report={report} />}

        {environment && (
          <p className="text-[11px] text-neutral-500">
            {environment.hardwareConcurrency ?? "?"} cores · DPR {environment.devicePixelRatio} · timer{" "}
            {environment.timerResolutionMs?.toFixed(3) ?? "?"} ms · SIMD supported{" "}
            {environment.wasmSimdSupported ? "yes" : "no"} · default build {environment.wasmBuild.defaultVariant} ·
            .wasm simd {environment.wasmBinarySizes.simd.toLocaleString()} B, scalar{" "}
            {environment.wasmBinarySizes.scalar.toLocaleString()} B
          </p>
        )}
      </div>

      <div className="shrink-0 grid grid-cols-2 gap-2 border-t border-neutral-800/80 px-4 py-3 sm:flex sm:items-center">
        <button
          type="button"
          data-autofocus
          className={PRIMARY_BUTTON}
          onClick={onDownloadJson}
          disabled={!report}
          aria-label="Download results as JSON"
        >
          <BenchmarkIcon name="download" />
          JSON
        </button>
        <button
          type="button"
          className={TONAL_BUTTON}
          onClick={onDownloadCsv}
          disabled={!report}
          aria-label="Download raw samples as CSV"
        >
          <BenchmarkIcon name="download" />
          CSV
        </button>
        <button type="button" className={`${GHOST_BUTTON} col-span-2 sm:order-first sm:mr-auto`} onClick={onRunAgain}>
          <BenchmarkIcon name="replay" />
          Run suite again
        </button>
      </div>
    </>
  );
}
