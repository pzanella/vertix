import { memo } from "react";
import type { ReframeMode } from "../../hooks/useWasmReframe";

interface CanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  mode: ReframeMode;
}

// Memoized so this never re-renders from unrelated state changing elsewhere
// in the tree (progress, metrics, ...) — canvasRef is a stable object and
// mode only changes on an explicit user toggle, so in practice this should
// re-render essentially never during playback. The actual video frames are
// painted imperatively by useWasmReframe, entirely outside React.
export const Canvas = memo(function Canvas({ canvasRef, mode }: CanvasProps) {
  return (
    <div className="flex-1 min-h-0 w-full flex items-center justify-center bg-black rounded-xl overflow-hidden">
      <canvas
        ref={canvasRef}
        className={`max-h-full max-w-full ${
          mode === "16:9" ? "aspect-video" : "aspect-[9/16]"
        } object-contain`}
      />
    </div>
  );
});
