import type { ReframeMode } from "../../hooks/useWasmReframe";
import type { LayoutRule, ShotType } from "../../core";

export type LayoutBucket = "original" | "as-is" | "transition" | "wide" | LayoutRule;

/** Classifies the current on-screen layout into one bucket — shared by LiveStatusPanel and AnalyticsDashboard, which each render it with their own wording. */
export function classifyLayout(
  mode: ReframeMode,
  rule: LayoutRule,
  isTransitioning: boolean,
  sourceShownAsIs: boolean,
  shotType: ShotType
): LayoutBucket {
  if (sourceShownAsIs) return "as-is";
  if (mode === "16:9") return "original";
  if (isTransitioning) return "transition";
  if (shotType === "wide" && rule === "broll") return "wide";
  return rule;
}
