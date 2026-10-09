import type { BenchmarkStage } from "../../hooks/useBenchmark";
import { BenchmarkIcon } from "./BenchmarkIcon";
import { BenchmarkPanelHeader } from "./BenchmarkPanelHeader";
import { BenchmarkStageRail } from "./BenchmarkStageRail";
import { DANGER_BUTTON } from "./benchmarkStyles";

interface BenchmarkRunningViewProps {
  titleId: string;
  stage: BenchmarkStage | null;
  progress: number;
  stageFraction: number;
  onStop: () => void;
  onClose: () => void;
}

export function BenchmarkRunningView({
  titleId,
  stage,
  progress,
  stageFraction,
  onStop,
  onClose,
}: BenchmarkRunningViewProps) {
  const percent = Math.round(progress * 100);

  return (
    <>
      <BenchmarkPanelHeader
        titleId={titleId}
        title="Benchmark running"
        leading={
          <span aria-hidden="true" className="relative flex w-2 h-2">
            <span className="absolute inset-0 rounded-full bg-amber-400 motion-safe:animate-ping opacity-60" />
            <span className="relative w-2 h-2 rounded-full bg-amber-400" />
          </span>
        }
        onClose={onClose}
      />

      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-end justify-between gap-3">
          <p className="min-w-0 text-neutral-300 break-words">{stage?.label ?? "Preparing…"}</p>
          <p className="shrink-0 font-display text-2xl font-semibold leading-none tabular-nums text-amber-300">
            {percent}
            <span className="text-sm text-amber-300/70">%</span>
          </p>
        </div>

        {stage && <BenchmarkStageRail kinds={stage.kinds} currentIndex={stage.index} currentFraction={stageFraction} />}

        <p className="text-neutral-500">Keep this tab visible. Results open here when the run ends.</p>

        <button type="button" className={`${DANGER_BUTTON} w-full`} onClick={onStop}>
          <BenchmarkIcon name="stop" className="w-3 h-3" />
          Stop run
        </button>
      </div>
    </>
  );
}
