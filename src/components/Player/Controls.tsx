import { memo, type ReactNode } from "react";
import type { ReframeMode } from "../../hooks/useWasmReframe";

interface ControlsProps {
  playing: boolean;
  /** True once playback has reached the end — swaps the transport button to a distinct replay icon/action instead of play/pause. */
  ended: boolean;
  mode: ReframeMode;
  muted: boolean;
  onTogglePlay: () => void;
  onReplay: () => void;
  onToggleMute: () => void;
  onSetMode: (mode: ReframeMode) => void;
  /** Rendered in the middle of the bar (the scrub timeline) — kept as a slot so this stays a single compact transport-bar row instead of a separate stacked row. */
  middle?: ReactNode;
}

export const Controls = memo(function Controls({
  playing,
  ended,
  mode,
  muted,
  onTogglePlay,
  onReplay,
  onToggleMute,
  onSetMode,
  middle,
}: ControlsProps) {
  return (
    <div className="flex items-center w-full px-2 gap-2">
      <button
        onClick={ended ? onReplay : onTogglePlay}
        className="shrink-0 rounded-full w-8 h-8 flex items-center justify-center bg-brand-600 hover:bg-brand-500 transition"
        aria-label={ended ? "Replay" : playing ? "Pause" : "Play"}
      >
        {ended ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
          </svg>
        ) : playing ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      <button
        onClick={onToggleMute}
        aria-pressed={!muted}
        className="shrink-0 rounded-full w-8 h-8 flex items-center justify-center bg-neutral-800 hover:bg-neutral-700 transition"
        aria-label={muted ? "Unmute" : "Mute"}
      >
        {muted ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-4 h-4 text-neutral-500"
          >
            <path d="M11 5L6 9H2v6h4l5 4V5zm9.54 5.46a1 1 0 0 0-1.42 0L17 12.59l-2.12-2.13a1 1 0 1 0-1.42 1.42L15.59 14l-2.13 2.12a1 1 0 1 0 1.42 1.42L17 15.41l2.12 2.13a1 1 0 0 0 1.42-1.42L18.41 14l2.13-2.12a1 1 0 0 0 0-1.42z" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-4 h-4 text-white"
          >
            <path d="M11 5L6 9H2v6h4l5 4V5zm2 4.06c1.18.45 2 1.56 2 2.94s-.82 2.49-2 2.94v-5.88zM13 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          </svg>
        )}
      </button>

      {middle && <div className="flex-1 min-w-0">{middle}</div>}

      <button
        onClick={() => onSetMode(mode === "16:9" ? "9:16" : "16:9")}
        className="shrink-0 relative flex items-center h-7 rounded-full bg-neutral-800 border border-neutral-700 p-0.5 transition"
        aria-label={`Switch to ${mode === "16:9" ? "9:16" : "16:9"}`}
      >
        <span
          className={`absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-full bg-brand-600 transition-transform duration-200 ease-out ${
            mode === "9:16" ? "translate-x-[calc(100%+2px)]" : "translate-x-0"
          }`}
        />
        <span
          className={`relative z-10 px-2.5 text-[11px] font-medium whitespace-nowrap transition-colors ${
            mode === "16:9" ? "text-white" : "text-neutral-500"
          }`}
        >
          16:9
        </span>
        <span
          className={`relative z-10 px-2.5 text-[11px] font-medium whitespace-nowrap transition-colors ${
            mode === "9:16" ? "text-white" : "text-neutral-500"
          }`}
        >
          9:16
        </span>
      </button>
    </div>
  );
});
