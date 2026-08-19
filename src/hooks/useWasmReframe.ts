import { useCallback, useEffect, useRef, useState } from "react";
import initWasm, { ReframeEngine } from "../wasm/wasm.js";

export type ReframeMode = "original" | "reframed" | "fit" | "wide";
export type PlayerState = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";

export interface ReframeMeta {
  width: number;
  height: number;
  cropWidth: number;
  cropHeight: number;
}

// Analysis resolution — small enough for fast WASM, big enough for accuracy.
const ANALYSIS_W = 320;
const ANALYSIS_H = 180;

// Input size the face-detection model expects. Drawn as a plain stretch fill
// (not letterboxed), same as the analysis canvas above, so a detected face's
// X position lines up 1:1 with the analysis-space X the saliency engine uses.
const FACE_W = 320;
const FACE_H = 240;
// Face detection is much heavier than the saliency scan, so it only runs on
// every Nth frame. The PID smoothing in WASM keeps the pan smooth in between.
const FACE_DETECT_INTERVAL = 4;

// "9:16 Wide" shows more context around the tracked subject than the tight
// 9:16 crop. A wider crop needs more source height than actually exists to
// stay at 9:16, so the gap gets padded with a blurred backdrop (same idea
// as "Fit") instead of being physically possible to crop for real.
const WIDE_ZOOM_FACTOR = 1.35;

interface UseWasmReframeReturn {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  state: PlayerState;
  wasmReady: boolean;
  meta: ReframeMeta | null;
  setMode: (mode: ReframeMode) => void;
  mode: ReframeMode;
  load: (src: string) => void;
  togglePlay: () => void;
  seek: (fraction: number) => void;
  progress: number;
  duration: number;
  muted: boolean;
  toggleMute: () => void;
}

