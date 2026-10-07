/** Titled group of MetricRows, shared by AnalyticsDashboard and StreamHealthOverlay. */
export function MetricSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-mono font-semibold uppercase tracking-widest text-neutral-600">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
