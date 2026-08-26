import { useCallback, useEffect, useRef, useState } from "react";
import shaka from "shaka-player";
import { VertixEngine, type VertixMeta, type VertixMetrics, type VertixMode } from "../core";

// Shaka's required setup step — installs cross-browser MediaSource/EME
// shims. Must run before any shaka.Player is constructed.
shaka.polyfill.installAll();

export type ReframeMode = VertixMode;
export type ReframeMeta = VertixMeta;
export type ReframeMetrics = VertixMetrics;
export type PlayerState = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";

/** Cosmetic-only classification of the loaded source — doesn't affect how Shaka loads it. HLS/DASH are adaptive (ABR ladder); PROGRESSIVE is any plain file (mp4, webm, ogg, ...); LOCAL is a local blob URL. */
export type StreamManifestType = "HLS" | "DASH" | "PROGRESSIVE" | "LOCAL";

export interface StreamHealth {
  manifestType: StreamManifestType;
  bufferHealthSec: number;
  /** Only meaningful for adaptive HLS/DASH streams — null for PROGRESSIVE/LOCAL (no ABR ladder to estimate against). */
  bandwidthEstimateKbps: number | null;
  droppedFrames: number;
  totalDecodedFrames: number;
  /** Currently active HLS/DASH rendition — null unless manifestType is HLS or DASH. */
  activeVariant: { height: number; bitrateKbps: number } | null;
}

const GENERIC_ERROR_MESSAGE = "That file didn't load. Try a different video.";

/** Narrow typed views onto Shaka's custom event payloads — `Player.addEventListener` itself is typed as plain `Event` in the shipped externs, so these fields (added at runtime via `shaka.util.FakeEvent`) aren't otherwise visible to TS. */
interface ShakaErrorEvent extends Event {
  detail: InstanceType<typeof shaka.util.Error>;
}
interface ShakaBufferingEvent extends Event {
  buffering: boolean;
}

function isShakaError(err: unknown): err is InstanceType<typeof shaka.util.Error> {
  return err instanceof shaka.util.Error;
}

/** Reverse-looks-up a `shaka.util.Error.Code` numeric value to its enum member name (e.g. "HLS_REQUIRED_TAG_MISSING") — needed because HLS- and DASH-prefixed codes share the same MANIFEST category and numeric range, so only the name tells them apart. */
function shakaErrorCodeName(code: number): string {
  const entry = Object.entries(shaka.util.Error.Code).find(([, value]) => value === code);
  return entry?.[0] ?? "";
}

/** Maps a Shaka load failure (from the `error` event or a rejected `player.load()`) to a user-facing message. Isolates the one spot in this app that reaches into Shaka's error shape (`error.data` is untyped upstream). */
function mapShakaError(err: unknown): string {
  if (!isShakaError(err)) return GENERIC_ERROR_MESSAGE;

  const { category, code, data } = err as { category: number; code: number; data: unknown[] };

  if (category === shaka.util.Error.Category.NETWORK) {
    if (code === shaka.util.Error.Code.BAD_HTTP_STATUS) {
      const status = typeof data?.[1] === "number" ? data[1] : null;
      if (status === 404) return "That URL doesn't point to a video (404 Not Found).";
      if (status === 0) return "This video's server doesn't allow playback from this site (likely CORS).";
      return "Couldn't reach that URL. Check the address and your connection.";
    }
    if (code === shaka.util.Error.Code.HTTP_ERROR) {
      // A failed XHR/fetch with no HTTP status at all almost always means the
      // browser blocked the request outright — in practice this is CORS.
      return "This video's server doesn't allow playback from this site (likely CORS).";
    }
    if (code === shaka.util.Error.Code.TIMEOUT) {
      return "Couldn't reach that URL. Check the address and your connection.";
    }
    return "Couldn't reach that URL. Check the address and your connection.";
  }

  if (category === shaka.util.Error.Category.MANIFEST) {
    const codeName = shakaErrorCodeName(code);
    if (codeName.startsWith("HLS_")) return "This stream's playlist is invalid or unsupported.";
    if (codeName.startsWith("DASH_")) return "This stream's manifest is invalid or unsupported.";
    return "This stream's manifest is invalid or unsupported.";
  }

  if (category === shaka.util.Error.Category.DRM) {
    return "This video is protected and can't be played here.";
  }

  return GENERIC_ERROR_MESSAGE;
}

