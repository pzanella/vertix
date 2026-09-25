import { memo, type ReactNode } from "react";
import type { ReframeMode } from "../../hooks/useWasmReframe";

interface CanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  mode: ReframeMode;
  /** Rendered absolutely-positioned on top of the video (e.g. StreamHealthOverlay) — a slot, like Controls' `middle`, so passing it in doesn't tie this component's re-render to state that has nothing to do with the canvas itself. */
  overlay?: ReactNode;
}

// Memoized so this never re-renders from unrelated state changing elsewhere
// in the tree (progress, metrics, ...) — canvasRef is a stable object and
// mode only changes on an explicit user toggle, so in practice this should
// re-render essentially never during playback. The actual video frames are
// painted imperatively by useWasmReframe, entirely outside React.
export const Canvas = memo(function Canvas({ canvasRef, mode, overlay }: CanvasProps) {
  return (
    <div className="relative flex-1 min-h-0 w-full flex items-center justify-center bg-black rounded-xl overflow-hidden ring-1 ring-white/5">
      <canvas
        ref={canvasRef}
        className={`max-h-full max-w-full transition-[aspect-ratio] duration-300 ease-out ${
          mode === "16:9" ? "aspect-video" : "aspect-[9/16]"
        } object-contain`}
      />
      {overlay}
    </div>
  );
});
