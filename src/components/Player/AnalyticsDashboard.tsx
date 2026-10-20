import { memo, useEffect, useReducer } from "react";
import type { ReframeMeta, ReframeMetrics, ReframeMode } from "../../hooks/useWasmReframe";
import type { LayoutRule, ShotType } from "../../core";
import { classifyLayout, type LayoutBucket } from "./layoutStatus";
import { LiveAnalyticsCharts } from "./LiveAnalyticsCharts";
import { TONE_CLASS, formatBytes } from "./dashboardFormat";
import { MetricRow } from "./MetricRow";
import { MetricSection } from "./MetricSection";
import { ToggleSwitch } from "./ToggleSwitch";

interface AnalyticsDashboardProps {
  mode: ReframeMode;
  meta: ReframeMeta | null;
  progress: number;
  duration: number;
  speakerCount: number;
  isTransitioning: boolean;
  layoutRule: LayoutRule;
  shotType: ShotType;
  sourceShownAsIs: boolean;
  showTracks: boolean;
  onShowTracksChange: (show: boolean) => void;
  metrics: ReframeMetrics;
  /** Debug only (`?debug=skin`): how many detections the skin-tone filter threw away. */
  showSkinFilter?: boolean;
  onLookaheadChange: (enabled: boolean) => void;
  /** Extra sections from the host app (the "Face mesh" demo panel). */
  extraSections?: React.ReactNode;
}

const LOOKAHEAD_UNAVAILABLE_LABEL: Record<NonNullable<ReframeMetrics["lookahead"]["unavailableReason"]>, string> = {
  "no-audio-graph": "unavailable (no audio graph)",
  "cross-origin": "unavailable (cross-origin)",
  "silent-audio-path": "unavailable (silent audio)",
};

function lookaheadValue({
  enabled,
  unavailableReason,
  bypassed,
  lengthMs,
  delayFrames,
}: ReframeMetrics["lookahead"]): string {
  if (!enabled) return "off";
  if (unavailableReason) return LOOKAHEAD_UNAVAILABLE_LABEL[unavailableReason];
  if (bypassed) return "bypassed";
  return lengthMs > 0 ? `${lengthMs} ms (${delayFrames} frames)` : "—";
}

const LAYOUT_LABEL: Record<LayoutBucket, (speakerCount: number) => string> = {
  original: () => "Original View",
  "as-is": () => "Shown As Is",
  transition: () => "Transitioning...",
  broll: () => "No-Crop B-Roll",
  single: () => "Single Focus",
  stacked: () => "Dual Split",
  subject: () => "Main Subject",
  group: () => "Group",
  grid: (n) => `Panel Grid (${n})`,
};

const SHOT_LABEL: Record<ShotType, string> = {
  close: "Close",
  wide: "Wide (whole frame)",
  none: "No faces (whole frame)",
};

const RULE_LABEL: Record<LayoutRule, string> = {
  broll: "b-roll",
  single: "single",
  stacked: "stacked",
  subject: "main subject",
  group: "group",
  grid: "grid",
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
  layoutRule,
  shotType,
  sourceShownAsIs,
  showTracks,
  onShowTracksChange,
  metrics,
  showSkinFilter = false,
  onLookaheadChange,
  extraSections,
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

  const bucket = classifyLayout(mode, layoutRule, isTransitioning, sourceShownAsIs);
  // Deliberately impure: this is a ticking clock readout, re-rendered every
  // 500ms by forceTick above specifically so this recomputes with a fresh time.
  const stableSeconds = metrics.layoutCommittedAt !== null ? (performance.now() - metrics.layoutCommittedAt) / 1000 : 0;
  const currentTime = duration * progress;
  const lookahead = metrics.lookahead;

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
          {sourceShownAsIs && <MetricRow label="Source" value="Not landscape: shown as is" tone="warn" />}
          <MetricRow label="Time" value={`${formatTime(currentTime)} / ${formatTime(duration)}`} />
        </MetricSection>

        <MetricSection title="Detection">
          <MetricRow label="Speakers" value={String(speakerCount)} />
          <MetricRow label="Layout" value={LAYOUT_LABEL[bucket](speakerCount)} />
          <MetricRow label="Rule" value={mode === "9:16" && !sourceShownAsIs ? RULE_LABEL[layoutRule] : "—"} />
          <MetricRow label="Shot" value={mode === "9:16" && !sourceShownAsIs ? SHOT_LABEL[shotType] : "—"} />
          <ToggleSwitch label="Show tracks" checked={showTracks} onChange={onShowTracksChange} />
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
          <MetricRow label="Cuts Detected" value={String(metrics.sceneCutCount)} />
        </MetricSection>

        {extraSections}

        <MetricSection title="Lookahead">
          <ToggleSwitch
            label="Crop on cut frame"
            ariaLabel="Lookahead"
            checked={lookahead.enabled}
            onChange={onLookaheadChange}
          />
          <MetricRow
            label="Default"
            value={`${lookahead.enabledByDefault ? "On" : "Off"} with ${lookahead.enabledByDefault ? "SIMD" : "scalar"}${
              lookahead.setByHost ? " · switched" : ""
            }`}
          />
          <MetricRow
            label="Delay"
            value={lookaheadValue(lookahead)}
            tone={lookahead.enabled && lookahead.unavailableReason ? "warn" : "default"}
          />
          <MetricRow
            label="Frame Copy"
            value={lookahead.slotWidth !== null ? `${lookahead.slotWidth}×${lookahead.slotHeight}` : "—"}
          />
          <MetricRow
            label="Buffer"
            value={
              lookahead.allocatedSlots > 0
                ? `${lookahead.bufferedFrames}/${lookahead.allocatedSlots} · ${formatBytes(lookahead.bufferBytes)}`
                : "—"
            }
          />
          <MetricRow
            label="Dropped"
            value={String(lookahead.droppedFrames)}
            tone={lookahead.droppedFrames > 0 ? "warn" : "default"}
          />
        </MetricSection>

        {metrics.detectionHealth.message && (
          <div
            role="status"
            className={`md:col-span-2 rounded-md border px-2.5 py-1.5 text-xs ${
              metrics.detectionHealth.state === "stopped"
                ? "border-red-500/40 bg-red-500/10 text-red-300"
                : "border-amber-500/40 bg-amber-500/10 text-amber-200"
            }`}
          >
            {metrics.detectionHealth.message}
          </div>
        )}

        <MetricSection title="Performance">
          <MetricRow
            label="Detection"
            value={
              metrics.detectionHealth.state === "stopped"
                ? "Stopped"
                : metrics.detectionMode === "worker"
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
            label="Worker Restarts"
            value={String(metrics.detectionHealth.workerRestarts)}
            tone={metrics.detectionHealth.workerRestarts > 0 ? "warn" : "default"}
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
