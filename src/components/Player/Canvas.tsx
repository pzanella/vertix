import type { ReframeMode } from "../../hooks/useWasmReframe";

interface CanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  mode: ReframeMode;
}

export function Canvas({ canvasRef, mode }: CanvasProps) {
  return (
    <div className="flex items-center justify-center bg-black rounded-xl overflow-hidden">
      <canvas
        ref={canvasRef}
        className={`max-h-[70vh] ${
          mode === "original" ? "aspect-video" : "aspect-[9/16]"
        } object-contain`}
      />
    </div>
  );
}
