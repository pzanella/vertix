// Plain formatting/tone helpers shared between AnalyticsDashboard and
// StreamHealthOverlay — split out from dashboardPrimitives.tsx (components
// only) so that file stays a clean Fast Refresh boundary.

export const TONE_CLASS = {
  default: "text-neutral-200",
  good: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-red-400",
} as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function bufferHealthTone(seconds: number): keyof typeof TONE_CLASS {
  if (seconds > 5) return "good";
  if (seconds > 1) return "warn";
  return "bad";
}

export function droppedFramesTone(dropped: number, total: number): keyof typeof TONE_CLASS {
  if (total === 0) return "default";
  return dropped / total > 0.02 ? "bad" : "default";
}