export function useWasmReframe(): UseWasmReframeReturn {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const outputCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  // WASM engine (operates at analysis resolution).
  const engineRef = useRef<InstanceType<typeof ReframeEngine> | null>(null);
  const wasmReadyRef = useRef(false);

  // Off-screen canvas for downsampled analysis.
  const analysisCanvasRef = useRef<OffscreenCanvas | null>(null);
  const analysisCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null);

  // Off-screen canvas feeding the face-detection model, updated periodically.
  const faceCanvasRef = useRef<OffscreenCanvas | null>(null);
  const faceCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null);
  const frameCounterRef = useRef(0);

  // Off-screen buffer used to feather a sharp crop into a blurred backdrop
  // ("Wide" mode), instead of meeting it at a hard edge.
  const featherCanvasRef = useRef<OffscreenCanvas | null>(null);
  const featherCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null);

  const [state, setState] = useState<PlayerState>("idle");
  const [wasmReady, setWasmReady] = useState(false);
  const [meta, setMeta] = useState<ReframeMeta | null>(null);
  const [mode, setModeState] = useState<ReframeMode>("reframed");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(true);

  // Keep mode in a ref so the rVFC callback always sees the latest value.
  const modeRef = useRef<ReframeMode>(mode);

  // Source dimensions + scale factor (set on first frame).
  const srcDims = useRef({ w: 0, h: 0, cropW: 0, cropH: 0, wideCropW: 0, wideCropH: 0, scale: 1 });

  useEffect(() => {
    initWasm().then(() => {
      wasmReadyRef.current = true;
      setWasmReady(true);

      const ac = new OffscreenCanvas(ANALYSIS_W, ANALYSIS_H);
      analysisCanvasRef.current = ac;
      analysisCtxRef.current = ac.getContext("2d", {
        willReadFrequently: true,
      })!;

      const fc = new OffscreenCanvas(FACE_W, FACE_H);
      faceCanvasRef.current = fc;
      faceCtxRef.current = fc.getContext("2d", {
        willReadFrequently: true,
      })!;
    });
  }, []);

  // Runs on every decoded frame. Rendering happens synchronously here
  // (not through React state) so playback stays perfectly in sync with audio.
  const onVideoFrame = useCallback(
    (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.paused || video.ended) return;

      if (!engineRef.current && wasmReadyRef.current) {
        const w = metadata.width ?? video.videoWidth;
        const h = metadata.height ?? video.videoHeight;
        const cropH = h;
        const cropW = Math.round((h * 9) / 16);
        const wideCropW = Math.min(w, Math.round(cropW * WIDE_ZOOM_FACTOR));
        const wideCropH = Math.round((wideCropW * 16) / 9);
        const scale = w / ANALYSIS_W;

        srcDims.current = { w, h, cropW, cropH, wideCropW, wideCropH, scale };
        engineRef.current = new ReframeEngine(ANALYSIS_W, ANALYSIS_H);

        setMeta({ width: w, height: h, cropWidth: cropW, cropHeight: cropH });
      }

      const { w: srcW, h: srcH, cropW, cropH, wideCropW, wideCropH, scale } = srcDims.current;
      const currentMode = modeRef.current;

      const isWide = currentMode === "wide";
      const targetW = currentMode === "original" ? srcW : isWide ? wideCropW : cropW;
      const targetH = currentMode === "original" ? srcH : isWide ? wideCropH : cropH;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      if (!outputCtxRef.current) {
        outputCtxRef.current = canvas.getContext("2d");
      }
      const ctx = outputCtxRef.current!;

      if (currentMode === "original") {
        ctx.drawImage(video, 0, 0, srcW, srcH);
      } else if (currentMode === "fit") {
        // Nothing is cropped here, so there's no need to run the WASM
        // engine at all — just a blurred, scaled-to-fill backdrop with the
        // untouched full frame centered on top.
        const coverScale = Math.max(cropW / srcW, cropH / srcH);
        const bgW = srcW * coverScale;
        const bgH = srcH * coverScale;
        ctx.filter = "blur(30px)";
        ctx.drawImage(video, (cropW - bgW) / 2, (cropH - bgH) / 2, bgW, bgH);
        ctx.filter = "none";

        const fitScale = cropW / srcW;
        const fgH = srcH * fitScale;
        ctx.drawImage(video, 0, (cropH - fgH) / 2, cropW, fgH);
      } else if (currentMode === "wide") {
        // Same tracking as the tight crop, just displayed with more headroom.
        frameCounterRef.current += 1;
        if (frameCounterRef.current % FACE_DETECT_INTERVAL === 0) {
          const fCtx = faceCtxRef.current!;
          fCtx.drawImage(video, 0, 0, FACE_W, FACE_H);
          const faceImageData = fCtx.getImageData(0, 0, FACE_W, FACE_H);
          engineRef.current!.update_face_target(new Uint8Array(faceImageData.data.buffer));
        }

        const aCtx = analysisCtxRef.current!;
        aCtx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
        const imageData = aCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
        const pixels = new Uint8Array(imageData.data.buffer);

        const analysisCropX = engineRef.current!.process_frame(pixels);
        const tightCropX = Math.round(analysisCropX * scale);
        const centerX = tightCropX + cropW / 2;
        const rawWideCropX = Math.round(centerX - wideCropW / 2);
        const maxWideCropX = Math.max(0, srcW - wideCropW);
        const safeWideCropX = Math.max(0, Math.min(rawWideCropX, maxWideCropX));

        // Blurred backdrop, scaled to cover the whole (wider, taller) canvas.
        const coverScale = Math.max(wideCropW / srcW, wideCropH / srcH);
        const bgW = srcW * coverScale;
        const bgH = srcH * coverScale;
        ctx.filter = "blur(30px)";
        ctx.drawImage(video, (wideCropW - bgW) / 2, (wideCropH - bgH) / 2, bgW, bgH);
        ctx.filter = "none";

        // Sharp, tracked crop, feathered top/bottom so it blends into the
        // blurred backdrop instead of meeting it at a hard edge.
        if (!featherCanvasRef.current) {
          featherCanvasRef.current = new OffscreenCanvas(wideCropW, srcH);
          featherCtxRef.current = featherCanvasRef.current.getContext("2d");
        }
        const fCanvas = featherCanvasRef.current;
        if (fCanvas.width !== wideCropW || fCanvas.height !== srcH) {
          fCanvas.width = wideCropW;
          fCanvas.height = srcH;
        }
        const featherCtx = featherCtxRef.current!;
        featherCtx.globalCompositeOperation = "source-over";
        featherCtx.drawImage(video, safeWideCropX, 0, wideCropW, srcH, 0, 0, wideCropW, srcH);

        const featherPx = Math.round(srcH * 0.06);
        const featherFrac = featherPx / srcH;
        featherCtx.globalCompositeOperation = "destination-in";
        const gradient = featherCtx.createLinearGradient(0, 0, 0, srcH);
        gradient.addColorStop(0, "rgba(0,0,0,0)");
        gradient.addColorStop(featherFrac, "rgba(0,0,0,1)");
        gradient.addColorStop(1 - featherFrac, "rgba(0,0,0,1)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        featherCtx.fillStyle = gradient;
        featherCtx.fillRect(0, 0, wideCropW, srcH);
        featherCtx.globalCompositeOperation = "source-over";

        const yOffset = (wideCropH - srcH) / 2;
        ctx.drawImage(fCanvas, 0, yOffset);
      } else {
        // The saliency engine only ever looks at a small downscaled frame,
        // so the JS↔WASM round trip stays cheap. The final crop is still
        // drawn straight from the full-res <video> element (GPU-accelerated),
        // just at a scaled-up X offset.
        frameCounterRef.current += 1;
        if (frameCounterRef.current % FACE_DETECT_INTERVAL === 0) {
          const fCtx = faceCtxRef.current!;
          fCtx.drawImage(video, 0, 0, FACE_W, FACE_H);
          const faceImageData = fCtx.getImageData(0, 0, FACE_W, FACE_H);
          engineRef.current!.update_face_target(new Uint8Array(faceImageData.data.buffer));
        }

        const aCtx = analysisCtxRef.current!;
        aCtx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
        const imageData = aCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
        const pixels = new Uint8Array(imageData.data.buffer);

        const analysisCropX = engineRef.current!.process_frame(pixels);
        const cropX = Math.round(analysisCropX * scale);
        const maxCropX = srcW - cropW;
        const safeCropX = Math.max(0, Math.min(cropX, maxCropX));

        ctx.drawImage(video, safeCropX, 0, cropW, cropH, 0, 0, cropW, cropH);
      }

      if (video.duration && Number.isFinite(video.duration)) {
        setProgress(video.currentTime / video.duration);
      }

      video.requestVideoFrameCallback(onVideoFrame);
    },
    []
  );

  const load = useCallback((src: string) => {
    const video = videoRef.current;
    if (!video) return;

    setState("loading");
    video.src = src;
    video.muted = true;
    video.playsInline = true;

    // A new file means new dimensions and a new subject — start the engine,
    // output canvas, and frame counter from a clean slate instead of
    // carrying over tracking state from whatever was loaded before.
    engineRef.current = null;
    outputCtxRef.current = null;
    frameCounterRef.current = 0;
    setMeta(null);

    video.onloadedmetadata = () => {
      setDuration(video.duration);
      setState("ready");
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
      video.requestVideoFrameCallback(onVideoFrame);
    } else {
      video.pause();
      setState("paused");
    }
  }, [onVideoFrame]);

  const seek = useCallback((fraction: number) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    video.currentTime = fraction * video.duration;
    engineRef.current?.reset();
    setProgress(fraction);
  }, []);

  const setMode = useCallback((m: ReframeMode) => {
    setModeState(m);
    modeRef.current = m;
    // Force the output canvas to re-create its context at the new size.
    outputCtxRef.current = null;
    engineRef.current?.reset();
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
  };
}
