// Small display components shared between AnalyticsDashboard (the sidebar)
// and StreamHealthOverlay (the video-overlay panel) — kept here instead of
// duplicated in both. See dashboardFormat.ts for the non-component helpers
// (tone/formatting) used alongside these.
import { TONE_CLASS } from "./dashboardFormat";

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[10px] font-mono font-semibold uppercase tracking-widest text-neutral-600">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

export function Row({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: keyof typeof TONE_CLASS;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className={`font-mono tabular-nums text-right ${TONE_CLASS[tone]}`}>{value}</span>
    </div>
  );
}
