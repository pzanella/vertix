import type { BenchmarkStageKind } from "./benchmarkOutcome";

interface BenchmarkStageRailProps {
  kinds: BenchmarkStageKind[];
  /** Index of the running stage; omit for a static preview of the plan. */
  currentIndex?: number;
  currentFraction?: number;
}

const PREVIEW_TINT: Record<BenchmarkStageKind, string> = {
  warmup: "bg-amber-400/30",
  clip: "bg-brand-400/35",
  baseline: "bg-neutral-500/50",
};

const FILL: Record<BenchmarkStageKind, string> = {
  warmup: "bg-amber-400",
  clip: "bg-brand-400",
  baseline: "bg-neutral-300",
};

const LEGEND: { kind: BenchmarkStageKind; label: string }[] = [
  { kind: "warmup", label: "warm-up" },
  { kind: "clip", label: "9:16 clips" },
  { kind: "baseline", label: "16:9 baseline" },
];

/** One segment per stage of the run: a map of the plan before, a progress track during. */
export function BenchmarkStageRail({ kinds, currentIndex, currentFraction = 0 }: BenchmarkStageRailProps) {
  const preview = currentIndex === undefined;
  const legend = LEGEND.filter(({ kind }) => kinds.includes(kind));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1" aria-hidden="true">
        {kinds.map((kind, index) => {
          const fill =
            currentIndex === undefined ? 0 : index < currentIndex ? 1 : index === currentIndex ? currentFraction : 0;
          return (
            <span
              key={index}
              className={`relative h-1.5 overflow-hidden rounded-full ${kind === "clip" ? "flex-[2]" : "flex-1"} ${
                preview ? PREVIEW_TINT[kind] : "bg-neutral-800"
              }`}
            >
              {!preview && (
                <span
                  className={`absolute inset-y-0 left-0 rounded-full ${FILL[kind]} motion-safe:transition-[width] motion-safe:duration-300 ease-out`}
                  style={{ width: `${fill * 100}%` }}
                />
              )}
            </span>
          );
        })}
      </div>
      {legend.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-500" aria-hidden="true">
          {legend.map(({ kind, label }) => (
            <span key={kind} className="inline-flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${FILL[kind]}`} />
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
