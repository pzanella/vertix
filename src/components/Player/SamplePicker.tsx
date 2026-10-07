import { SAMPLE_CLIPS, sampleClipUrl } from "./sampleClips";

interface SamplePickerProps {
  onSelect: (url: string) => void;
}

export function SamplePicker({ onSelect }: SamplePickerProps) {
  return (
    <div className="grid grid-cols-2 gap-2 w-full">
      {SAMPLE_CLIPS.map((clip) => (
        <button
          key={clip.file}
          onClick={() => onSelect(sampleClipUrl(clip.file))}
          className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-2.5 text-left hover:border-brand-500 hover:bg-neutral-900 hover:-translate-y-0.5 hover:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.6)] transition duration-150 ease-out"
        >
          <div className="relative aspect-video w-full rounded-md overflow-hidden">
            <img src={clip.poster} alt={clip.title} className="aspect-video w-full object-cover rounded-md" />
            <div className="absolute bottom-1 right-1 flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-black/60">
              {Array.from({ length: clip.speakers }).map((_, i) => (
                <span key={i} className="w-1.5 h-1.5 rounded-full bg-neutral-300" />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-neutral-200 text-base">{clip.title}</span>
            {clip.subtitle && <span className="text-base text-neutral-500">{clip.subtitle}</span>}
          </div>
        </button>
      ))}
    </div>
  );
}