/** Derives a MIME type from a URL's extension, passed to `player.load()` to skip Shaka's own content-type sniffing — that sniffing fails in practice (empty codecs, rejected by the browser). Returns undefined for extension-less sources (blob: URLs); callers must supply an explicit hint for those instead. */
function mimeTypeForExtension(src: string): string | undefined {
  const match = src.match(/\.([a-z0-9]+)(?:\?.*)?$/i);
  switch (match?.[1]?.toLowerCase()) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "ogg":
    case "ogv":
      return "video/ogg";
    case "m3u8":
      return "application/x-mpegURL";
    case "mpd":
      return "application/dash+xml";
    default:
      return undefined;
  }
}

function classifyManifestType(src: string): StreamManifestType {
  if (src.startsWith("blob:")) return "LOCAL";
  if (/\.m3u8(\?.*)?$/i.test(src)) return "HLS";
  if (/\.mpd(\?.*)?$/i.test(src)) return "DASH";
  return "PROGRESSIVE";
}

function computeBufferHealthSec(bufferedInfo: shaka.extern.BufferedInfo, currentTime: number): number {
  const range = bufferedInfo.total.find((r) => currentTime >= r.start && currentTime <= r.end);
  return range ? Math.max(0, range.end - currentTime) : 0;
}

function computeStreamHealth(player: shaka.Player, video: HTMLVideoElement, manifestType: StreamManifestType): StreamHealth {
  const stats = player.getStats();
  const bufferHealthSec = computeBufferHealthSec(player.getBufferedInfo(), video.currentTime);
  const isAdaptive = manifestType === "HLS" || manifestType === "DASH";

  let activeVariant: StreamHealth["activeVariant"] = null;
  if (isAdaptive) {
    const activeTrack = player.getVariantTracks().find((t) => t.active);
    if (activeTrack && activeTrack.height !== null) {
      activeVariant = { height: activeTrack.height, bitrateKbps: Math.round(activeTrack.bandwidth / 1000) };
    }
  }

  return {
    manifestType,
    bufferHealthSec,
    bandwidthEstimateKbps: isAdaptive ? Math.round(stats.estimatedBandwidth / 1000) : null,
    droppedFrames: stats.droppedFrames,
    totalDecodedFrames: stats.decodedFrames,
    activeVariant,
  };
}

const INITIAL_METRICS: VertixMetrics = {
  fps: 0,
  frameTimeMs: 0,
  faceSizes: [],
  cropScaleFactor: null,
  motionScore: null,
  faceConfidence: null,
  layoutCommittedAt: null,
  sceneSwitchCount: 0,
  fpsHistory: [],
  frameTimeHistory: [],
  motionHistory: [],
  confidenceHistory: [],
};

// Cadence for both the video's own error-recovery/loadedmetadata handling and
// the stream-health poll below — kept no faster than VertixEngine's own
// ~300ms metrics sampling (see src/core/VertixEngine.ts).
const STREAM_HEALTH_POLL_MS = 300;

interface UseWasmReframeReturn {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  state: PlayerState;
  meta: VertixMeta | null;
  setMode: (mode: VertixMode) => void;
  mode: VertixMode;
  load: (src: string, mimeTypeHint?: string) => void;
  togglePlay: () => void;
  seek: (fraction: number) => void;
  progress: number;
  duration: number;
  muted: boolean;
  toggleMute: () => void;
  /** Number of valid (large-enough, unclipped) speakers in the current committed layout — 0 means B-roll/no-crop. */
  speakerCount: number;
  /** Whether a layout cross-dissolve is currently in progress. */
  isTransitioning: boolean;
  /** Live telemetry for the analytics dashboard. */
  metrics: VertixMetrics;
  /** User-facing message for the current load failure, if `state === "error"`. */
  errorMessage: string | null;
  /** Whether Shaka is currently stalled waiting for more data (rebuffering) — layered on top of `state`, not a state of its own. */
  isBuffering: boolean;
  /** Network/ABR telemetry for the currently loaded source — null until a source has loaded at least once. */
  streamHealth: StreamHealth | null;
  /** Resets playback back to the idle/source-picker state, discarding the currently loaded source. */
  changeSource: () => void;
}

