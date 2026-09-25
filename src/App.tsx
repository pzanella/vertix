import { useCallback, useMemo, useRef, useState } from "react";
import {
  AnalyticsDashboard,
  Canvas,
  Controls,
  LiveStatusPanel,
  SamplePicker,
  SourceTabs,
  StreamHealthOverlay,
  Timeline,
  UrlSourceInput,
} from "./components/Player";
import { useWasmReframe } from "./hooks/useWasmReframe";

export default function App() {
  const {
    canvasRef,
    videoRef,
    mode,
    setMode,
    togglePlay,
    replay,
    seek,
    load,
    progress,
    duration,
    state,
    muted,
    toggleMute,
    speakerCount,
    isTransitioning,
    meta,
    metrics,
    errorMessage,
    isBuffering,
    streamHealth,
    changeSource,
  } = useWasmReframe();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(true);

  const openFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const url = URL.createObjectURL(file);
      load(url, file.type || undefined);
    },
    [load]
  );

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => openFile(e.target.files?.[0]), [openFile]);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      openFile(e.dataTransfer.files?.[0]);
    },
    [openFile]
  );

  const playing = state === "playing";
  const isActive = state === "ready" || state === "playing" || state === "paused" || state === "ended";

  // Memoized so Controls (memoized itself) only re-renders when the
  // timeline actually needs to — otherwise passing JSX inline as a prop
  // would create a new element reference on every App render (e.g. from
  // unrelated dashboard metrics updating), defeating that memoization.
  const timeline = useMemo(
    () => <Timeline progress={progress} duration={duration} onSeek={seek} />,
    [progress, duration, seek]
  );

  // Same reasoning as `timeline` above — keeps Canvas's own memoization
  // meaningful instead of it re-rendering just because a new element
  // reference showed up in its `overlay` prop every render.
  const streamHealthOverlay = useMemo(
    () => <StreamHealthOverlay streamHealth={streamHealth} />,
    [streamHealth]
  );

  return (
    <div className="min-h-screen md:h-screen w-screen flex flex-col overflow-y-auto md:overflow-hidden p-4 gap-3">
      <header className="shrink-0 flex items-center justify-between gap-2 border-b border-white/5 pb-3">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <rect x="2" y="6" width="14" height="8" rx="1" className="text-neutral-600" />
            <rect x="9" y="3" width="7" height="18" rx="1" className="text-brand-400" />
          </svg>
          <h1 className="text-lg font-display font-semibold tracking-tight">
            <span className="text-brand-400">Ver</span>tix
          </h1>
          <p className="hidden sm:block text-xs text-neutral-500">
            Turn 16:9 video into 9:16. The camera follows the action for you.
          </p>
        </div>

        {isActive && (
          <button
            onClick={changeSource}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-neutral-800 text-xs text-neutral-400 hover:text-neutral-100 hover:border-neutral-600 active:scale-95 transition"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor">
              <path d="M12 4l6 6h-4v6h-4v-6H6l6-6zM5 19h14v2H5z" />
            </svg>
            Change source
          </button>
        )}
      </header>

      <video ref={videoRef} className="hidden" />

      {!isActive && (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4">
          <SourceTabs
            upload={
              <div className="flex flex-col items-center gap-2 w-full">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => state !== "loading" && fileInputRef.current?.click()}
                  className={`relative border-2 border-dashed rounded-2xl w-full py-14 flex flex-col items-center gap-3 transition ${
                    state === "loading" ? "cursor-wait opacity-70" : "cursor-pointer"
                  } ${dragging ? "border-brand-400 bg-brand-950/30" : "border-neutral-700 hover:border-brand-500"}`}
                >
                  <span className="absolute -top-1 -left-1 w-4 h-4 border-t border-l border-neutral-700" />
                  <span className="absolute -top-1 -right-1 w-4 h-4 border-t border-r border-neutral-700" />
                  <span className="absolute -bottom-1 -left-1 w-4 h-4 border-b border-l border-neutral-700" />
                  <span className="absolute -bottom-1 -right-1 w-4 h-4 border-b border-r border-neutral-700" />
                  {state === "loading" ? (
                    <>
                      <div className="w-8 h-8 rounded-full border-2 border-neutral-700 border-t-brand-400 animate-spin" />
                      <span className="text-neutral-400 text-sm">Reading your video…</span>
                    </>
                  ) : (
                    <>
                      <svg
                        viewBox="0 0 24 24"
                        className="w-9 h-9 text-neutral-500"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                      >
                        <path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 1-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 0-1 1h-3" />
                      </svg>
                      <span className="text-neutral-400 text-sm">Drop a 16:9 video here, or click to choose one</span>
                    </>
                  )}
                  <input ref={fileInputRef} type="file" accept="video/*" onChange={handleFile} className="hidden" />
                </div>
                {state === "error" && <p className="text-red-400 text-xs">{errorMessage}</p>}
              </div>
            }
            sample={
              <div
                className={`flex flex-col items-center gap-2 w-full ${state === "loading" ? "opacity-70 pointer-events-none" : ""}`}
              >
                <SamplePicker onSelect={load} />
                {state === "error" && <p className="text-red-400 text-xs">{errorMessage}</p>}
              </div>
            }
            url={<UrlSourceInput state={state} errorMessage={errorMessage} onLoad={load} />}
          />
        </div>
      )}

      {isActive && (
        <div className="flex-1 min-h-0 flex flex-col-reverse md:flex-row gap-4 w-full">
          <div className="flex-1 min-h-0 flex flex-col items-center gap-2">
            <Canvas canvasRef={canvasRef} mode={mode} overlay={streamHealthOverlay} />
            <div className="w-full flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <LiveStatusPanel mode={mode} speakerCount={speakerCount} isTransitioning={isTransitioning} />
                {isBuffering && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-neutral-900 border border-neutral-800 text-xs text-neutral-300">
                    <span className="w-3 h-3 rounded-full border-2 border-neutral-700 border-t-brand-400 animate-spin" />
                    Buffering…
                  </div>
                )}
              </div>
              <button
                onClick={() => setShowAnalytics((v) => !v)}
                className="md:hidden shrink-0 px-3 py-1.5 rounded-full bg-neutral-900 border border-neutral-800 text-xs text-neutral-400 hover:text-neutral-200 hover:border-neutral-700 transition"
              >
                {showAnalytics ? "Hide analytics" : "Show analytics"}
              </button>
            </div>
            <div className="w-full max-w-2xl shrink-0">
              <Controls
                playing={playing}
                ended={state === "ended"}
                mode={mode}
                muted={muted}
                onTogglePlay={togglePlay}
                onReplay={replay}
                onToggleMute={toggleMute}
                onSetMode={setMode}
                middle={timeline}
              />
            </div>
          </div>

          <div className={showAnalytics ? undefined : "hidden md:block"}>
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
        </div>
      )}
    </div>
  );
}
