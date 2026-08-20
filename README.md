# Vertix

Turn a 16:9 video into 9:16, right in your browser. Vertix finds faces,
works out how many speakers are on screen, and frames each one — a single
speaker gets a comfortable chest-up crop, two speakers get a stacked
split-screen, three or more get a grid. When no face is visible (a cutaway,
b-roll, an establishing shot), it shows the full frame instead of guessing
a crop. Nothing is uploaded. Everything runs on your machine.

## Why

A simple center-crop often cuts off the person who matters most, especially
when more than one person is on screen — and video with no one on screen
at all (action shots, cutaways) needs to be left alone, not cropped by
guesswork. Doing this well needs a few things: a way to *find* faces, a way
to decide *how many people* are actually speakers (not background extras),
a way to *lay out* however many there are, and a way to *move* the crop
smoothly instead of jittering on every small gesture.

- **Finding faces** needs a real face detector, not a guess based on color
  or brightness. Vertix runs a small pretrained model
  ([UltraFace](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB),
  MIT license, ~1.2MB) in Rust compiled to WebAssembly (WASM) — this is not
  a model Vertix trained itself, just a good small one reused as-is.
- **Deciding who counts as a speaker** filters out background people: a
  face has to be reasonably large (not someone far away in the crowd) and
  mostly inside the frame (not half cut off at the edge) to count.
- **Laying out** N speakers is a simple rule: 1 fills the whole 9:16 frame,
  2 stack top/bottom, 3+ form a grid. 0 speakers means "don't crop at all,"
  not "guess where the interesting part of the frame is."
- **Moving smoothly** uses a dead zone (small, ordinary movements are
  ignored outright) plus a gentle glide toward any position that moves far
  enough to matter — so the crop holds still through normal head/body
  motion instead of constantly micro-adjusting.

Running a face detector on every single frame is too slow for real-time
video, so Vertix only re-detects a few times a second. The final crop is
still drawn straight from the video at full resolution using the GPU — no
manual pixel copying for the output frame.

## Features

- **Face-aware, speaker-count-aware reframing** — a real face-detection
  model finds people; size and visibility checks decide which of them
  count as an actual on-camera speaker.
- **Multi-speaker layouts** — 1 speaker gets a chest-up crop, 2 stack
  top/bottom, 3+ form a grid, updated automatically as people enter or
  leave frame.
- **B-roll fallback** — 0 speakers on screen means the full frame is shown,
  uncropped, instead of a guessed-at crop.
- **Stable camera** — a dead zone plus smoothing means the crop only moves
  for a real, intentional reposition, not every small gesture.
- **Smooth transitions** — layout changes (single → split → b-roll, ...)
  cross-dissolve instead of cutting instantly.
- **Live analytics dashboard** — FPS, detection confidence, motion
  activity, and render latency, each with a live trend chart.
- **Two views** — the original 16:9, or the reframed 9:16 — toggle at any
  time, even mid-playback.
- **Load any local video** — drag and drop a file, or click to choose one.
  Nothing leaves your browser.

## Architecture

The reframing logic and the web app around it are two separate things:

- **`src/core/`** is the reframe engine — face detection, the
  multi-speaker layout decision, smoothing, and the canvas render loop.
  It has **zero dependency on React** (or any UI framework): it's plain
  TypeScript that reads frames from an `HTMLVideoElement` and draws to an
  `HTMLCanvasElement`. It's written this way on purpose, so it can
  eventually ship as its own package and drop into any video player —
  including ones managed by something like Shaka Player or hls.js. See
  [`src/core/README.md`](src/core/README.md) for the engine's own API, and
  [`docs/player-integration.md`](docs/player-integration.md) for a worked
  integration example.
- **`src/hooks/useWasmReframe.ts`** is a thin React adapter around the
  engine. It owns everything specific to *this app's* playback UI —
  loading a local file, play/pause/seek, mute, the scrub bar — and mirrors
  the engine's own state into React state for the components to render.
- **`src/App.tsx`** and **`src/components/Player/`** are the actual UI:
  the canvas, the transport bar, the live status badge, and the analytics
  dashboard with its trend charts.

In short: if you're touching *how the reframing decides what to show*,
you're in `src/core/`. If you're touching *how the app looks or behaves as
a web page*, you're in `src/hooks/` or `src/components/`.

## Project Structure

