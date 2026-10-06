import { TONE_CLASS } from "./dashboardFormat";

interface MetricRowProps {
  label: string;
  value: string;
  tone?: keyof typeof TONE_CLASS;
}

/** One label/value line of a MetricSection; `tone` colors the value. */
export function MetricRow({ label, value, tone = "default" }: MetricRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className={`font-mono tabular-nums text-right ${TONE_CLASS[tone]}`}>{value}</span>
    </div>
  );
}
