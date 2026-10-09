import { memo, useEffect, useReducer } from "react";
import type { ReframeMeta, ReframeMetrics, ReframeMode } from "../../hooks/useWasmReframe";
import { classifyLayout } from "./layoutStatus";
import { LiveAnalyticsCharts } from "./LiveAnalyticsCharts";
import { TONE_CLASS } from "./dashboardFormat";
import { MetricRow } from "./MetricRow";
import { MetricSection } from "./MetricSection";

interface AnalyticsDashboardProps {
  mode: ReframeMode;
  meta: ReframeMeta | null;
  progress: number;
  duration: number;
  speakerCount: number;
  isTransitioning: boolean;
  metrics: ReframeMetrics;
  /** Debug only (`?debug=skin`): how many detections the skin-tone filter threw away. */
  showSkinFilter?: boolean;
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
  showSkinFilter = false,
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
    <aside className="flex flex-col gap-3 w-full md:w-[22rem] md:shrink-0 md:h-full md:overflow-y-auto md:overscroll-contain md:pr-2 [scrollbar-width:thin] [scrollbar-color:theme(colors.neutral.800)_transparent]">
      <h2 className="md:sticky md:top-0 md:z-10 md:bg-neutral-950 md:pb-1 text-sm font-display font-semibold text-neutral-300 tracking-wide">
        Live <span className="text-brand-400">Analytics</span>
      </h2>

      <div className="rounded-lg p-0">
        <LiveAnalyticsCharts metrics={metrics} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
        <MetricSection title="Video">
          <MetricRow label="Resolution" value={meta ? `${meta.width}×${meta.height}` : "—"} />
          <MetricRow label="Aspect" value={mode} />
          <MetricRow label="Time" value={`${formatTime(currentTime)} / ${formatTime(duration)}`} />
        </MetricSection>

        <MetricSection title="Detection">
          <MetricRow label="Speakers" value={String(speakerCount)} />
          <MetricRow label="Layout" value={LAYOUT_LABEL[bucket](speakerCount)} />
          <MetricRow
            label="Crop Scale"
            value={metrics.cropScaleFactor !== null ? `${metrics.cropScaleFactor.toFixed(2)}×` : "—"}
          />
        </MetricSection>

        {showSkinFilter && (
          <MetricSection title="Skin Filter">
            <MetricRow label="Rejected" value={String(metrics.skinRejectedTotal)} />
            <MetricRow
              label="Speaker-Size"
              value={String(metrics.skinRejectedSpeakerSized)}
              tone={metrics.skinRejectedSpeakerSized > 0 ? "warn" : "default"}
            />
          </MetricSection>
        )}

        <MetricSection title="Face Boxes">
          <MetricRow
            label="Sizes"
            value={metrics.faceSizes.length > 0 ? metrics.faceSizes.map((s) => `${s.toFixed(1)}%`).join(", ") : "—"}
          />
        </MetricSection>

        <MetricSection title="Voice Activity">
          <MetricRow label="Audio Track" value={metrics.audioAvailable ? "readable" : "unavailable"} />
          <MetricRow label="Energy" value={metrics.audioEnergy !== null ? metrics.audioEnergy.toFixed(3) : "—"} />
        </MetricSection>

        <MetricSection title="Scene">
          <MetricRow
            label="Stable For"
            value={metrics.layoutCommittedAt !== null ? `${stableSeconds.toFixed(1)}s` : "—"}
          />
          <MetricRow label="Switch Count" value={String(metrics.sceneSwitchCount)} />
        </MetricSection>

        <MetricSection title="Performance">
          <MetricRow
            label="Detection"
            value={
              metrics.detectionMode === "worker"
                ? "Worker"
                : metrics.detectionMode === "main-thread"
                  ? "Main Thread"
                  : "—"
            }
            tone={
              metrics.detectionMode === "worker" ? "good" : metrics.detectionMode === "main-thread" ? "warn" : "default"
            }
          />
          <MetricRow
            label="Detect Rate"
            value={metrics.detectionRateHz !== null ? `${metrics.detectionRateHz.toFixed(1)} Hz` : "—"}
          />
          <MetricRow
            label="Main Thread"
            value={metrics.longTasksSupported ? `${metrics.longTaskMs.toFixed(0)}ms / 3s` : "n/a"}
            tone={metrics.longTasksSupported ? longTaskTone(metrics.longTaskMs) : "default"}
          />
        </MetricSection>
      </div>
    </aside>
  );
});
