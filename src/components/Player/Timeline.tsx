interface TimelineProps {
  progress: number;
  duration: number;
  onSeek: (fraction: number) => void;
}

export function Timeline({ progress, duration, onSeek }: TimelineProps) {
  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex items-center gap-3 w-full px-2">
      <span className="text-xs text-neutral-400 tabular-nums w-10 text-right">
        {formatTime(progress * duration)}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={progress}
        onChange={(e) => onSeek(parseFloat(e.target.value))}
        className="flex-1 h-1 accent-brand-500 cursor-pointer"
      />
      <span className="text-xs text-neutral-400 tabular-nums w-10">
        {formatTime(duration)}
      </span>
    </div>
  );
}
