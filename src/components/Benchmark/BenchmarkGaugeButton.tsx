import type { BenchmarkTone } from "./benchmarkOutcome";

interface BenchmarkGaugeButtonProps {
  tone: BenchmarkTone;
  /** Overall run progress in [0, 1]; drives both the ring and the needle while running. */
  progress: number;
  running: boolean;
  /** Shows the corner badge: a finished run's results are available. */
  hasResults: boolean;
  expanded: boolean;
  controlsId: string;
  label: string;
  tooltip: string;
  onClick: () => void;
}

const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const NEEDLE_MIN_DEG = -120;
const NEEDLE_SWEEP_DEG = 240;
const NEEDLE_REST_DEG = -60;

const RING_STROKE: Record<BenchmarkTone, string> = {
  idle: "stroke-transparent",
  running: "stroke-amber-400",
  success: "stroke-emerald-400/70",
  danger: "stroke-red-400/70",
  muted: "stroke-neutral-500/70",
};

const ICON_COLOR: Record<BenchmarkTone, string> = {
  idle: "text-neutral-400 group-hover:text-neutral-100",
  running: "text-amber-300",
  success: "text-emerald-300",
  danger: "text-red-300",
  muted: "text-neutral-300",
};

const BADGE_COLOR: Record<BenchmarkTone, string> = {
  idle: "bg-neutral-400",
  running: "bg-amber-400",
  success: "bg-emerald-400",
  danger: "bg-red-400",
  muted: "bg-neutral-400",
};

function needleAngle(tone: BenchmarkTone, progress: number): number {
  if (tone === "running") return NEEDLE_MIN_DEG + NEEDLE_SWEEP_DEG * progress;
  if (tone === "success" || tone === "danger") return NEEDLE_MIN_DEG + NEEDLE_SWEEP_DEG;
  return NEEDLE_REST_DEG;
}

/**
 * Round header trigger for benchmark mode. The speedometer needle sweeps
 * with the run's progress while a ring fills around the button, so the
 * player stays fully visible and progress is still glanceable.
 */
export function BenchmarkGaugeButton({
  tone,
  progress,
  running,
  hasResults,
  expanded,
  controlsId,
  label,
  tooltip,
  onClick,
}: BenchmarkGaugeButtonProps) {
  const ringFill = tone === "running" ? progress : tone === "idle" ? 0 : 1;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? controlsId : undefined}
      className={`group relative grid place-items-center w-[2.375rem] h-[2.375rem] shrink-0 rounded-full hover:bg-neutral-900 active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70 ${
        running ? "shadow-[0_0_18px_-6px] shadow-amber-400/70" : ""
      }`}
    >
      <svg viewBox="0 0 38 38" className="absolute inset-0 w-full h-full -rotate-90" aria-hidden="true">
        <circle
          cx="19"
          cy="19"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="1"
          className="stroke-neutral-800 group-hover:stroke-neutral-600 transition-colors"
        />
        <circle
          cx="19"
          cy="19"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - ringFill)}
          className={`${RING_STROKE[tone]} motion-safe:transition-[stroke-dashoffset,stroke] motion-safe:duration-300 ease-out`}
        />
      </svg>

      <svg
        viewBox="0 0 24 24"
        className={`relative w-[1.125rem] h-[1.125rem] transition-colors ${ICON_COLOR[tone]}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M5.07 18A8 8 0 1 1 18.93 18" />
        <path d="M12 6v1.2M6.3 9.3l.85.85M17.7 9.3l-.85.85" strokeWidth={1.25} className="opacity-60" />
        <line
          x1="12"
          y1="14"
          x2="12"
          y2="8.5"
          style={{ transform: `rotate(${needleAngle(tone, progress)}deg)`, transformOrigin: "12px 14px" }}
          className="motion-safe:transition-transform motion-safe:duration-500 ease-out"
        />
        <circle
          cx="12"
          cy="14"
          r="1.6"
          fill="currentColor"
          stroke="none"
          className={running ? "motion-safe:animate-pulse" : ""}
        />
      </svg>

      {hasResults && (
        <span
          aria-hidden="true"
          className={`absolute top-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-neutral-950 ${BADGE_COLOR[tone]}`}
        />
      )}

      <span
        aria-hidden="true"
        className={`${expanded ? "hidden" : ""} pointer-events-none absolute top-full right-0 mt-2 z-30 whitespace-nowrap rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 shadow-lg opacity-0 translate-y-0.5 transition [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover:translate-y-0 group-focus-visible:opacity-100 group-focus-visible:translate-y-0`}
      >
        {tooltip}
      </span>
    </button>
  );
}
