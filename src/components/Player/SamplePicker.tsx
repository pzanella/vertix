interface SampleClip {
  file: string;
  poster: string;
  title: string;
  subtitle: string | null;
  speakers: number;
}

const SAMPLE_CLIPS: SampleClip[] = [
  { file: "1-speaker.mp4", poster: "/samples/posters/1-speaker.jpg", title: "One speaker", subtitle: null, speakers: 1 },
  { file: "2-speakers-a.mp4", poster: "/samples/posters/2-speakers-a.jpg", title: "2 speakers", subtitle: "example 1", speakers: 2 },
  { file: "2-speakers-b.mp4", poster: "/samples/posters/2-speakers-b.jpg", title: "2 speakers", subtitle: "no audio / example 2", speakers: 2 },
  { file: "2-speakers-c.mp4", poster: "/samples/posters/2-speakers-c.jpg", title: "2 speakers", subtitle: "no audio / example 3", speakers: 2 },
  { file: "2-speakers-d.mp4", poster: "/samples/posters/2-speakers-d.jpg", title: "2 speakers", subtitle: "no audio / example 4", speakers: 2 },
  { file: "3-speakers.mp4", poster: "/samples/posters/3-speakers.jpg", title: "3 speakers", subtitle: null, speakers: 3 },
];

interface SamplePickerProps {
  onSelect: (url: string) => void;
}

export function SamplePicker({ onSelect }: SamplePickerProps) {
  return (
    <div className="grid grid-cols-2 gap-2 w-full">
      {SAMPLE_CLIPS.map((clip) => (
        <button
          key={clip.file}
          onClick={() => onSelect(`/samples/${clip.file}`)}
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
            <span className="text-neutral-200 text-xs">{clip.title}</span>
            {clip.subtitle && <span className="text-[10px] text-neutral-500">{clip.subtitle}</span>}
          </div>
        </button>
      ))}
    </div>
  );
}
