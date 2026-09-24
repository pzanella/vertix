import { useCallback, useEffect, useRef, useState } from "react";
import type Shaka from "shaka-player";
import { VertixEngine, type VertixMeta, type VertixMetrics, type VertixMode } from "../core";

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

// The actual runtime value's type — `Shaka` (above) is a type-only import
// usable only for dotted type access (`Shaka.Player`, `Shaka.util.Error`,
// ...); this is the type of the value you get back from actually importing
// the module, needed anywhere a real shaka instance is passed around.
type ShakaRuntime = (typeof import("shaka-player"))["default"];

// Kept out of the main bundle — see loadShaka() below.
let shakaModulePromise: Promise<ShakaRuntime> | null = null;

/** Dynamically imports and initializes Shaka Player on first use instead of
 * bundling it into the app's initial JS — it's ~300KB gzipped, needed only
 * once a video is actually about to load. Cached at module scope so every
 * caller (the attach effect, load(), a StrictMode remount) shares one fetch
 * and one polyfill.installAll() call. */
function loadShaka(): Promise<ShakaRuntime> {
  if (!shakaModulePromise) {
    shakaModulePromise = import("shaka-player").then((mod) => {
      mod.default.polyfill.installAll();
      return mod.default;
    });
  }
  return shakaModulePromise;
}

/** Narrow typed views onto Shaka's custom event payloads — `Player.addEventListener` itself is typed as plain `Event` in the shipped externs, so these fields (added at runtime via `shaka.util.FakeEvent`) aren't otherwise visible to TS. */
interface ShakaErrorEvent extends Event {
  detail: Shaka.util.Error;
}
interface ShakaBufferingEvent extends Event {
  buffering: boolean;
}

function isShakaError(shaka: ShakaRuntime, err: unknown): err is Shaka.util.Error {
  return err instanceof shaka.util.Error;
}

/** Reverse-looks-up a `shaka.util.Error.Code` numeric value to its enum member name (e.g. "HLS_REQUIRED_TAG_MISSING") — needed because HLS- and DASH-prefixed codes share the same MANIFEST category and numeric range, so only the name tells them apart. */
function shakaErrorCodeName(shaka: ShakaRuntime, code: number): string {
  const entry = Object.entries(shaka.util.Error.Code).find(([, value]) => value === code);
  return entry?.[0] ?? "";
}

