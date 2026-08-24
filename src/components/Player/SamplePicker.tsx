interface SampleClip {
  file: string;
  label: string;
}

const SAMPLE_CLIPS: SampleClip[] = [
  { file: "1-speaker.mp4", label: "One speaker" },
  { file: "2-speakers-a.mp4", label: "2 speakers without audio - example 1" },
  { file: "2-speakers-b.mp4", label: "2 speakers without audio - example 2" },
  { file: "2-speakers-c.mp4", label: "2 speakers without audio - example 3" },
  { file: "2-speakers-d.mp4", label: "2 speakers without audio - example 4" },
  { file: "3-speakers.mp4", label: "3 speakers without audio" },
];

interface SamplePickerProps {
  onSelect: (url: string) => void;
}

export function SamplePicker({ onSelect }: SamplePickerProps) {
  return (
    <div className="flex flex-col items-center gap-2 text-sm">
      <span className="text-neutral-500">Try a sample clip</span>
      <select
        defaultValue=""
        onChange={(e) => {
          if (e.target.value) onSelect(e.target.value);
        }}
        className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-neutral-300 hover:border-brand-500 transition cursor-pointer"
      >
        <option value="" disabled>
          Choose a sample clip…
        </option>
        {SAMPLE_CLIPS.map((clip) => (
          <option key={clip.file} value={`/samples/${clip.file}`}>
            {clip.label}
          </option>
        ))}
      </select>
    </div>
  );
}
