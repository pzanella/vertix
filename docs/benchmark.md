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
  replaces the video currently loaded with the sample clips and two test
  clips with hard cuts.
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

### Local licensed clips

Clips you may only use locally (for example licensed news streams) can join
the suite without ever being committed or deployed. List them in `.env.local`
(gitignored):

```
VERTIX_E2E_HLS_URLS=news-a|https://…/master.m3u8|120,interview-b|https://…/master.m3u8
```

Each comma-separated entry is `url`, `label|url` or `label|url|maxSeconds`
(default 120 s: playback stops there). The suite plays them after the test
clips, named `local-<n>-<label>` in reports; the URL is never written to a
report or a log. They are included in the dev server (`npm run dev`), and in
a production build only with `VERTIX_LOCAL_CLIPS=1 npm run build` (then
`npm run preview`). A build with that flag fails in CI, and the deploy
workflow runs `scripts/check-no-local-clips.mjs`, which fails if a bundle
carries the list. `node scripts/check-lookahead.mjs --licensed` runs the same
clips headless.

While the local clips are served (dev server or `vite preview` with clips in
`.env.local`, or with `VERTIX_LOCAL_CLIPS=1` set), the server listens on
`127.0.0.1` only: any other `--host` (none, `0.0.0.0`, `::`, `localhost`, a
named address) is refused, so the clips never reach the network. A phone
reaches the server over USB with `adb reverse tcp:4173 tcp:4173` and opens
`http://localhost:4173/`.

Labels and file names of licensed clips stay in `.env.local` and `.eval/`
(gitignored). Docs, code and commits refer to them as licensed clip A, B, …;
scripts read the labels at runtime (for example `scripts/eval-shots.ts` reads
its tuning and held-out sets from `.eval/shot-clip-sets.json`).

### Settings

| Setting       | Default | Range      | Meaning                                                                                  |
| ------------- | ------- | ---------- | ---------------------------------------------------------------------------------------- |
| WASM warm-up  | 3 s     | 0–10 s     | Seconds played **without recording** after every WASM build switch. 0 disables it.        |
| Clip warm-up  | 1 s     | 0–3 s      | Media-time seconds at the start of each clip that are recorded but excluded from stats. |
| 16:9 baseline | on      | on / off   | Plays the first clip and the 50 fps one again in 16:9 (no detection) at the end.         |

The values used are stored in the report's `config`, so always quote them
with the numbers.

### Protocol

1. Collect the environment info. This includes a few milliseconds of
   busy-waiting to measure the timer resolution, so it happens before any
   playback.
