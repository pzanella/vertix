import { useCallback, useMemo, useRef, useState } from "react";
import { AnalyticsDashboard, Canvas, Controls, LiveStatusPanel, Timeline } from "./components/Player";
import { useWasmReframe } from "./hooks/useWasmReframe";

export default function App() {
  const {
    canvasRef,
    videoRef,
    mode,
    setMode,
    togglePlay,
    seek,
    load,
    progress,
    duration,
    state,
    wasmReady,
    muted,
    toggleMute,
    speakerCount,
    isTransitioning,
    meta,
    metrics,
  } = useWasmReframe();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const openFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const url = URL.createObjectURL(file);
      load(url);
    },
    [load]
  );

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => openFile(e.target.files?.[0]),
    [openFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      openFile(e.dataTransfer.files?.[0]);
    },
    [openFile]
  );

  const playing = state === "playing" || (videoRef.current ? !videoRef.current.paused : false);
  const isActive = state === "ready" || state === "playing" || state === "paused" || state === "ended";

  // Memoized so Controls (memoized itself) only re-renders when the
  // timeline actually needs to — otherwise passing JSX inline as a prop
  // would create a new element reference on every App render (e.g. from
  // unrelated dashboard metrics updating), defeating that memoization.
  const timeline = useMemo(() => <Timeline progress={progress} duration={duration} onSeek={seek} />, [progress, duration, seek]);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden p-4 gap-3">
      <header className="shrink-0 flex items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">
          <span className="text-brand-400">Ver</span>tix
        </h1>
        <p className="text-xs text-neutral-500">Turn 16:9 video into 9:16. The camera follows the action for you.</p>
      </header>

      <video ref={videoRef} className="hidden" />

      {!isActive && (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center">
          {state === "idle" && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl w-full max-w-lg py-20 flex flex-col items-center gap-3 cursor-pointer transition ${
                dragging ? "border-brand-400 bg-brand-950/30" : "border-neutral-700 hover:border-brand-500"
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 text-neutral-500">
                <path d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" />
              </svg>
              <span className="text-neutral-400 text-sm">Drop a 16:9 video here, or click to choose one</span>
              {!wasmReady && <span className="text-neutral-600 text-xs">Warming up the reframe engine…</span>}
              <input ref={fileInputRef} type="file" accept="video/*" onChange={handleFile} className="hidden" />
            </div>
          )}

          {state === "loading" && (
            <div className="flex flex-col items-center gap-3 text-neutral-400 text-sm">
              <div className="w-6 h-6 rounded-full border-2 border-neutral-700 border-t-brand-400 animate-spin" />
              Reading your video…
            </div>
          )}

          {state === "error" && (
            <div className="flex flex-col items-center gap-3 max-w-lg text-center">
              <p className="text-neutral-300 text-sm">That file didn't load. Try a different video.</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-sm transition"
              >
                Choose another file
              </button>
              <input ref={fileInputRef} type="file" accept="video/*" onChange={handleFile} className="hidden" />
            </div>
          )}
        </div>
      )}

      {isActive && (
        <div className="flex-1 min-h-0 flex gap-4 w-full">
          <div className="flex-1 min-h-0 flex flex-col items-center gap-2">
            <Canvas canvasRef={canvasRef} mode={mode} />
            <LiveStatusPanel mode={mode} speakerCount={speakerCount} isTransitioning={isTransitioning} />
            <div className="w-full max-w-2xl shrink-0">
              <Controls
                playing={playing}
                mode={mode}
                muted={muted}
                onTogglePlay={togglePlay}
                onToggleMute={toggleMute}
                onSetMode={setMode}
                middle={timeline}
              />
            </div>
          </div>

          <AnalyticsDashboard
            mode={mode}
            meta={meta}
            progress={progress}
            duration={duration}
            speakerCount={speakerCount}
            isTransitioning={isTransitioning}
            metrics={metrics}
          />
        </div>
      )}
    </div>
  );
}
