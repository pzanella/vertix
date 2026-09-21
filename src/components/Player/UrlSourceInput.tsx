import { useState } from "react";
import type { PlayerState } from "../../hooks/useWasmReframe";

interface UrlSourceInputProps {
  state: PlayerState;
  errorMessage: string | null;
  onLoad: (url: string) => void;
}

// Single source of truth for both the accept-list regex and the cosmetic
// format badge — covers Shaka's two adaptive manifest formats plus every
// progressive container a browser's native <video> can typically decode on
// its own (Shaka falls back to plain native playback for these, no
// manifest parsing involved). Deliberately excludes containers with weak
// cross-browser native support (e.g. .mov, .mkv) so the badge/validation
// don't imply support this app can't actually deliver everywhere.
const FORMAT_BY_EXTENSION: Record<string, string> = {
  mp4: "MP4",
  m4v: "MP4",
  webm: "WEBM",
  ogg: "OGG",
  ogv: "OGG",
  m3u8: "HLS",
  mpd: "DASH",
};
const URL_PATTERN = new RegExp(`^https?:\\/\\/.+\\.(${Object.keys(FORMAT_BY_EXTENSION).join("|")})(\\?.*)?$`, "i");

function detectFormatBadge(url: string): string | null {
  const match = url.match(/\.([a-z0-9]+)(?:\?.*)?$/i);
  return match ? (FORMAT_BY_EXTENSION[match[1].toLowerCase()] ?? null) : null;
}

export function UrlSourceInput({ state, errorMessage, onLoad }: UrlSourceInputProps) {
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const isLoading = state === "loading";
  const badge = detectFormatBadge(value);
  // Only show the hook's error while this tab's own last submission is the
  // one that's still in flight/failed — a stale value shouldn't be blamed.
  const helperText = validationError ?? (state === "error" ? errorMessage : null);

  const submit = () => {
    const trimmed = value.trim();
    if (!URL_PATTERN.test(trimmed)) {
      setValidationError("Enter a direct video link (.mp4, .webm, .ogg) or a stream manifest (.m3u8, .mpd).");
      return;
    }
    setValidationError(null);
    onLoad(trimmed);
  };

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex w-full gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            type="text"
            value={value}
            disabled={isLoading}
            onChange={(e) => {
              setValue(e.target.value);
              if (validationError) setValidationError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="https://example.com/video.mp4, .webm, .m3u8, .mpd…"
            className={`w-full bg-neutral-900 border rounded-lg pl-3 pr-14 py-2 text-xs font-mono text-neutral-200 placeholder:text-neutral-600 outline-none transition disabled:opacity-50 ${
              helperText ? "border-red-500/60" : "border-neutral-700 focus:border-brand-500"
            }`}
          />
          {badge && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold tracking-wide text-neutral-500 bg-neutral-800 rounded px-1.5 py-0.5">
              {badge}
            </span>
          )}
        </div>
        <button
          onClick={submit}
          disabled={isLoading || value.trim().length === 0}
          className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:hover:bg-brand-600 text-xs font-medium transition"
        >
          {isLoading && <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
          Load
        </button>
      </div>
      <div className="h-4 px-0.5">
        {helperText && <p className="text-red-400 text-[11px] leading-4">{helperText}</p>}
      </div>
    </div>
  );
}
