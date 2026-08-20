import type { ReframeMode } from "../../hooks/useWasmReframe";

export type LayoutBucket = "original" | "transition" | "broll" | "single" | "dual" | "grid";

/** Classifies the current on-screen layout into one bucket — shared by LiveStatusPanel and AnalyticsDashboard, which each render it with their own wording. */
export function classifyLayout(mode: ReframeMode, speakerCount: number, isTransitioning: boolean): LayoutBucket {
  if (mode === "16:9") return "original";
  if (isTransitioning) return "transition";
  if (speakerCount === 0) return "broll";
  if (speakerCount === 1) return "single";
  if (speakerCount === 2) return "dual";
  return "grid";
}
