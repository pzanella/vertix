import { memo, useEffect, useReducer } from "react";
import type { ReframeMeta, ReframeMetrics, ReframeMode } from "../../hooks/useWasmReframe";
import { classifyLayout } from "./layoutStatus";
import { LiveAnalyticsCharts } from "./LiveAnalyticsCharts";
import { TONE_CLASS } from "./dashboardFormat";
import { Row, Section } from "./dashboardPrimitives";

interface AnalyticsDashboardProps {
  mode: ReframeMode;
  meta: ReframeMeta | null;
  progress: number;
  duration: number;
  speakerCount: number;
  isTransitioning: boolean;
  metrics: ReframeMetrics;
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

function longTaskTone(ms: number): keyof typeof TONE_CLASS {
  if (ms > 1500) return "bad";
  if (ms > 500) return "warn";
  return "good";
}

export const AnalyticsDashboard = memo(function AnalyticsDashboard({
  mode,
  meta,
  progress,
  duration,
  speakerCount,
  isTransitioning,
  metrics,
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

        <Section title="Voice Activity">
          <Row label="Audio Track" value={metrics.audioAvailable ? "readable" : "unavailable"} />
          <Row label="Energy" value={metrics.audioEnergy !== null ? metrics.audioEnergy.toFixed(3) : "—"} />
        </Section>

        <Section title="Scene">
          <Row label="Stable For" value={metrics.layoutCommittedAt !== null ? `${stableSeconds.toFixed(1)}s` : "—"} />
          <Row label="Switch Count" value={String(metrics.sceneSwitchCount)} />
        </Section>

        <Section title="Performance">
          <Row
            label="Detection"
            value={metrics.detectionMode === "worker" ? "Worker" : metrics.detectionMode === "main-thread" ? "Main Thread" : "—"}
            tone={metrics.detectionMode === "worker" ? "good" : metrics.detectionMode === "main-thread" ? "warn" : "default"}
          />
          <Row
            label="Main Thread"
            value={metrics.longTasksSupported ? `${metrics.longTaskMs.toFixed(0)}ms / 3s` : "n/a"}
            tone={metrics.longTasksSupported ? longTaskTone(metrics.longTaskMs) : "default"}
          />
        </Section>
      </div>
    </div>
  );
});
