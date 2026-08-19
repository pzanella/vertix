import type { ReframeMode } from "../../hooks/useWasmReframe";

const MODES: { mode: ReframeMode; label: string }[] = [
  { mode: "original", label: "16:9" },
  { mode: "reframed", label: "9:16 Smart" },
  { mode: "wide", label: "9:16 Wide" },
  { mode: "fit", label: "9:16 Fit" },
];

interface ControlsProps {
  playing: boolean;
  mode: ReframeMode;
  muted: boolean;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onSetMode: (mode: ReframeMode) => void;
}

export function Controls({
  playing,
  mode,
  muted,
  onTogglePlay,
  onToggleMute,
  onSetMode,
}: ControlsProps) {
  return (
    <div className="flex items-center justify-between w-full px-2">
      <button
        onClick={onTogglePlay}
        className="rounded-full w-10 h-10 flex items-center justify-center bg-brand-600 hover:bg-brand-500 transition"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-5 h-5"
          >
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-5 h-5"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      <button
        onClick={onToggleMute}
        className="rounded-full w-10 h-10 flex items-center justify-center bg-neutral-800 hover:bg-neutral-700 transition"
        aria-label={muted ? "Unmute" : "Mute"}
      >
        {muted ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-neutral-400">
            <path d="M11 5L6 9H2v6h4l5 4V5zm9.54 5.46a1 1 0 0 0-1.42 0L17 12.59l-2.12-2.13a1 1 0 1 0-1.42 1.42L15.59 14l-2.13 2.12a1 1 0 1 0 1.42 1.42L17 15.41l2.12 2.13a1 1 0 0 0 1.42-1.42L18.41 14l2.13-2.12a1 1 0 0 0 0-1.42z" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
            <path d="M11 5L6 9H2v6h4l5 4V5zm2 4.06c1.18.45 2 1.56 2 2.94s-.82 2.49-2 2.94v-5.88zM13 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          </svg>
        )}
      </button>

      <div className="flex rounded-lg overflow-hidden border border-neutral-700">
        {MODES.map(({ mode: m, label }) => (
          <button
            key={m}
            onClick={() => onSetMode(m)}
            className={`px-3 py-1 text-sm transition ${
              mode === m
                ? "bg-brand-600 text-white"
                : "bg-neutral-800 text-neutral-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
