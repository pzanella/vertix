import { useEffect, useRef, useState } from "react";
import { detectDeviceClass, isWasmSimdSupported, type BenchmarkClipExtension, type VertixEngine } from "../../core";
import type { FaceMeshController, FaceMeshStatus } from "./FaceMeshController";
import type { MeshStyleId } from "./meshStyles";

interface UseFaceMeshOptions {
  enabled: boolean;
  getEngine: () => VertixEngine | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlay: HTMLCanvasElement | null;
  style: MeshStyleId;
  /** A change starts the timeline over (nothing from the other mode is drawn). */
  mode: string;
}

export interface UseFaceMeshReturn {
  /** Null while the switch is off. */
  status: FaceMeshStatus | null;
  /** The benchmark's faceMesh block recorder while the switch is on, else null. */
  benchExtension: BenchmarkClipExtension | null;
}

/** Until the face mesh code chunk has loaded and the controller reports. */
const LOADING_CHUNK: FaceMeshStatus = {
  state: "loading",
  reason: null,
  loadingSinceMs: null,
  mode: null,
  behind: false,
  minimumLookaheadMs: null,
  blockedRequests: 0,
};

/**
 * The "Face mesh" demo switch. Off: nothing of the face mesh is loaded (its
 * code is a separate chunk, imported on first use) and the engine runs
 * exactly as without it.
 */
export function useFaceMesh({
  enabled,
  getEngine,
  videoRef,
  overlay,
  style,
  mode,
}: UseFaceMeshOptions): UseFaceMeshReturn {
  const [status, setStatus] = useState<FaceMeshStatus | null>(null);
  const [controller, setController] = useState<FaceMeshController | null>(null);
  const styleRef = useRef(style);

  useEffect(() => {
    const engine = getEngine();
    if (!enabled || !overlay || !engine) return;
    let cancelled = false;
    let started: FaceMeshController | null = null;
    void import("./FaceMeshController").then(({ FaceMeshController }) => {
      if (cancelled) return;
      started = new FaceMeshController(engine, {
        baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href,
        simd: isWasmSimdSupported(),
        device: detectDeviceClass(),
        overlay,
        style: styleRef.current,
        onStatus: (next) => {
          if (!cancelled) setStatus(next);
        },
      });
      setController(started);
    });
    return () => {
      cancelled = true;
      started?.stop();
      setController(null);
      setStatus(null);
    };
  }, [enabled, overlay, getEngine]);

  useEffect(() => {
    styleRef.current = style;
    controller?.setStyle(style);
  }, [controller, style]);

  useEffect(() => controller?.reset(), [controller, mode]);

  useEffect(() => {
    const video = videoRef.current;
    if (!controller || !video) return;
    const reset = () => controller.reset();
    video.addEventListener("seeking", reset);
    video.addEventListener("loadedmetadata", reset);
    return () => {
      video.removeEventListener("seeking", reset);
      video.removeEventListener("loadedmetadata", reset);
    };
  }, [controller, videoRef]);

  return {
    status: enabled ? (status ?? LOADING_CHUNK) : null,
    benchExtension: enabled ? (controller?.bench ?? null) : null,
  };
}
