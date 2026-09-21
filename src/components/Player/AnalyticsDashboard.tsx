import { memo, useEffect, useReducer, useState, type ReactNode } from "react";
import type { ReframeMeta, ReframeMetrics, ReframeMode, StreamHealth } from "../../hooks/useWasmReframe";
import { classifyLayout } from "./layoutStatus";
import { LiveAnalyticsCharts } from "./LiveAnalyticsCharts";

interface AnalyticsDashboardProps {
  mode: ReframeMode;
  meta: ReframeMeta | null;
  progress: number;
  duration: number;
  speakerCount: number;
  isTransitioning: boolean;
  metrics: ReframeMetrics;
  streamHealth: StreamHealth | null;
}

const LAYOUT_LABEL: Record<ReturnType<typeof classifyLayout>, (speakerCount: number) => string> = {
  original: () => "Original View",
  transition: () => "Transitioning...",
  broll: () => "No-Crop B-Roll",
  single: () => "Single Focus",
  dual: () => "Dual Split",
  grid: (n) => `Multi-Speaker Grid (${n})`,
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[10px] font-mono font-semibold uppercase tracking-widest text-neutral-600">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

const TONE_CLASS = {
  default: "text-neutral-200",
  good: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-red-400",
} as const;

function Row({ label, value, tone = "default" }: { label: string; value: string; tone?: keyof typeof TONE_CLASS }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className={`font-mono tabular-nums text-right ${TONE_CLASS[tone]}`}>{value}</span>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`w-3 h-3 text-neutral-600 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-600 hover:text-neutral-400 transition-colors"
      >
        <ChevronIcon open={open} />
        {title}
      </button>
      {open && <div className="flex flex-col gap-1 pl-4">{children}</div>}
    </div>
  );
}

function bufferHealthTone(seconds: number): keyof typeof TONE_CLASS {
  if (seconds > 5) return "good";
  if (seconds > 1) return "warn";
  return "bad";
}

function droppedFramesTone(dropped: number, total: number): keyof typeof TONE_CLASS {
  if (total === 0) return "default";
  return dropped / total > 0.02 ? "bad" : "default";
}

function StreamHealthSection({ streamHealth }: { streamHealth: StreamHealth }) {
  const { manifestType, bufferHealthSec, bandwidthEstimateKbps, droppedFrames, totalDecodedFrames, activeVariant } =
    streamHealth;
  const isAdaptive = manifestType === "HLS" || manifestType === "DASH";

  if (manifestType === "LOCAL") {
    return (
      <CollapsibleSection title="Stream Health" defaultOpen={false}>
        <p className="text-[11px] text-neutral-600">Local file — no network metrics.</p>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title="Stream Health" defaultOpen={true}>
      <Row
        label="Buffer Health"
        value={`${bufferHealthSec.toFixed(1)}s ahead`}
        tone={bufferHealthTone(bufferHealthSec)}
      />
      {isAdaptive && bandwidthEstimateKbps !== null && (
        <Row label="Bandwidth Est." value={`${bandwidthEstimateKbps} kbps`} />
      )}
      <Row
        label="Dropped Frames"
        value={`${droppedFrames} / ${totalDecodedFrames}`}
        tone={droppedFramesTone(droppedFrames, totalDecodedFrames)}
      />
      {isAdaptive && activeVariant && (
        <Row label="Active Variant" value={`${activeVariant.height}p @ ${activeVariant.bitrateKbps}kbps`} />
      )}
    </CollapsibleSection>
  );
}

export const AnalyticsDashboard = memo(function AnalyticsDashboard({
  mode,
  meta,
  progress,
  duration,
  speakerCount,
  isTransitioning,
  metrics,
  streamHealth,
}: AnalyticsDashboardProps) {
  // "Stable Scene Duration" ticks up live between layout changes — the hook
  // only updates `layoutCommittedAt` at the moment a layout actually
  // changes, so this component re-renders itself on a light interval to
  // keep the elapsed-time readout moving without touching the hot render path.
  const [, forceTick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(forceTick, 500);
    return () => clearInterval(id);
  }, []);

  const bucket = classifyLayout(mode, speakerCount, isTransitioning);
  // Deliberately impure: this is a ticking clock readout, re-rendered every
  // 500ms by forceTick above specifically so this recomputes with a fresh time.
  // eslint-disable-next-line react-hooks/purity
  const stableSeconds = metrics.layoutCommittedAt !== null ? (performance.now() - metrics.layoutCommittedAt) / 1000 : 0;
  const currentTime = duration * progress;

  return (
    <div className="flex flex-col gap-4 p-4 rounded-xl bg-neutral-950 border border-neutral-800/60 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04),0_8px_24px_-12px_rgba(0,0,0,0.6)] w-full md:w-96 md:shrink-0 max-h-[45vh] md:max-h-full overflow-y-auto">
      <h2 className="text-xs font-display font-semibold text-neutral-300 tracking-wide">
        Live <span className="text-brand-400">Analytics</span>
      </h2>

      <div className="rounded-lg border border-neutral-800/60 bg-neutral-900/40 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04),0_8px_24px_-12px_rgba(0,0,0,0.6)] p-3">
        <LiveAnalyticsCharts metrics={metrics} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Section title="Video">
          <Row label="Resolution" value={meta ? `${meta.width}×${meta.height}` : "—"} />
          <Row label="Aspect" value={mode} />
          <Row label="Time" value={`${formatTime(currentTime)} / ${formatTime(duration)}`} />
        </Section>

        <Section title="Detection">
          <Row label="Speakers" value={String(speakerCount)} />
          <Row label="Layout" value={LAYOUT_LABEL[bucket](speakerCount)} />
          <Row
            label="Crop Scale"
            value={metrics.cropScaleFactor !== null ? `${metrics.cropScaleFactor.toFixed(2)}×` : "—"}
          />
        </Section>

        <Section title="Face Boxes">
          <Row
            label="Sizes"
            value={metrics.faceSizes.length > 0 ? metrics.faceSizes.map((s) => `${s.toFixed(1)}%`).join(", ") : "—"}
          />
        </Section>

        <Section title="Scene">
          <Row label="Stable For" value={metrics.layoutCommittedAt !== null ? `${stableSeconds.toFixed(1)}s` : "—"} />
          <Row label="Switch Count" value={String(metrics.sceneSwitchCount)} />
        </Section>
      </div>

      {streamHealth && <StreamHealthSection streamHealth={streamHealth} />}
    </div>
  );
});
