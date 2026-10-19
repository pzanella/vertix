import { MetricRow } from "../../components/Player/MetricRow";
import { MetricSection } from "../../components/Player/MetricSection";
import { ToggleSwitch } from "../../components/Player/ToggleSwitch";
import type { FaceMeshStatus } from "./FaceMeshController";
import { MESH_STYLES, type MeshStyleId } from "./meshStyles";

interface FaceMeshPanelProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  style: MeshStyleId;
  onStyleChange: (style: MeshStyleId) => void;
  status: FaceMeshStatus | null;
}

function stateValue(status: FaceMeshStatus): { value: string; tone: "default" | "good" | "warn" | "bad" } {
  if (status.state === "failed") return { value: `failed: ${status.reason ?? "unknown"}`, tone: "bad" };
  if (status.state === "loading") {
    // Re-rendered by the dashboard's own 500 ms tick.
    const seconds = status.loadingSinceMs !== null ? (performance.now() - status.loadingSinceMs) / 1000 : 0;
    return { value: `loading… ${seconds.toFixed(0)} s`, tone: "warn" };
  }
  return { value: "ready", tone: "good" };
}

/** The "Face mesh" demo switch: a visual overlay only, nothing Vertix decides depends on it. */
export function FaceMeshPanel({ enabled, onEnabledChange, style, onStyleChange, status }: FaceMeshPanelProps) {
  const state = status ? stateValue(status) : null;
  return (
    <MetricSection title="Face Mesh (demo)">
      <ToggleSwitch label="Face mesh" checked={enabled} onChange={onEnabledChange} />
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-neutral-500">Style</span>
        <div role="radiogroup" aria-label="Face mesh style" className="flex gap-1">
          {Object.values(MESH_STYLES).map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={style === option.id}
              onClick={() => onStyleChange(option.id)}
              className={`px-1.5 py-0.5 rounded text-[11px] transition-colors ${
                style === option.id
                  ? "bg-brand-600 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {status && state && (
        <>
          <MetricRow label="State" value={state.value} tone={state.tone} />
          <MetricRow label="Mode" value={status.mode ?? "—"} tone={status.mode === "steps" ? "warn" : "default"} />
          <MetricRow
            label="Landmarks Behind"
            value={status.behind ? "yes" : "no"}
            tone={status.behind ? "warn" : "default"}
          />
          <MetricRow
            label="Min Delay"
            value={status.minimumLookaheadMs !== null ? `${status.minimumLookaheadMs} ms` : "—"}
          />
          {status.blockedRequests > 0 && <MetricRow label="Blocked Requests" value={String(status.blockedRequests)} />}
        </>
      )}
    </MetricSection>
  );
}