```
.
├── index.html                    # Vite entry point
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── src/
│   ├── main.tsx                    # React entry point
│   ├── App.tsx                     # Layout, file loading, player state
│   ├── core/                       # Framework-agnostic reframe engine (see src/core/README.md)
│   │   ├── VertixEngine.ts           # Detection loop, layout decisions, canvas rendering
│   │   ├── layoutEngine.ts           # Pure layout math: crop rects, dead zone, smoothing
│   │   ├── index.ts                  # Public exports
│   │   └── wasm/                     # Generated bindings (wasm-pack output, gitignored)
│   │       ├── wasm.js
│   │       ├── wasm.d.ts
│   │       └── wasm_bg.wasm
│   ├── hooks/
│   │   └── useWasmReframe.ts       # Thin React adapter around VertixEngine
│   └── components/Player/
│       ├── Canvas.tsx                 # <canvas> the video is drawn into
│       ├── Controls.tsx               # Play/pause, mute, mode toggle, scrub bar
│       ├── Timeline.tsx               # Scrub bar (rendered inside Controls)
│       ├── LiveStatusPanel.tsx        # Small "Status: ..." badge
│       ├── AnalyticsDashboard.tsx     # Live metrics panel
│       └── LiveAnalyticsCharts.tsx    # Sparkline trend charts
├── wasm/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                  # ReframeEngine: WASM entry points
│       ├── face.rs                 # Face detection, filtering, scoring
│       └── models/
│           ├── ultraface-slim-320.onnx  # Pretrained face detector (MIT)
│           └── ATTRIBUTION.md
└── docs/
    ├── architecture-pipeline.svg  # Diagram: frame processing pipeline
    └── player-integration.md      # How to attach the engine to Shaka Player / hls.js / Video.js
```

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- [Rust](https://rustup.rs/) stable
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) —
  `cargo install wasm-pack`

## Getting Started

```bash
npm install
npm run build:wasm   # compiles wasm/ and writes bindings to src/core/wasm/
npm run dev          # starts the Vite dev server (http://localhost:5173)
```

`src/core/wasm/` is generated and gitignored — run `npm run build:wasm`
again after cloning, or after changing anything in `wasm/src/`.

The face-detection model is bundled into the WASM file, so it's a few MB
(around 5MB, ~2MB gzipped) instead of a few KB. That's the trade-off for
running real face detection fully in the browser instead of a much smaller,
cruder color-based guess.

## Scripts

| Command               | Description                                          |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Start the Vite dev server with hot reload              |
| `npm run build`        | Type-check, then build for production into `dist/`     |
| `npm run preview`      | Serve the production build locally                     |
| `npm run build:wasm`   | Rebuild the Rust crate with `wasm-pack`                 |

## How It Works

![Vertix frame processing pipeline: a decoded video frame flows through pane smoothing, cross-dissolve, and canvas draw every rendered frame, while face detection, filtering, debounce, and layout decision run every Nth frame and feed new pane targets back into the smoothing step](docs/architecture-pipeline.svg)

1. `VertixEngine.attach(video, canvas)` starts a render loop driven by
   `requestVideoFrameCallback` — this runs in sync with each decoded video
   frame, on the main thread, so audio and video never drift apart. The
   engine never touches the video's own playback (`.play()`, `.src`,
   `.currentTime`) — it only reads frames and reacts to the element's own
   `play`/`seeking`/`loadedmetadata` events. Whatever's driving playback
   (this app's own controls, or a media framework like Shaka Player) stays
   in full control.
2. Every few frames, a small (320×240) copy of the current frame is drawn
   to a hidden canvas, read back as pixels, and passed into the WASM face
   detector (`ReframeEngine.update_faces`, in `wasm/src/`). This runs the
   UltraFace model, removes overlapping boxes, and returns every detected
   face's position, size, and a couple of extra signals (how much the
   mouth area is moving, the model's own confidence).
3. Detected faces are filtered in `src/core/VertixEngine.ts`: a face has
   to be a reasonable size and mostly inside the frame to count as an
   actual on-camera speaker (this is what keeps a stadium full of distant
   fans from being read as "50 speakers").
4. `src/core/layoutEngine.ts` turns the surviving face count into a
   layout: 0 → no crop; 1 → a single wide, chest-up crop; 2 → stacked
   panes; 3+ → a grid. This only re-runs when the face *count* changes —
   not on every detection tick — and only takes effect once that count has
   held steady for a few ticks, so a single misdetection doesn't flip the
   layout and back.
5. Within a stable layout, each pane's crop position only moves once its
   face has drifted past a small dead zone (ordinary gestures are ignored
   completely), and then glides toward the new position instead of
   snapping.
6. When the layout itself changes, the engine cross-dissolves from the old
   framing into the new one instead of cutting instantly.

## Rebuilding the WASM Module

If you change anything in `wasm/src/`:

```bash
npm run build:wasm
```

This runs `wasm-pack build --target web` and writes the bindings to
`src/core/wasm/`, which Vite bundles like any other asset.

## License

MIT — see [LICENSE](LICENSE). The bundled face-detection model
([UltraFace](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB))
is also MIT-licensed; see
[wasm/src/models/ATTRIBUTION.md](wasm/src/models/ATTRIBUTION.md).
