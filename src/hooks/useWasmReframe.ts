import { useCallback, useEffect, useRef, useState } from "react";
import { VertixEngine, type VertixMeta, type VertixMetrics, type VertixMode } from "../core";

export type ReframeMode = VertixMode;
export type ReframeMeta = VertixMeta;
export type ReframeMetrics = VertixMetrics;
export type PlayerState = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";

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

interface UseWasmReframeReturn {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  state: PlayerState;
  wasmReady: boolean;
  meta: VertixMeta | null;
  setMode: (mode: VertixMode) => void;
  mode: VertixMode;
  load: (src: string) => void;
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
}

/**
 * Thin React adapter around `VertixEngine` (see `src/core/`). This hook
 * owns everything that's specifically about *this app's* file-based
 * playback UI — loading a local file into the `<video>`, play/pause/seek,
 * mute, scrub-bar progress — all implemented directly against the video
 * element's own API. It does not reach into the engine for any of that;
 * the engine only cares about reframing whatever the video element is
 * already doing, exactly as it would if some other player (Shaka, hls.js,
 * ...) owned playback instead of this hook.
 */
export function useWasmReframe(): UseWasmReframeReturn {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attachedRef = useRef(false);

  const engineRef = useRef<VertixEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new VertixEngine();
  }

  const [state, setState] = useState<PlayerState>("idle");
  const [wasmReady, setWasmReady] = useState(false);
  const [meta, setMeta] = useState<VertixMeta | null>(null);
  const [mode, setModeState] = useState<VertixMode>("9:16");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(true);
  const [speakerCount, setSpeakerCount] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [metrics, setMetrics] = useState<VertixMetrics>(INITIAL_METRICS);

  // Mirror the engine's own state/metrics into React state. Subscribed
  // once, for the lifetime of this component — the engine instance itself
  // is stable (see engineRef above).
  useEffect(() => {
    const engine = engineRef.current!;
    const unsubState = engine.onStateChange((s) => {
      setWasmReady(s.wasmReady);
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

  // Attaches the engine once the canvas has actually mounted (it's only
  // rendered once playback UI becomes active — see App.tsx) — re-checked
  // whenever `state` changes since that's what gates the canvas mounting.
  useEffect(() => {
    if (attachedRef.current) return;
    if (videoRef.current && canvasRef.current) {
      engineRef.current!.attach(videoRef.current, canvasRef.current);
      attachedRef.current = true;
    }
  }, [state]);

  const load = useCallback((src: string) => {
    const video = videoRef.current;
    if (!video) return;

    setState("loading");
    video.muted = true;
    video.playsInline = true;
    video.src = src;
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
    video.onerror = () => {
      setState("error");
    };
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

  const setMode = useCallback((m: VertixMode) => {
    engineRef.current!.setMode(m);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  return {
    canvasRef,
    videoRef,
    state,
    wasmReady,
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
  };
}
