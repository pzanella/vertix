import { memo, useState } from "react";
import type { StreamHealth } from "../../hooks/useWasmReframe";
import { bufferHealthTone, droppedFramesTone, formatBytes } from "./dashboardFormat";
import { Row, Section } from "./dashboardPrimitives";

interface StreamHealthOverlayProps {
  streamHealth: StreamHealth | null;
}

function NetworkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M4 20h2v-4H4v4zm7 0h2v-8h-2v8zm7 0h2V6h-2v14z" />
    </svg>
  );
}

// Lives as a button+panel overlaid on the video itself rather than in the
// sidebar — network health is the one metric someone would actually want
// to check without the rest of the dashboard open, and an always-visible
// panel there took space the video could use instead.
export const StreamHealthOverlay = memo(function StreamHealthOverlay({ streamHealth }: StreamHealthOverlayProps) {
  const [open, setOpen] = useState(false);
  if (!streamHealth) return null;

  const {
    manifestType,
    bufferHealthSec,
    bandwidthEstimateKbps,
    droppedFrames,
    totalDecodedFrames,
    activeVariant,
    bytesDownloaded,
    stallsDetected,
    qualitySwitches,
  } = streamHealth;
  const isAdaptive = manifestType === "HLS" || manifestType === "DASH";

  return (
    <div className="absolute top-3 right-3 z-10 flex flex-col items-end gap-2">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Stream health"
        className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center border transition ${
          open
            ? "bg-brand-600 border-brand-500 text-white"
            : "bg-neutral-900/80 border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600"
        }`}
      >
        <NetworkIcon />
      </button>
      {open && (
        <div className="w-56 rounded-lg border border-neutral-800/60 bg-neutral-950/95 backdrop-blur-sm shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)] p-3">
          {manifestType === "LOCAL" ? (
            <p className="text-[11px] text-neutral-600">Local file — no network metrics.</p>
          ) : (
            <Section title="Stream Health">
              <Row
                label="Buffer Health"
                value={`${bufferHealthSec.toFixed(1)}s ahead`}
                tone={bufferHealthTone(bufferHealthSec)}
              />
              {isAdaptive && bandwidthEstimateKbps !== null && (
                <Row label="Bandwidth Est." value={`${bandwidthEstimateKbps} kbps`} />
              )}
              <Row
                label="Dropped Frames"
                value={`${droppedFrames} / ${totalDecodedFrames}`}
                tone={droppedFramesTone(droppedFrames, totalDecodedFrames)}
              />
              {isAdaptive && activeVariant && (
                <Row label="Active Variant" value={`${activeVariant.height}p @ ${activeVariant.bitrateKbps}kbps`} />
              )}
              <Row label="Downloaded" value={formatBytes(bytesDownloaded)} />
              <Row label="Stalls" value={String(stallsDetected)} tone={stallsDetected > 0 ? "warn" : "default"} />
              {isAdaptive && qualitySwitches !== null && <Row label="Quality Switches" value={String(qualitySwitches)} />}
            </Section>
          )}
        </div>
      )}
    </div>
  );
});