2. For each of the six clips in `public/samples/` and the four test clips in
   `public/bench/` (`cross-count.mp4`, `cross-same-count.mp4`: hard cuts at
   4, 8 and 12 s, on detection frames; `cross-offset.mp4`: hard cuts at
   4.08, 8.12 and 12.16 s, between detection frames; `cross-50fps.mp4`:
   50 fps, hard cuts at 4.06, 8.14 and 12.18 s, on odd frames between
   detection frames, so some fall on frames the half-rate cut trigger
   skips), in order, run the
   clip once with lookahead off, on the build already loaded, then once per
   WASM build with lookahead on (see
   [WASM builds](#wasm-builds-simd-and-scalar)): SIMD then scalar on the
   odd-numbered clips, scalar then SIMD on the even-numbered ones. Without
   SIMD support, each clip runs once with lookahead off and once on, with
   the scalar build.
   The test clips are not in the repository: `npm run make:bench-clips` makes them from the sample clips (needs ffmpeg). The deploy
   workflow runs it, so they are on GitHub Pages; run it once locally before
   using the suite with `npm run dev` or `npm run preview`.
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
   with whichever build is loaded. Lookahead is bypassed in 16:9
   (`lookahead.bypassed` is true and `audioDelayMs` 0).

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
- scene-cut scores (colour histogram and luma grid against the previous
  call)
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

**Face tracks and layout rules (`tracking`, schema v6)**

- `layoutChangesPerMin`: `layoutChanges` per minute of measured playback.
- `subjectSwitches`, `subjectSwitchesPerMin`: times the framing moved to
  another tracked person within a shot (main subject, single person, or
  its fallback; a framed group in between does not reset it, a hard cut
  does).
- `timeInRulePct`: share of measured playback per rule, in percent:
  `broll`, `single`, `stacked`, `subject` (one face chosen among 3+
  foreground faces), `group` and `grid`. `group` only occurs with
  `MANY_FACES_RULES = "tracker"`; with the default rules `grid` is any
  unresolved 3-face scene, as on main. Measured
  on displayed frames, from the rule applied on each.
- `foregroundTracks`, `backgroundTracks`: tracks matched per detection
  that count for the layout, and those that do not (small faces behind).
- `paneSwaps`: ID switches, detections where the panes kept the same
  tracks in another order. Panes follow track IDs, so this should be 0.
- `leftToRightFlips`: detections where the left-to-right order of the pane
  tracks changed: the panel swaps the old x-sorted layout would have made.
- `trackerMs`: main-thread time of the tracker plus the layout rules per
  detection.
- **Limits:** times are wall time on displayed frames, so a stalled
  display stretches the rule on screen. Track IDs restart after every cut.

**Shot type (`tracking`, schema v8)**

- `timeInShotPct`: share of measured playback per shot type, in percent:
  `close` (framed as before), `wide` (faces small in the frame: the whole
  frame is shown) and `none` (no face: the whole frame). Measured on
  displayed frames.
- `shotChangesPerMin`: shot type changes per minute of measured playback.
- `gridSecOnWideShots`: seconds where the displayed layout was a grid during
  a `wide` or `none` shot. Whole-frame views never show a grid, so this
  should be 0.
- `fullSceneDrawMs`: time to draw one whole-frame (no crop) frame, in ms,
  summary with p50/p95. Only frames drawn whole are counted.
- `cropPathFrameWidths`, `cropPathPerMin`: how far the drawn crop centres
  moved, per displayed rule (all panes summed), in frame widths, and that
  per minute of measured playback in the rule. Glides only: layout changes
  and snaps are not counted. `raw.layoutRules` lists every displayed rule
  change with the media time of its frame.
- **Known limit:** a mid-distance group of 2–3 faces (largest face about
  0.15–0.25 of the frame) is treated as close: it keeps the speaker layout
  and is not shown whole. Licensed clip B (0–17 s, journalist voice-over) is
  the case seen: about 4 s of it is classified close. No crowd rule and no
  motion signal are used, so as not to turn 3-speaker close shots wide.
- **Multi-pane only with panel evidence.** With 2+ resolved faces, stacked
  or grid is shown only after the confirmed faces have been still for
  1.0 s of media time: mean face speed at most 0.4 face heights per second
  for two faces (`PANEL_MAX_SPEED_HEIGHTS_PER_SEC_2`), median at most 0.2
  for three or more (`PANEL_MAX_SPEED_HEIGHTS_PER_SEC`). Speeds use the real
  time between detections, so the result does not depend on the detection
  rate; a pair longer than 0.5 s (skipped detections) counts as neither
  still nor moving. It is left after 0.6 s of moving time, a cut, or fewer
  than two seats. Without evidence the whole frame is shown. Measured on the
  synthetic panels, the 2-speakers samples and licensed clip B, which did not hold
  still in its measured windows.
  - **Seats:** with evidence each face has a seat (its pane). A missing face
    keeps its seat for `MULTIPANE_HOLD_SEC` = 2.5 s (set from the longest
    gap on licensed clip C, 2.2 s); a new confirmed face at the same place
    takes it over. A new face gets a seat only after being still for 1.0 s
    itself, so a short-lived false box adds no pane.
  - **Accepted cost:** after each hard cut, and at the start of a clip, the
    whole frame is shown until the evidence exists (about 1 s). On the
    cross-* clips this adds one layout change per panel part (4 instead of 3
    on main); cross-same-count goes from 3 to 6.
  - **Known limit:** a crowd or group that moves (or never holds 1.0 s of
    still pairs) is shown whole, not in panes. Two speakers who move a lot
    while talking (2-speakers-b) lose most of their stacked time.
- **Missed detections.** A confirmed track that coasts through a missed
  detection (up to 0.8 s) still counts for the person count and the shot
  type, so a real exit shows up to 0.8 s later. "None" needs no confirmed
  track left, and leaving "none" uses the short 0.2 s hold.
- **Stationary camera.** A pane's crop stays put while its face's centre is
  inside 50% of the crop width and 40% of its height (around where the crop
  aims the face), and is aimed again only when the face leaves that box.

**Long tasks (`longTasks`)**

- **What it is:** main-thread tasks longer than 50 ms, reported by
  `PerformanceObserver` (`longtask`). The report gives their count, total
  duration and the distribution of their durations.
- **Limits:** Chromium only. Elsewhere `supported: false` and the counts are
  meaningless. It cannot tell which code caused a task.

### 16:9 baseline

This is the first clip, then the first one above 30 fps without cuts
(`2-speakers-b.mp4`, 50 fps), in 16:9 mode: no detection, and one
`drawImage` of the full frame per callback. Use it to compare dropped frames, long tasks and
frame accounting between reframing and plain playback.

Do **not** compare `frameWorkMs` between the two runs directly. The baseline
draws a 1280×720 output, while 9:16 draws a 405×720 output, so the per-frame
draw costs are not equivalent.

## Shot type and multi-pane results

Measured for the shot type, panel evidence and seats change. Desktop: the
production build (`scripts/bench-preview.mjs`), 3 runs of the 53-run suite,
0 failures. Licensed clips are named by letter: A street interview, B and G
news pieces with crowds (G held out), C news interview with two people, D–F
sport interviews.

### Constants (frozen)

| Constant | Value | Reason |
|---|---|---|
| `CLOSE_MIN_HMAX` / `WIDE_MAX_HMAX` | 0.25 / 0.15 | news and 3-speakers set the lower bound, a close shot in clip B the upper |
| `SHOT_HOLD_SEC` / `CUT_HOLD_SEC` | 1.0 / 0.2 s | 0.2 s also when leaving "none" |
| `PANEL_STILL_SEC` / `PANEL_EXIT_SEC` | 1.0 / 0.6 s | media time |
| `PANEL_MAX_SPEED_HEIGHTS_PER_SEC` | 0.2 h/s (3+ faces, median) | panels at most 0.122; the crowd in clip B at least 0.523 |
| `PANEL_MAX_SPEED_HEIGHTS_PER_SEC_2` | 0.4 h/s (2 faces, mean) | equals 0.08 per pair at 5 Hz |
| `MULTIPANE_HOLD_SEC` | 2.5 s | longest missing-face gap on clip C is 2.2 s |
| `MIN_HITS_TO_COAST` | 2 | a face seen only on a cut frame does not hold the layout |
| `STATIONARY_MARGIN_WIDTH` / `_HEIGHT` | 0.5 / 0.4 | not adjusted |

### Labelled time per clip

| Clip | Expected | Labelled time | Shown as expected | Multi-pane on single/whole | Grid |
|---|---|---|---|---|---|
| C | multi-pane | 143.6–143.8 s | 93.3% | 0 s | 0 s |
| B | single | 9.0 s | 92.5–94.2% | 0 s | 0 s |
| B | whole | 95.7–96.0 s | 99.4–99.7% | 0 s | 0 s |
| G (held out) | single | 30.4 s | 94.1–94.7% | 0 s | 0 s |
| G (held out) | whole | 44.6–44.8 s | 97.2–97.6% | 0 s | 0 s |

### Criteria

| Criterion | Result |
|---|---|
| B, G: 0 s multi-pane on labelled whole/single | ✓ |
| B, G: labelled single ≥ 90% | ✓ 92.5–94.7% |
| C: stacked ≥ 90% | ✓ 93.3% |
| C: grid 0 s | ✓ |
| C: layout changes ≤ 11 (main) | ✓ 7 |
| C: crop path lower | ✓ 0.248 → 0.056 frame widths per minute |
| Samples as on main apart from the ~1 s wait | ✓ 2-speakers-a/c/d, 3-speakers; 2-speakers-b shown whole (intended) |
| No displayed layout under 0.5 s except at cuts | ✓ none in 3 runs |
| No single → whole → single within 1 s after a cut (cross-*, B–G) | ✓ 0 |
| Cut offsets | ✓ 0 frames on the 25 fps cut clips; cross-50fps within −2…+1 frames (also on main) |

Checked by eye and intended: 2-speakers-b is shown whole (the speakers move
a lot while talking); clip A at 21.28 s has a flash in the source, which
resets the evidence for about 1.2 s; clip C is shown whole now and then when
the two people move; cross-count goes cut → whole → grid; the moving crowd in
clip B (4–6 s) and in clip G is shown whole.

### Phone (Android, main vs this change, 2 runs each, alternated)

| Measure | Result |
|---|---|
| Failures, hidden runs | 0 on both builds |
| Lookahead length | identical on 47 of 51 rows; the other 4 are 40 ms shorter on the branch |
| Detection p95 | same within noise: about 110–125 ms SIMD, 200–233 ms scalar |
| Whole-frame draw p95 | 0.36–2.06 ms (JavaScript time, not GPU time) |
| Dropped frames, 25–30 fps clips | 0–8 per run on both builds, so the cached-backdrop fallback is not needed |
| Dropped frames, 50 fps clips | high on both builds: 2-speakers-b main 89–93, branch 58–106; cross-50fps main 155–160, branch 137–150 |
| Cut offsets | 0 frames on the 25 fps cut clips; cross-50fps within −2…+1 frames on both builds, no misses |

### GitHub Pages check (v0.1.0)

- The phone on Pages matches the local build (SIMD detection p95 115–116 ms
  against 115–117). On desktop, SIMD detection on Pages was about 40% slower
  than locally while scalar matched; the cause is most likely the desktop
  setup (external 60 Hz monitor, power, thermals), not the CI build. Not
  proven.
- 50 fps clips drop frames on a 60 Hz display; 25–30 fps clips drop none.
  The numbers above come from the built-in Retina display.
- A phone HAR exported through remote inspect misses the workers' requests,
  so the network checks (0 third-party requests, gzip, cold download) rely on
  the desktop HAR.

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
lookaheadComparison, precisionWarnings, results[] }`. Each result contains `summary` and `raw`,
  and `raw` holds column arrays of every sample.
  - `schemaVersion` is 8 (v8 adds the shot-type fields of `tracking`). Every v7, v6, v5, v4 and v3 field is still there with
    the same meaning. Every v2 field is too, except
    `environment.wasmBuiltWithSimd` (see [Environment info](#environment-info)).
  - New in v7: `results[].extensions`, host measurements recorded with a run
    (`BenchmarkClipExtension`), absent when there were none. The demo app
    fills `extensions.faceMesh` only while its "Face mesh" switch is on:
    - `landmark`: `perFaceMs` (Face Landmarker time per face, in its
      worker), `perTickMs` (crops sent until meshes back), `resultAgeMs`
      (frame sent to detection until meshes back), each a summary with
      p50/p95; `checkedTicks`, `skippedTicks` (the previous check was still
      running), `frameMismatches`, `facesPerCheckedTick`, `noMeshShare`
      (checked faces without a mesh: turned heads), `workerRestarts`.
    - `drawMs`: overlay draw time per displayed frame.
    - `frames`: `displayed`, and the share of displayed frames whose least
      smooth mesh was `interpolated`, `stepped` or `held`, or that showed
      none (`empty`).
    - `flickerEventsPerMinute`: a track's mesh appearing or disappearing on
      screen, per minute of displayed media time, not counting scene cuts;
      `cutEventsPerMinute`: the same on the frame a cut is shown (meshes end
      with their shot by design).
    - `lookahead`: `{ lengthMs, baseLengthMs, minimumMs }` at the end of the
      run: the length with the mesh's minimum, without it, and the minimum.
    - `init`: `{ simd, downloadMs, loadMs, assets[] }` (assets with
      transfer and decoded bytes; transfer is 0 from the HTTP cache).
    - `wasmMemoryBytes`: the face mesh worker's WASM heap.
    - `blockedRequests`: `{ count, hosts }`, requests to other origins the
      face mesh worker's network guard stopped (MediaPipe's usage metrics).
    Warm-up seconds are excluded like everywhere else.
  - New in v6: `failures` at the top level, one entry per run or step that
    failed (empty when all completed). A failed step is recorded and the
    suite moves on to the next one; only Stop ends it early. Each entry:
    `{ name, message, stack, step: { index, total, kind, label }, clip,
    build, lookahead, mode, failedAt, resources, video }`. `resources` is a
    snapshot like the one below, with the last detection's media time and
    wall time (`engine.lastDetectionMediaTimeSec`, `lastDetectionAtMs`);
    `video` is the element's time, readyState, networkState and MediaError.
    A run that failed is also kept in `results` with what it recorded until
    then and its own `failure`. A source that has not loaded within 30 s
    fails its run ("Source did not load within 30 s"), and a 9:16 run fails
    when detection has stopped (see `detection` below). Per result,
    `resources: { start, end }`: live and created detection and
    cut-trigger workers, the WASM memory of the detection worker and of each
    build loaded on the main thread, `detection` (`state`: worker, starting,
    main-thread or stopped; `workerRestarts`; `message`),
    `performance.memory` (Chromium), and the engine's frame-buffer slots and
    bytes, queued decisions, pending detections and tracks.
  - Detection watchdog: a worker detection with no result after
    max(2 s, 10 × the build's detection p95) restarts the worker (a late
    answer from the old one is ignored). After 3 restarts within 60 s the
    worker is given up until the next build switch: detection runs on the
    main thread, or stops if that cannot load, with a message in the
    dashboard and in the failure.
  - Also new in v6: `summary.tracking` (see
    [Layout and main thread](#layout-and-main-thread)). `raw.detections`
    `keptFaces` now counts foreground faces (the tracker's foreground
    filter) instead of every speaker-sized face, and `resolvedFaces` /
    `resolvedCx` describe the layout planner's panes.
  - New in v5:
    - `lookaheadComparison.order`: `off-first-per-clip` for the suite.
    - Per result, `lookahead`: `{ enabled, unavailableReason, lengthMs,
      slotWidth, slotHeight, allocatedSlots, bufferBytes, droppedFrames }`
      (frame-copy size, estimated buffer memory, frames dropped by the
      buffer or superseded on display), read at the end of the run. Added
      later within v5:
      - `enabledByDefault` (lookahead is on by default with the SIMD
        build, off with scalar) and `setByHost` (the switch was set
        explicitly; always true in the suite, which runs each clip off and
        on and restores the user's setting afterwards).
      - `bypassed`: on, but not running because the run is 16:9 (no
        detection); the 16:9 baseline shows `true` with `audioDelayMs` 0.
      - `audioDelayMs`: the audio delay actually applied.
      - `delayFrames`: `lengthMs` in whole frames (the length is rounded up
        to whole frames).
      - `detectionP95Ms` and `lengthSource` (`measured`, `stored` or
        `default`): the detection time behind `lengthMs` and where it came
        from. Detections from a detector's first 2 s or first 5 results
        never count.
      - `overflowDrops` (the pool was full; should be 0) and
        `skippedOnDisplay` (a buffered frame passed over because the frame
        callback of its counterpart was skipped, or while the delay
        shrinks); `droppedFrames` is their sum.
      - `slotHeightChanges` (`{ mediaTimeSec, height, reason }` per change
        of the frame-copy height; `reason` is `drops`, `overflow`,
        `recovered`, `frame-rate` from the slot-height governor, or `pool`
        for a new pool size) and `timeAtSlotHeightMs` (wall time at each
        height, keyed by height). Above 30 fps the copies drop to 540 lines
        while the video element drops more than 5% of its frames over 3 s
        or the buffer overflows, and go back after 10 s under 2%.
      - `peakBufferBytes`: most frame-buffer memory used at once. Old-size
        copies still waiting count against the 96 MiB budget during a size
        change; when they leave no room, the oldest waiting frame is dropped
        (counted in `overflowDrops`) instead.
    - `summary.cutsShown[]`: every applied cut decision,
      `{ cutMediaTimeSec, shownMediaTimeSec, framesLate, source }`, where
      `framesLate` counts displayed frames from the cut frame up to the one
      the crop changed on (target 0), and `source` is how the cut was
      found: `trigger` (a detection the per-frame cut trigger asked for),
      `localised` (a regular detection, moved back to the frame with the
      biggest jump) or `tick` (a regular detection on the cut frame, or
      without lookahead). Without lookahead the cut frame is the detection
      frame, so `framesLate` undercounts; use `knownCuts`.
    - `summary.knownCuts[]`: for clips with known cuts,
      `{ timeSec, framesLate, shownMediaTimeSec, source }` against the real cut
      frame (`framesLate` null when the crop never changed for it).
    - `summary.display`: `{ count, errorMs, workMs }`. `errorMs` (lookahead
      only) is when a frame reaches the screen minus when it should
      (its own display time + the lookahead). It counts the presentation
      jitter of both frames: on a phone that drops frames it reads about
      ±30 ms even when the exact frame is shown. Added later within v5:
      - `clockErrorMs` (with and without lookahead): when a frame reaches
        the screen minus when its audio is heard, against a steady clock
        fitted to the video element's display times (median of
        `expectedDisplayTime − mediaTime` over ±2 s of frame callbacks;
        playback rate 1). Without lookahead it is the video element's own
        jitter: the baseline to compare the lookahead run with.
        `clockErrorAbsMs` is the same as absolute values.
      - `frameOffset` (lookahead only): frames between the due frame and
        the one shown, positive when the one shown is older; 0 is exact.
        When the due frame was presented by the video element but never
        captured (its callback was skipped, per `presentedFrames`) and the
        screen would fall behind, the nearest captured frame is shown, the
        newer one on a tie (-1). A frame the element dropped itself (or
        without `presentedFrames`) is held over, as the element does (+1).
      - Raw: `frames.expectedDisplayMs`, and per display `onScreenAtMs`,
        `delayMs`, `frameOffset` and `clockErrorMs`.
    - `summary.trigger`: `{ count, mainThreadMs, triggeredDetections }`,
      the main-thread cost per frame of the cut trigger and how many
      detections it started. Target: `mainThreadMs` p95 ≤ 2 ms on a
      phone, with no extra dropped frames. Added later within v5: `drawMs`
      (scaling the buffered copy into a small canvas and
      `transferToImageBitmap`) and `postMs` (`postMessage`), the two parts
      of `mainThreadMs`; `path` and `skippedBusy`. A VideoFrame path was
      tried within v5 and removed (on a phone it was no cheaper and skipped
      frames while the worker was busy): `path` is now always `bitmap`
      (null without trigger frames) and `skippedBusy` always 0.
    - `summary.detectionGaps`: `{ pairs, irregular, histogram }`, gaps
      between detections in frames (mouth motion is measured over the gap;
      regular is 5).
    - Raw: `displays`, `cutsShown`, `triggers` (with `drawMs`, `postMs` and `path`),
      and per detection `triggered`, `resolvedFaces`, `resolvedCx`.
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
    `layout_change`, `long_task`, `display`, `cut_shown` or `trigger`
    (the last three since v5, with the columns `lookahead_ms`,
    `triggered`, `resolved_faces`, `resolved_cx`, `error_ms`,
    `cut_media_time_s`, `shown_media_time_s` and `cut_source` added at
    the end).
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

- **Shot type sees only face sizes.** A person who stays large in the frame
  while the scene around them changes (an interviewee signing autographs)
  stays close, framed single; the change of scene is not seen.
- **Cut shown early at 50 fps.** On cross-50fps the crop change at a cut is
  sometimes shown 1–3 frames before the cut, also on main (the trigger scores
  the frame next to the cut as the cut frame). `scripts/check-lookahead.mjs`
  reports a signed offset in displayed frames per cut (negative = early,
  positive = late; "missed" only without a crop change within 5 frames), and
  `scripts/cut-offsets.mjs` summarises it from `--save-raw` output.
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
