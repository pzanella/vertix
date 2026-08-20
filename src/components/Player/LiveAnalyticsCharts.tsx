import { memo } from "react";
import type { ReframeMetrics } from "../../hooks/useWasmReframe";

interface LiveAnalyticsChartsProps {
  metrics: ReframeMetrics;
}

interface ChartSpec {
  label: string;
  color: string;
  data: number[];
  value: string;
}

/** A minimal inline SVG trend line — no charting library, just a polyline scaled to its own data range. */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const width = 220;
  const height = 44;

  if (data.length < 2) {
    return (
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" className="text-neutral-800" strokeWidth={1} />
      </svg>
    );
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pad = 2;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = pad + (height - pad * 2) * (1 - (v - min) / range);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={areaPoints} fill={color} fillOpacity={0.12} stroke="none" />
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function ChartRow({ label, color, data, value }: ChartSpec) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-neutral-500">{label}</span>
        <span className="font-mono tabular-nums" style={{ color }}>
          {value}
        </span>
      </div>
      <Sparkline data={data} color={color} />
    </div>
  );
}

// A Pro-Tools/Resolve-style dark palette — one accent hue per metric, kept
// consistent everywhere that metric appears.
const COLOR = {
  fps: "#2dd4bf", // teal — matches the app's brand accent
  confidence: "#38bdf8", // sky
  motion: "#a78bfa", // violet
  latency: "#fb923c", // amber
} as const;

export const LiveAnalyticsCharts = memo(function LiveAnalyticsCharts({ metrics }: LiveAnalyticsChartsProps) {
  return (
    <div className="flex flex-col gap-3">
      <ChartRow
        label="FPS Trend"
        color={COLOR.fps}
        data={metrics.fpsHistory}
        value={metrics.fps > 0 ? metrics.fps.toFixed(1) : "—"}
      />
      <ChartRow
        label="Face Confidence"
        color={COLOR.confidence}
        data={metrics.confidenceHistory}
        value={metrics.faceConfidence !== null ? `${(metrics.faceConfidence * 100).toFixed(0)}%` : "—"}
      />
      <ChartRow
        label="Motion Activity"
        color={COLOR.motion}
        data={metrics.motionHistory}
        value={metrics.motionScore !== null ? metrics.motionScore.toFixed(1) : "—"}
      />
      <ChartRow
        label="Render Latency"
        color={COLOR.latency}
        data={metrics.frameTimeHistory}
        value={metrics.frameTimeMs > 0 ? `${metrics.frameTimeMs.toFixed(1)}ms` : "—"}
      />
    </div>
  );
});