/** Maps a Shaka load failure (from the `error` event or a rejected `player.load()`) to a user-facing message. Isolates the one spot in this app that reaches into Shaka's error shape (`error.data` is untyped upstream). */
function mapShakaError(shaka: ShakaRuntime, err: unknown): string {
  if (!isShakaError(shaka, err)) return GENERIC_ERROR_MESSAGE;

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
    const codeName = shakaErrorCodeName(shaka, code);
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

function computeBufferHealthSec(bufferedInfo: Shaka.extern.BufferedInfo, currentTime: number): number {
  const range = bufferedInfo.total.find((r) => currentTime >= r.start && currentTime <= r.end);
  return range ? Math.max(0, range.end - currentTime) : 0;
}

function computeStreamHealth(
  player: Shaka.Player,
  video: HTMLVideoElement,
  manifestType: StreamManifestType
): StreamHealth {
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
  audioAvailable: false,
  audioEnergy: null,
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
  /** Restarts playback from an `ended` state — see its own doc comment for why this isn't just togglePlay() again. */
  replay: () => void;
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

  const shakaPlayerRef = useRef<Shaka.Player | null>(null);
  const shakaListenersWiredRef = useRef(false);
  const shakaOnErrorRef = useRef<((event: Event) => void) | null>(null);
  const shakaOnBufferingRef = useRef<((event: Event) => void) | null>(null);

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

  // Built inside the effect, not eagerly during render: VertixEngine.destroy()
  // is one-way, and StrictMode's dev-only mount→cleanup→remount would
  // otherwise destroy a render-created instance almost immediately, leaving
  // every later render stuck reusing an already-destroyed engine.
  useEffect(() => {
    const engine = new VertixEngine();
    engineRef.current = engine;
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
      engineRef.current = null;
    };
  }, []);

  // Tears down the Shaka listeners on true unmount, if they were ever
  // wired (see ensureShakaReady() inside load() below — nothing sets these
  // up before the user actually loads a source).
  useEffect(() => {
    return () => {
      const player = shakaPlayerRef.current;
      const onError = shakaOnErrorRef.current;
      const onBuffering = shakaOnBufferingRef.current;
      if (player && onError && onBuffering) {
        player.removeEventListener("error", onError);
        player.removeEventListener("buffering", onBuffering);
      }
    };
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
    if (!video) return;

    setState("loading");
    setErrorMessage(null);
    setStreamHealth(null);
    video.muted = true;
    video.playsInline = true;
    // Engine state (tracking, layout, metrics) resets itself in response to
    // the video's own "loadedmetadata" event — nothing to do here beyond
    // this app's own file-loading state.

    const srcManifestType = classifyManifestType(src);
    // Without this, the WebAudio tap reads a cross-origin source as
    // silence no matter what's actually happening (see
    // AudioActivityMonitor). Scoped to HLS/DASH only: Shaka already fetches
    // those segments in CORS mode, so a stream that plays at all here
    // proves the server allows it. A plain progressive URL has no such
    // guarantee, and setting this unconditionally could break loading one.
    video.crossOrigin = srcManifestType === "HLS" || srcManifestType === "DASH" ? "anonymous" : null;

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
    // No native video.onerror: Shaka already re-surfaces media element
    // errors through its own 'error' event (handled below) — a separate raw
    // handler here previously raced that and clobbered Shaka's specific
    // message with the generic fallback.

    const previousSrc = currentSrcRef.current;
    if (previousSrc && previousSrc.startsWith("blob:")) {
      URL.revokeObjectURL(previousSrc);
    }
    currentSrcRef.current = src;
    setManifestType(srcManifestType);

    // player.load() aborts any in-flight load when called again, and the
    // aborted promise rejects (Category.PLAYER) same as a real failure —
    // guard against that stale rejection landing after a newer load already
    // succeeded (e.g. rapidly switching sample clips).
    const generation = ++loadGenerationRef.current;
    const mimeType = mimeTypeHint ?? mimeTypeForExtension(src);

    // Resolves Shaka (see loadShaka()), constructing the player, wiring its
    // error/buffering events, and attaching it to <video> the first time
    // any of this is needed — deliberately not done any earlier, so
    // visitors who never load a video never fetch Shaka's ~270KB chunk.
    const ensureShakaReady = async () => {
      const shaka = await loadShaka();

      if (shakaPlayerRef.current === null) {
        shakaPlayerRef.current = new shaka.Player();
      }
      const player = shakaPlayerRef.current;

      if (!shakaListenersWiredRef.current) {
        shakaListenersWiredRef.current = true;
        const onError = (event: Event) => {
          setState("error");
          setErrorMessage(mapShakaError(shaka, (event as ShakaErrorEvent).detail));
        };
        const onBuffering = (event: Event) => {
          setIsBuffering((event as ShakaBufferingEvent).buffering);
        };
        shakaOnErrorRef.current = onError;
        shakaOnBufferingRef.current = onBuffering;
        player.addEventListener("error", onError);
        player.addEventListener("buffering", onBuffering);
      }

      if (!shakaAttachedRef.current && videoRef.current) {
        shakaAttachedRef.current = true;
        try {
          await player.attach(videoRef.current);
        } catch (err) {
          setState("error");
          setErrorMessage(mapShakaError(shaka, err));
          return null;
        }
      }

      return { shaka, player };
    };

    ensureShakaReady().then((ready) => {
      if (!ready || loadGenerationRef.current !== generation) return;
      const { shaka, player } = ready;
      player.load(src, null, mimeType).catch((err) => {
        if (loadGenerationRef.current !== generation) return;
        setState("error");
        setErrorMessage(mapShakaError(shaka, err));
      });
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

  /**
   * Restarts playback after `ended` — separate from togglePlay() because
   * `.play()` on an ended video technically rewinds to 0 on its own, but
   * for an MSE/Shaka source that implicit rewind doesn't reliably kick
   * Shaka's streaming engine back into fetching segments. Seeking
   * explicitly reuses the same path seek() already uses for scrubbing,
   * which does.
   */
  const replay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    setProgress(0);
    video
      .play()
      .then(() => setState("playing"))
      .catch(() => setState("ready"));
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
  // something is actually playing back (by which point Shaka is guaranteed
  // loaded, since nothing reaches "playing" without it).
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
    replay,
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
