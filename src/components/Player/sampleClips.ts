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

/** A clip the benchmark suite plays. */
export interface BenchmarkClip {
  file: string;
  url: string;
  nominalFps: number;
  durationSec: number;
  /** Media times of the clip's real hard cuts (test clips only). */
  knownCutsSec: readonly number[];
}

/**
 * Benchmark-only test clips with known hard cuts, made by
 * `npm run make:bench-clips` from the sample clips (1280x720,
 * 25 fps, no audio; not in the repository). Not offered in the sample picker.
 */
export const CUT_TEST_CLIPS: BenchmarkClip[] = [
  { file: "cross-count.mp4", nominalFps: 25, durationSec: 16, knownCutsSec: [4, 8, 12] },
  { file: "cross-same-count.mp4", nominalFps: 25, durationSec: 16, knownCutsSec: [4, 8, 12] },
  // Cuts between detection frames (frames 102, 203, 304), for the cut trigger and cut localisation.
  { file: "cross-offset.mp4", nominalFps: 25, durationSec: 16.16, knownCutsSec: [4.08, 8.12, 12.16] },
].map((clip) => ({ ...clip, url: asset(`bench/${clip.file}`) }));

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

export const BENCHMARK_CLIPS: BenchmarkClip[] = [
  ...SAMPLE_CLIPS.map(({ file, nominalFps, durationSec }) => ({
    file,
    url: sampleClipUrl(file),
    nominalFps,
    durationSec,
    knownCutsSec: [],
  })),
  ...CUT_TEST_CLIPS,
];
