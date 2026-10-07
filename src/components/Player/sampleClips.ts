export interface SampleClip {
  file: string;
  poster: string;
  title: string;
  subtitle: string | null;
  speakers: number;
  /** Real frame rate of the file (from ffprobe) — used by the benchmark to count expected frames. */
  nominalFps: number;
  /** File duration in seconds (from ffprobe) — used to estimate how long a benchmark suite takes. */
  durationSec: number;
}

// Public assets, so paths must respect Vite's `base` (root in dev, a
// subpath like "/vertix/" when deployed to a GitHub Pages project site) —
// a hardcoded absolute path would 404 as soon as the app isn't served
// from the domain root.
const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

export const sampleClipUrl = (file: string) => asset(`samples/${file}`);

export const SAMPLE_CLIPS: SampleClip[] = [
  {
    file: "1-speaker.mp4",
    poster: asset("samples/posters/1-speaker.jpg"),
    title: "One speaker",
    subtitle: null,
    speakers: 1,
    nominalFps: 25,
    durationSec: 34.92,
  },
  {
    file: "2-speakers-a.mp4",
    poster: asset("samples/posters/2-speakers-a.jpg"),
    title: "2 speakers",
    subtitle: "example 1",
    speakers: 2,
    nominalFps: 25,
    durationSec: 16.447,
  },
  {
    file: "2-speakers-b.mp4",
    poster: asset("samples/posters/2-speakers-b.jpg"),
    title: "2 speakers",
    subtitle: "no audio / example 2",
    speakers: 2,
    nominalFps: 50,
    durationSec: 10.22,
  },
  {
    file: "2-speakers-c.mp4",
    poster: asset("samples/posters/2-speakers-c.jpg"),
    title: "2 speakers",
    subtitle: "no audio / example 3",
    speakers: 2,
    nominalFps: 24000 / 1001,
    durationSec: 10.01,
  },
  {
    file: "2-speakers-d.mp4",
    poster: asset("samples/posters/2-speakers-d.jpg"),
    title: "2 speakers",
    subtitle: "no audio / example 4",
    speakers: 2,
    nominalFps: 30000 / 1001,
    durationSec: 7.808,
  },
  {
    file: "3-speakers.mp4",
    poster: asset("samples/posters/3-speakers.jpg"),
    title: "3 speakers",
    subtitle: null,
    speakers: 3,
    nominalFps: 25,
    durationSec: 11.733,
  },
];
