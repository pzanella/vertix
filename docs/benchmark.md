# Benchmark mode

Vertix has a built-in benchmark mode that measures the reframing pipeline in
the browser while it plays real clips. This page explains what each number
means, how it is measured, and where the measurement stops being reliable.

## Running it

Open the app — locally after `npm run build && npm run preview`
(`http://localhost:4173/`), or deployed at <https://pzanella.github.io/vertix/>
— load any video (a sample clip is fine), then press the **gauge button** at
the right end of the header. The button only appears once a video is loaded.
It opens a panel (a popover on desktop, a bottom sheet on phones) with:

- **Run suite**: the reproducible run. Use this for published numbers. It
  replaces the video currently loaded with the sample clips.
- **Run current clip**: rewinds and replays whatever is loaded (for example
  your own file) and records it with the WASM build already loaded. There is
  no WASM warm-up before it, so run it after the engine has already processed
  some video.
- The run settings, editable before a run (see below), and an estimate of how
  long the suite takes.

When a run starts the panel closes so the player stays visible; the gauge's
needle and ring show the progress, and tapping it shows the current stage and
a **Stop** button. When the run ends the panel reopens on the results: summary
cards, validity and precision warnings, a metric × clip table, the environment
line, and **JSON** / **CSV** downloads. The summary is also printed with
`console.table`, and the full report is available in DevTools as
`window.vertixBenchmarkReport`.

The engine's benchmark hooks only do work while a run is in progress: outside
a run no recorder is attached and each hook is a single `null` check, so
normal playback is unaffected by the button being there.

### Settings

| Setting       | Default | Range      | Meaning                                                                                  |
| ------------- | ------- | ---------- | ---------------------------------------------------------------------------------------- |
| WASM warm-up  | 3 s     | 0–10 s     | Seconds played **without recording** after every WASM build switch. 0 disables it.        |
| Clip warm-up  | 1 s     | 0–3 s      | Media-time seconds at the start of each clip that are recorded but excluded from stats. |
| 16:9 baseline | on      | on / off   | Plays the first clip again in 16:9 (no detection) at the end of the suite.              |

The values used are stored in the report's `config`, so always quote them
with the numbers.

### Protocol

1. Collect the environment info. This includes a few milliseconds of
   busy-waiting to measure the timer resolution, so it happens before any
   playback.