/**
 * Thin React adapter around `VertixEngine` (see `src/core/`). Owns this
 * app's playback UI — loading a source (local file, progressive URL, or an
 * HLS/DASH stream) via a `shaka.Player`, play/pause/seek, mute, scrub-bar
 * progress. `VertixEngine` itself never knows Shaka exists; it only reacts
 * to the `<video>` element's own native events. See `docs/player-integration.md`.
 */
export function useWasmReframe(): UseWasmReframeReturn {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attachedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const shakaAttachedRef = useRef(false);
  const currentSrcRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);

  const engineRef = useRef<VertixEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new VertixEngine();
  }

  // Lazily-constructed singleton, same shape as `engineRef` above. Never
  // destroyed on effect cleanup: under StrictMode's dev-only double-invoke
  // (mount -> cleanup -> mount), a `player.destroy()` there races Shaka's
  // async detach against the second mount's `attach()` on the same <video>
  // element, leaving `attach()` pending forever with no error. The player
  // is meant to live for the app's whole session anyway, so skip destroy.
  const shakaPlayerRef = useRef<shaka.Player | null>(null);

  const [state, setState] = useState<PlayerState>("idle");
  const [meta, setMeta] = useState<VertixMeta | null>(null);
  const [mode, setModeState] = useState<VertixMode>("9:16");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(true);
  const [speakerCount, setSpeakerCount] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [metrics, setMetrics] = useState<VertixMetrics>(INITIAL_METRICS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [manifestType, setManifestType] = useState<StreamManifestType | null>(null);
  const [streamHealth, setStreamHealth] = useState<StreamHealth | null>(null);

  // Mirror the engine's own state/metrics into React state.
  useEffect(() => {
    const engine = engineRef.current!;
    const unsubState = engine.onStateChange((s) => {
      setModeState(s.mode);
      setMeta(s.meta);
      setSpeakerCount(s.speakerCount);
      setIsTransitioning(s.isTransitioning);
    });
    const unsubMetrics = engine.onMetricsUpdate(setMetrics);
    return () => {
      unsubState();
      unsubMetrics();
      engine.destroy();
    };
  }, []);

  // Wires error/buffering events onto the persistent shakaPlayerRef
  // singleton — safe to add/remove every mount cycle since it never
  // constructs or destroys the player itself.
  useEffect(() => {
    if (shakaPlayerRef.current === null) {
      shakaPlayerRef.current = new shaka.Player();
    }
    const player = shakaPlayerRef.current;

    const onError = (event: Event) => {
      const detail = (event as ShakaErrorEvent).detail;
      setState("error");
      setErrorMessage(mapShakaError(detail));
    };
    const onBuffering = (event: Event) => {
      setIsBuffering((event as ShakaBufferingEvent).buffering);
    };
    player.addEventListener("error", onError);
    player.addEventListener("buffering", onBuffering);
    return () => {
      player.removeEventListener("error", onError);
      player.removeEventListener("buffering", onBuffering);
    };
  }, []);

  // Attaches Shaka to the <video> element, which App.tsx renders
  // unconditionally — this only ever needs to run once, guarded by the
  // plain ref (survives StrictMode's double-invoke, unlike a boolean state).
  useEffect(() => {
    if (shakaAttachedRef.current) return;
    const video = videoRef.current;
    const player = shakaPlayerRef.current;
    if (!video || !player) return;
    shakaAttachedRef.current = true;
    player.attach(video).catch((err) => {
      setState("error");
      setErrorMessage(mapShakaError(err));
    });
  }, []);

  // Revokes whatever local blob URL is still current on true unmount —
  // `load()` already revokes the *previous* one on every new load, this
  // only covers the last one, which nothing else would ever clean up.
  useEffect(() => {
    return () => {
      const src = currentSrcRef.current;
      if (src && src.startsWith("blob:")) URL.revokeObjectURL(src);
    };
  }, []);

  // Attaches the engine to the canvas, which only exists while playback UI
  // is active (see App.tsx). Compares against the actual last-attached
  // element, not a boolean flag: `changeSource()` unmounts Canvas and a new
  // source mounts a fresh <canvas> DOM node, so a boolean would skip
  // re-attaching to it, leaving the engine drawing onto a detached canvas
  // (black screen). VertixEngine.attach() detaches the previous pair first.
  useEffect(() => {
    if (videoRef.current && canvasRef.current && canvasRef.current !== attachedCanvasRef.current) {
      engineRef.current!.attach(videoRef.current, canvasRef.current);
      attachedCanvasRef.current = canvasRef.current;
    }
  }, [state]);

  const load = useCallback((src: string, mimeTypeHint?: string) => {
    const video = videoRef.current;
    const player = shakaPlayerRef.current;
    if (!video || !player) return;

    setState("loading");
    setErrorMessage(null);
    setStreamHealth(null);
    video.muted = true;
    video.playsInline = true;
    // Engine state (tracking, layout, metrics) resets itself in response to
    // the video's own "loadedmetadata" event — nothing to do here beyond
    // this app's own file-loading state.

    video.onloadedmetadata = () => {
      setDuration(video.duration);
      // Already muted above, so autoplay is allowed almost everywhere; fall
      // back to "ready" (user presses play) on the rare browser that still
      // blocks it.
      video
        .play()
        .then(() => setState("playing"))
        .catch(() => setState("ready"));
    };
    // No native video.onerror handler: Shaka already re-surfaces media
    // element errors through its own 'error' event (handled below) — a
    // separate raw handler here previously raced that and clobbered
    // Shaka's specific message with the generic fallback.

    const previousSrc = currentSrcRef.current;
    if (previousSrc && previousSrc.startsWith("blob:")) {
      URL.revokeObjectURL(previousSrc);
    }
    currentSrcRef.current = src;
    setManifestType(classifyManifestType(src));

    // player.load() aborts any in-flight load when called again, and the
    // aborted promise rejects (Category.PLAYER) same as a real failure —
    // guard against that stale rejection landing after a newer load already
    // succeeded (e.g. rapidly switching sample clips).
    const generation = ++loadGenerationRef.current;
    const mimeType = mimeTypeHint ?? mimeTypeForExtension(src);
    player.load(src, null, mimeType).catch((err) => {
      if (loadGenerationRef.current !== generation) return;
      setState("error");
      setErrorMessage(mapShakaError(err));
    });
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play();
      setState("playing");
    } else {
      video.pause();
      setState("paused");
    }
  }, []);

  const seek = useCallback((fraction: number) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    video.currentTime = fraction * video.duration;
    // The engine hears the video's own "seeking" event and resets its
    // tracking state on its own.
    setProgress(fraction);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      if (video.duration) setProgress(video.currentTime / video.duration);
    };
    const onEnded = () => setState("ended");
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
    };
  }, []);

  // Stream-health telemetry — only meaningful, and only polled, while
  // something is actually playing back.
  useEffect(() => {
    if (state !== "playing" || manifestType === null) return;
    const player = shakaPlayerRef.current;
    const video = videoRef.current;
    if (!player || !video) return;

    const id = setInterval(() => {
      setStreamHealth(computeStreamHealth(player, video, manifestType));
    }, STREAM_HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [state, manifestType]);

  const setMode = useCallback((m: VertixMode) => {
    engineRef.current!.setMode(m);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const changeSource = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // Any in-flight load's rejection (from the source being abandoned right
    // now) must not land after this — same guard load() already uses.
    loadGenerationRef.current += 1;

    const src = currentSrcRef.current;
    if (src && src.startsWith("blob:")) URL.revokeObjectURL(src);
    currentSrcRef.current = null;

    video.onloadedmetadata = null;
    // Deliberately not calling player.unload(): Shaka's load() already
    // unloads any current stream first, and unload()'s own default
    // (initializeMediaSource=true) previously reintroduced the codec-
    // sniffing failure mimeTypeForExtension works around. pause() is
    // enough to stop playback while the idle screen is shown.
    video.pause();

    setState("idle");
    setErrorMessage(null);
    setStreamHealth(null);
    setManifestType(null);
    setDuration(0);
    setProgress(0);
  }, []);

  return {
    canvasRef,
    videoRef,
    state,
    meta,
    setMode,
    mode,
    load,
    togglePlay,
    seek,
    progress,
    duration,
    muted,
    toggleMute,
    speakerCount,
    isTransitioning,
    metrics,
    errorMessage,
    isBuffering,
    streamHealth,
    changeSource,
  };
}
