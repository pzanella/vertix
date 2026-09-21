import { memo } from "react";
import type { ReframeMode } from "../../hooks/useWasmReframe";
import { classifyLayout } from "./layoutStatus";

interface LiveStatusPanelProps {
  mode: ReframeMode;
  speakerCount: number;
  isTransitioning: boolean;
}

const LABEL: Record<ReturnType<typeof classifyLayout>, (speakerCount: number) => string> = {
  original: () => "Original View",
  transition: () => "Scene Transition...",
  broll: () => "Scene Action / B-Roll",
  single: () => "Active Speaker (Speaker 1)",
  dual: () => "Dual Focus (Speakers 1 & 2)",
  grid: (n) => `Multi-Speaker Grid (${n} Speakers)`,
};

const DOT: Record<ReturnType<typeof classifyLayout>, string> = {
  original: "bg-neutral-500",
  transition: "bg-amber-400",
  broll: "bg-purple-400",
  single: "bg-emerald-400",
  dual: "bg-sky-400",
  grid: "bg-sky-400",
};

export const LiveStatusPanel = memo(function LiveStatusPanel({
  mode,
  speakerCount,
  isTransitioning,
}: LiveStatusPanelProps) {
  const bucket = classifyLayout(mode, speakerCount, isTransitioning);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-neutral-900 border border-neutral-800 text-xs text-neutral-300 w-fit">
      <span
        className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${DOT[bucket]} ${isTransitioning ? "animate-pulse" : ""}`}
      />
      <span>Status: {LABEL[bucket](speakerCount)}</span>
    </div>
  );
});
