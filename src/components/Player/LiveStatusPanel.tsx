import { memo } from "react";
import type { ReframeMode } from "../../hooks/useWasmReframe";
import type { LayoutRule } from "../../core";
import { classifyLayout, type LayoutBucket } from "./layoutStatus";

interface LiveStatusPanelProps {
  mode: ReframeMode;
  speakerCount: number;
  isTransitioning: boolean;
  layoutRule: LayoutRule;
  sourceShownAsIs: boolean;
}

const LABEL: Record<LayoutBucket, (speakerCount: number) => string> = {
  original: () => "Original View",
  "as-is": () => "Source is not landscape: shown as is",
  transition: () => "Scene Transition...",
  broll: () => "Scene Action / B-Roll",
  single: () => "Single Speaker",
  stacked: () => "Dual Focus (Speakers 1 & 2)",
  subject: () => "Main Subject",
  group: () => "Group",
  grid: (n) => `Panel Grid (${n} Speakers)`,
};

const DOT: Record<LayoutBucket, string> = {
  original: "bg-neutral-500",
  "as-is": "bg-neutral-500",
  transition: "bg-amber-400",
  broll: "bg-purple-400",
  single: "bg-emerald-400",
  stacked: "bg-sky-400",
  subject: "bg-emerald-400",
  group: "bg-sky-400",
  grid: "bg-sky-400",
};

export const LiveStatusPanel = memo(function LiveStatusPanel({
  mode,
  speakerCount,
  isTransitioning,
  layoutRule,
  sourceShownAsIs,
}: LiveStatusPanelProps) {
  const bucket = classifyLayout(mode, layoutRule, isTransitioning, sourceShownAsIs);

  return (
    <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-neutral-900 border border-neutral-800 text-xs text-neutral-300 w-fit">
      <span
        className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${DOT[bucket]} ${isTransitioning ? "animate-pulse" : ""}`}
      />
      <span>Status: {LABEL[bucket](speakerCount)}</span>
    </div>
  );
});
