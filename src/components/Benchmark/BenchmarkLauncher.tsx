import { useCallback, useEffect, useId, useState } from "react";
import type { BenchmarkConfig, VertixEngine } from "../../core";
import { DEFAULT_BENCHMARK_CONFIG } from "./benchmarkConfig";
import { useBenchmark, type BenchmarkStage } from "../../hooks/useBenchmark";
import { benchmarkVerdict, VERDICT_LABEL, VERDICT_TONE, type BenchmarkTone } from "./benchmarkOutcome";
import { BenchmarkGaugeButton } from "./BenchmarkGaugeButton";
import { BenchmarkPopover } from "./BenchmarkPopover";
import { BenchmarkReadyView } from "./BenchmarkReadyView";
import { BenchmarkResultsView } from "./BenchmarkResultsView";
import { BenchmarkRunningView } from "./BenchmarkRunningView";

interface BenchmarkLauncherProps {
  getEngine: () => VertixEngine | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  load: (src: string) => void;
  /** Whether a video is loaded: the gauge only shows then (or while a run or its panel is still active). */
  hasSource: boolean;
  onRunningChange: (running: boolean) => void;
}

const PROGRESS_POLL_MS = 250;

function useRunProgress(
  running: boolean,
  stage: BenchmarkStage | null,
  videoRef: React.RefObject<HTMLVideoElement | null>
): { overall: number; stageFraction: number } {
  const [sample, setSample] = useState<{ stage: BenchmarkStage; fraction: number } | null>(null);

  useEffect(() => {
    if (!running || !stage) return;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const end = stage.stopAtSec ?? video.duration;
      const fraction = Number.isFinite(end) && end > 0 ? Math.min(1, video.currentTime / end) : 0;
      setSample({ stage, fraction });
    }, PROGRESS_POLL_MS);
    return () => clearInterval(id);
  }, [running, stage, videoRef]);

  const stageFraction = sample && sample.stage === stage ? sample.fraction : 0;
  const overall = running && stage ? Math.min(1, (stage.index + stageFraction) / stage.total) : 0;
  return { overall, stageFraction };
}

/**
 * Benchmark mode entry point: a round gauge button in the header. The panel closes when a run starts so the player
 * stays visible, the gauge tracks progress, and the panel reopens on the
 * results once the run ends.
 */
export function BenchmarkLauncher({ getEngine, videoRef, load, hasSource, onRunningChange }: BenchmarkLauncherProps) {
  const [config, setConfig] = useState<BenchmarkConfig>(DEFAULT_BENCHMARK_CONFIG);
  const { status, stage, report, error, runSuite, runCurrentClip, cancel, downloadJson, downloadCsv } = useBenchmark({
    config,
    getEngine,
    videoRef,
    load,
  });
  const running = status === "running";
  const { overall, stageFraction } = useRunProgress(running, stage, videoRef);

  const [panelOpen, setPanelOpen] = useState(false);
  const [requestedView, setRequestedView] = useState<"ready" | "results">("ready");
  // Cleared when a run starts, set when its outcome is dismissed: an unseen
  // outcome forces the panel open on the results without an effect.
  const [outcomeSeen, setOutcomeSeen] = useState(true);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => onRunningChange(running), [running, onRunningChange]);

  const verdict = benchmarkVerdict(status, report);
  const outcomePending = verdict !== null && !outcomeSeen;
  const open = panelOpen || outcomePending;
  const view = running ? "running" : outcomePending || (requestedView === "results" && verdict) ? "results" : "ready";
  const tone: BenchmarkTone = running ? "running" : verdict ? VERDICT_TONE[verdict] : "idle";

  const close = useCallback(() => {
    setPanelOpen(false);
    setRequestedView("ready");
    if (!running) setOutcomeSeen(true);
  }, [running]);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setRequestedView("ready");
    setPanelOpen(true);
  };

  const start = (run: () => void) => {
    setPanelOpen(false);
    setOutcomeSeen(false);
    setRequestedView("ready");
    run();
  };

  const showView = (next: "ready" | "results") => {
    setOutcomeSeen(true);
    setRequestedView(next);
    setPanelOpen(true);
  };

  // Stays mounted without a source so a run survives the "loading" gaps
  // between clips; only the gauge itself is hidden.
  if (!hasSource && !running && !open) return null;

  const percent = Math.round(overall * 100);
  const label = running
    ? `Benchmark running, ${percent}%`
    : verdict
      ? `Benchmark: ${VERDICT_LABEL[verdict].toLowerCase()} results`
      : "Benchmark";
  const tooltip = running ? `Running · ${percent}%` : verdict ? `Results · ${VERDICT_LABEL[verdict]}` : "Run benchmark";
  const announcement = running ? (stage ? `Benchmark: ${stage.label}` : "Benchmark starting") : label;

  return (
    <div className="relative shrink-0">
      <BenchmarkGaugeButton
        tone={tone}
        progress={overall}
        running={running}
        hasResults={verdict !== null && !open}
        expanded={open}
        controlsId={panelId}
        label={label}
        tooltip={tooltip}
        onClick={toggle}
      />
      <span role="status" className="sr-only">
        {announcement}
      </span>

      {open && (
        <BenchmarkPopover id={panelId} labelledBy={titleId} wide={view === "results"} onClose={close}>
          {view === "running" && (
            <BenchmarkRunningView
              titleId={titleId}
              config={config}
              stage={stage}
              progress={overall}
              stageFraction={stageFraction}
              onStop={cancel}
              onClose={close}
            />
          )}
          {view === "results" && verdict && (
            <BenchmarkResultsView
              titleId={titleId}
              verdict={verdict}
              report={report}
              error={error}
              onRunAgain={() => start(runSuite)}
              onBack={() => showView("ready")}
              onDownloadJson={downloadJson}
              onDownloadCsv={downloadCsv}
              onClose={close}
            />
          )}
          {view === "ready" && (
            <BenchmarkReadyView
              titleId={titleId}
              config={config}
              onConfigChange={setConfig}
              hasSource={hasSource}
              lastVerdict={verdict}
              onRunSuite={() => start(runSuite)}
              onRunCurrentClip={() => start(runCurrentClip)}
              onShowResults={() => showView("results")}
              onClose={close}
            />
          )}
        </BenchmarkPopover>
      )}
    </div>
  );
}