2. For each of the six clips in `public/samples/`, in order, run the clip once
   per WASM build (see [WASM builds](#wasm-builds-simd-and-scalar)): SIMD then
   scalar on the 1st, 3rd and 5th clip, scalar then SIMD on the 2nd, 4th and
   6th. Without SIMD support, each clip runs once with the scalar build.
3. **Build switch and WASM warm-up**: whenever the next run needs the other
   build, the suite replaces the detection worker with a new one that loads
   that build, then plays the first *WASM warm-up* seconds of the next clip in
   9:16 without recording. The first detection calls after a switch are
   slower (WASM instantiation, tract model optimization on first run, JIT
   tiering, worker start-up). This step keeps them out of the data. The suite
   always starts with a switch, so the first run also gets a fresh worker.
4. **Clip run**: wait 1 s, load the clip, and play it in 9:16 from start to
   end at 1× speed. Samples from the first *clip warm-up* seconds of media
   time are flagged `warmup = 1`. They stay in the raw data but are excluded
   from every summary.
5. **Baseline** (optional): play `1-speaker.mp4` again in 16:9 mode. That mode
   runs no detection and draws the full frame unchanged, so it runs once,
   with whichever build is loaded.

When the suite ends (finished, stopped or failed), the app switches back to
the build it picks on its own.

### Getting reproducible numbers

- Measure a **production build** (`npm run preview` or GitHub Pages), never
  `npm run dev`: dev mode is unminified and runs extra React checks.
- Keep the tab **visible and in the foreground** for the whole run. Browsers
  stop presenting video frames in hidden tabs. A run where the page was hidden
  is flagged `pageHiddenDuringRun` and shown as invalid in the results.
- **Start from a freshly loaded page** when collecting numbers to publish, so
  nothing from earlier playback (caches, JIT state, GC pressure) skews them.
- Close other tabs and apps, and plug in laptops. On phones, disable battery
  saver and let the device cool down between runs.
- Run the suite at least 3 times and report the spread, not the best run.
- Audio: two clips (`2-speakers-a`, `3-speakers`) have an audio track. With 3
  or more faces, audio energy is an input to the layout decision. The suite
  starts from your click, so it normally plays unmuted. If the browser forced
  muted playback, the result says `muted: true`.

## WASM builds (SIMD and scalar)

The detector is compiled twice from the same Rust code, with the same JS API
(`update_faces` returns 7 values per face, skin-rejected boxes included):

- **SIMD**: built with `-C target-feature=+simd128`. tract then uses its
  hand-written wasm32 SIMD kernel for f32 matrix multiplication, and the
  compiler may auto-vectorize other loops.
- **Scalar**: the same build without `simd128`, for browsers without
  WebAssembly SIMD.

`npm run build:wasm` builds both (see `scripts/build-wasm.mjs`) and fails if
the scalar build contains a SIMD instruction or the SIMD build contains
none.

Outside the benchmark, the app picks one build at start-up: SIMD when
`WebAssembly.validate` accepts a tiny SIMD module, else scalar. Only that
build's `.wasm` is downloaded, both by the worker and by the main-thread
fallback.

The suite measures both builds on the same device in the same session, with
no URL parameter: it switches the build between runs as described in
[Protocol](#protocol). The order alternates per clip, so if a phone heats up
and slows down during the run, neither build is always the one measured on
the hotter device. Compare the two builds clip by clip, using the runs of
the same clip (`clip` and `wasmBuild.variant` in each result), and pool
several suites before drawing conclusions.

SIMD only changes the WASM call itself (`wasmMs`). The downscale, the pixel
readback, the messaging between threads, post-processing, layout and drawing
run the same code in both builds.

`npm run compare:wasm` checks that both builds produce the same detections:
it feeds the same frames from `public/samples/` to both and lists any
difference in boxes, scores, face counts or threshold decisions.

## Metrics

All durations are milliseconds from `performance.now()`. Every metric
reports `count`, `mean`, `p50`, `p95`, `p99` and `max` over the measured
(non-warm-up) samples. Percentiles use linear interpolation between ranks
(NumPy's default method, `src/core/bench/stats.ts`).

### Per rendered frame

**Frame work (`frameWorkMs`)**

- **What it is:** main-thread time spent inside one `requestVideoFrameCallback`
  callback. This includes pane smoothing, the canvas `drawImage` calls, the
  layout-change cross-dissolve, and the work that happens only on some frames:
  starting a detection (every 5th callback) and pushing dashboard metrics
  (every 300 ms).
- **How:** `performance.now()` at the start and at the end of the callback.
- **Limits:**
  - This is **CPU time to issue the draw calls**, not GPU time. Canvas 2D
    drawing is mostly recorded and run later by the GPU process, so the real
    cost of scaling the video shows up elsewhere: as dropped frames, if it
    shows up at all.
  - Typical values are about 0.1–1 ms, which is close to the timer
    resolution (see "Timer precision").

**Frame interval (`frameIntervalMs`)**

- **What it is:** time between consecutive callbacks.
- **How:** differences of the callback's `now` argument.

**Effective render FPS (`effectiveFps`)**

- **What it is:** `(callbacks − 1) / wall-clock span`.
- **Limits:** this number is capped by the video's frame rate. The callback
  fires once per new video frame, so 25 on a 25 fps clip means "kept up with
  every frame". It is not a measure of maximum throughput.

**Frame accounting (`frames`)**

- `expectedFrames`: Δ`mediaTime` × fps. It uses the clip's real frame rate
  (from ffprobe, `fpsSource: "nominal"`). For other sources it estimates the
  rate from the median `mediaTime` step (`"estimated"`).
- `presentedFrames`: Δ`presentedFrames` from the callback metadata.
- `droppedFramesEstimate`: `expectedFrames − presentedFrames`, never below 0.
- `missedCallbacks`: `presentedFrames − (callbacks − 1)`. These are frames the
  browser showed without running our callback for them, usually because the
  main thread was busy.
- `playbackQualityDroppedFrames` / `playbackQualityTotalFrames`: change in
  `getVideoPlaybackQuality()` over the same window, as an independent
  cross-check.
- `duplicateCallbacks`: callbacks that reported the same `presentedFrames` as
  the previous one. Any value above 0 means more than one render loop was
  running, and the run is **not valid**.
- **Limits:**
  - `presentedFrames` is "frames submitted for composition". Browsers
    implement it slightly differently, so compare it with the
    `getVideoPlaybackQuality` numbers.
  - `mediaTime` has the media's timestamp precision, so expected frames are
    rounded to the nearest integer.
  - With a ±1 frame error on a 200–850 frame window, read small dropped
    counts (0–2) as "none".

### Per detection

Detection runs on every 5th frame callback in 9:16 mode, and only when the
previous detection has finished. On the normal path it runs in a Web Worker.
If the worker cannot start, it runs on the main thread (`path`).

| Metric                 | Worker path (normal)                                                                    | Main-thread fallback                         |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| `downscaleMs`          | `createImageBitmap(video, 320×240)` call → promise resolved, on the main thread         | `drawImage(video → 320×240 canvas)`          |
| `readbackMs`           | In the worker: `drawImage(bitmap)` + `getImageData` (GPU → CPU pixel read)              | `getImageData`                               |
| `acquireMs`            | `downscaleMs + readbackMs`                                                              | same                                         |
| `wasmMs`               | In the worker: the whole `update_faces()` WASM call                                     | same, on the main thread                     |
| `postProcessMs`        | Main thread: `processDetectionResult` (filters, active speaker, debounce, layout, emit) | same                                         |
| `totalMs`              | Dispatch on the main thread → end of post-processing                                    | same                                         |
| `overheadMs`           | `total − acquire − wasm − post`: `postMessage` transfer and event-loop queueing         | ≈ 0                                          |
| `rawFaces`/`keptFaces` | Faces WASM returned as passing the skin filter / faces left after the size and visibility filters | same                                         |

What one `update_faces()` call contains:

- RGBA → normalized f32 tensor
- the UltraFace slim-320 forward pass (tract)
- score threshold and NMS
- skin-tone filter
- mouth-motion difference
- copy of the frame for the next call

These cannot be split further without timing code inside Rust, so `wasmMs`
is "the whole WASM call", not "model inference".

Further limits:

- `downscaleMs` is wall-clock time from the call until its promise resolves.
  It includes any time the main thread spent on other work before handling
  the resolution, so it is an upper bound on the actual scaling cost.
- Worker durations come from the worker's own clock. Durations are
  comparable; absolute timestamps from the two threads are not.
- `postProcessMs` includes calling the engine's listeners. In this app those
  schedule React state updates; the React render happens later and is not
  included.

**Detection rate (`rateHz`) and skipped detections (`skippedInFlight`)**

- `rateHz` = completed detections / measured wall-clock seconds. The target is
  about video fps ÷ 5: 5 Hz at 25 fps, 10 Hz at 50 fps.
- `skippedInFlight` counts frames where a detection was due but the previous
  one had not returned. A non-zero value means detection cannot keep up on
  this device, and the layout reacts more slowly than designed.

### Layout and main thread

**Layout changes (`layoutChanges`)**

- **What it is:** committed changes of the layout (for example B-roll → 1
  speaker → 2-speaker split) after warm-up.
- **Limits:** the first layout commit of a clip is not counted.

**Long tasks (`longTasks`)**

- **What it is:** main-thread tasks longer than 50 ms, reported by
  `PerformanceObserver` (`longtask`). The report gives their count, total
  duration and the distribution of their durations.
- **Limits:** Chromium only. Elsewhere `supported: false` and the counts are
  meaningless. It cannot tell which code caused a task.

### 16:9 baseline

This is the same clip in 16:9 mode: no detection, and one `drawImage` of the
full frame per callback. Use it to compare dropped frames, long tasks and
frame accounting between reframing and plain playback.

Do **not** compare `frameWorkMs` between the two runs directly. The baseline
draws a 1280×720 output, while 9:16 draws a 405×720 output, so the per-frame
draw costs are not equivalent.

## Environment info

Each report includes:

- `userAgent`
- `hardwareConcurrency`
- `deviceMemoryGb`: Chromium only, rounded by the browser
- screen size and `devicePixelRatio`
- `crossOriginIsolated`
- `wasmSimdSupported`: `WebAssembly.validate` on a 31-byte module that uses
  `i8x16.popcnt`
- `wasmBuiltWithSimd`: kept from schema v2 with a new meaning. Since v3 there
  are two builds, and this is `true` when the build this device loads by
  default is the SIMD one (so it now equals `wasmSimdSupported`). It does
  not say which build a run used; read each result's `wasmBuild` for that.
- `wasmBuild`: `{ defaultVariant, defaultReason }`, the build this device
  loads outside the benchmark (`simd` / `scalar`) and why (`supported` /
  `not-supported`)
- `wasmBinarySizes`: `{ simd, scalar }`, the size in bytes of each `.wasm`
  file, recorded at build time
- `requestVideoFrameCallbackSupported` and `longTasksSupported`
- `timerResolutionMs`: the measured `performance.now()` step

Each clip result adds:

- the video resolution and duration
- the clip name and `mode`
- `warmupSec`
- `muted` and `pageHiddenDuringRun`
- `overflow`: the number of samples that did not fit in the preallocated
  buffers. It should always be 0.
- `wasmBuild`: `{ variant, reason, runOrder }`
  - `variant`: `simd` or `scalar`, the build that ran
  - `reason`: `benchmark-suite` (the suite chose it for the comparison),
    `supported` (the default SIMD build, for example in *Run current clip*)
    or `not-supported` (the scalar build, because this browser has no SIMD)
  - `runOrder`: `{ position, sequence }` in the A/B suite, for example
    `{ position: 2, sequence: ["scalar", "simd"] }` for the second run of an
    even-numbered clip; `null` otherwise. For the 16:9 baseline, `variant`
    is just the build that happened to be loaded.

## Output files

- **JSON**: `{ tool, schemaVersion, config, environment, wasmBuildComparison,
precisionWarnings, results[] }`. Each result contains `summary` and `raw`,
  and `raw` holds column arrays of every sample.
  - `schemaVersion` is 4. Every v3 field is still there with the same
    meaning. Every v2 field is too, except `environment.wasmBuiltWithSimd`
    (see [Environment info](#environment-info)).
  - New in v4: `summary.sceneCutCount` and `summary.sceneCuts[]`
    (`{ mediaTimeSec, histScore, gridScore, warmup }`, the hard cuts the
    detector found, warm-up included), and per-detection columns in
    `raw.detections`: `frameMediaTimeSec` (media time of the analysed frame),
    `sceneCutHist`, `sceneCutGrid` (cut scores, 0..1) and `sceneCut` (1 on a
    detected cut). The CSV has the same four as `frame_media_time_s`,
    `scene_cut_hist`, `scene_cut_grid` and `scene_cut`.
  - `wasmBuildComparison`: `{ builds, order, simdSkippedReason }`. `builds`
    lists the builds measured; `order` is `alternating-per-clip` for the A/B
    suite; `simdSkippedReason` is `not-supported` when the browser could not
    run the SIMD build.
- **CSV**: one row per raw sample in a single long-format table.
  - `kind` is one of `frame`, `detection`, `skipped_detection`,
    `layout_change` or `long_task`.
  - Every row also has `clip`, `mode`, `wasm_build`, `wasm_build_position`,
    `index` and `warmup`, plus the columns that apply to its kind.
  - The table loads directly into pandas or R:
    `df[df.kind == "detection"]`.

## Measurement overhead

- Samples go into typed arrays that are allocated once per clip from its
  duration. Recording a sample only writes numbers into them, with no
  per-frame allocation.
- Summaries and exports are computed after playback ends.
- With a recorder attached, the extra work is:
  - per frame: 2 `performance.now()` calls and one recorder call
  - per detection: 3–4 `performance.now()` calls on the main thread and 2 in
    the worker
- Outside a run no recorder exists. The worker still receives a
  `measureReadback: false` flag and skips its timers.

## Timer precision

GitHub Pages cannot send the `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers, so the page is not cross-origin
isolated (`crossOriginIsolated: false`). As a defense against timing
attacks, browsers then make `performance.now()` coarser:

| Browser  | Not isolated (GitHub Pages) | Cross-origin isolated |
| -------- | --------------------------- | --------------------- |
| Chromium | 100 µs, with jitter         | 5 µs                  |
| Firefox  | 1 ms (default)              | 20 µs                 |
| Safari   | 1 ms                        | —                     |

These are typical defaults and can change between versions. The report
stores the value it **measured** (`timerResolutionMs`); quote that one.

What this means for the metrics:

- **Close to the resolution**:
  - `frameWorkMs` (typically 0.1–1 ms)
  - `postProcessMs`
  - sometimes `readbackMs` and `downscaleMs`
  - `overheadMs`, which is computed from several timer readings

  On Chromium they show as multiples of 0.1 ms. On Firefox and Safari they
  are mostly 0 or 1 ms. Their medians are only an indication; their high
  percentiles are more reliable.

- The report adds an entry to `precisionWarnings` for every timing metric
  whose median is below 10× the measured resolution. The panel shows how many
  there are.
- **Reliable**: `wasmMs` and `totalMs` (tens of ms), frame counts, rates and
  long tasks. They are hundreds of times larger than the timer step.

## Known limits

- **Small samples.** The clips are 7.8–34.9 s long, which gives roughly
  40–170 detections per clip.
  - With fewer than about 100 samples, p99 is effectively the maximum.
  - Prefer p50 and p95, and pool several runs for tail percentiles.
- **Clip warm-up.** 1 s is meant to cover player start-up only. The WASM
  warm-up happens after each build switch, not before every clip. Choosing a different clip warm-up
  changes which samples are counted, so always quote the value used. It is in
  the report's `config`.
- **requestVideoFrameCallback support.** The engine itself needs it: Chromium
  83+, Safari 15.4+, Firefox 132+. On browsers without it nothing renders, so
  there is nothing to measure.
- **Clocks.** Main-thread and worker timings come from different
  `performance.now()` clocks. Only durations are mixed.
- **Thermal and power state.** Phones throttle under sustained load; a second
  run right after the first one may be slower. Write down the device state.
- **Duplicate render loops.** Older versions of the app left a second render
  loop running after "Change source" (every frame drawn twice, detection about
  twice as often). The engine now cancels its pending frame callback when it
  is re-attached, so this should not happen. `duplicateCallbacks` stays as a
  guard: if it is ever above 0, the run is marked invalid.
