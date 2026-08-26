> **This is now live in the app, not just a hypothetical.** `src/hooks/useWasmReframe.ts`
> is the real reference implementation of the pattern documented below: it owns a
> `shaka.Player` instance, calls `player.attach(video)` / `player.load(src)` for every
> source this app supports (local file via `URL.createObjectURL`, direct progressive
> URLs — MP4, WebM, Ogg — and adaptive HLS/DASH stream URLs), and hands the same
> `<video>` element to `VertixEngine.attach()` — unmodified from how it works below.
> The worked example still applies as-is; the only additions in the real hook are
> app-level bookkeeping Shaka doesn't provide itself: mapping `shaka.util.Error` to
> user-facing messages, an explicit `mimeType` hint on `load()` (skips Shaka's own
> content-type sniffing, which fails for plain progressive files in practice), polling
> `getStats()` / `getBufferedInfo()` for a `StreamHealth` readout, and revoking the
> previous blob URL on each new `load()` to avoid leaking object URLs.

# Attaching `VertixEngine` to an external media framework

`VertixEngine` (see `src/core/`) never sets `.src` on a video element, never
calls `.play()`/`.pause()`, and never sets `.currentTime`. It only *reads*
decoded frames (`requestVideoFrameCallback`) and *listens* to the element's
own `play`/`seeking`/`loadedmetadata` events. It doesn't even need a
`pause` listener; the render loop just notices `video.paused` on its own
and stops rescheduling itself. So it never competes with whatever already
owns playback, and can attach to a video element that a media framework
like Shaka Player, hls.js, or Video.js is independently driving, with no
coordination needed beyond "here's the element and canvas".

The worked example below uses Shaka Player because it's the most involved
case (adaptive bitrate, `MediaSource`, its own async `load()`) — the same
`attach(video, canvas)` call is the entire integration surface for any of
them. See [hls.js / Video.js / a plain `<video src>`](#hlsjs--videojs--a-plain-video-src)
at the bottom for confirmation that nothing about the pattern changes.

## Worked example: Shaka Player

```ts
import shaka from "shaka-player"; // this app's real import — see useWasmReframe.ts
import { VertixEngine } from "@vertix/core"; // or "../core" inside this repo

const video = document.querySelector("video")!;
const canvas = document.querySelector("canvas")!;

// Shaka owns playback: it attaches MediaSource, manages adaptive
// bitrate, etc. Vertix doesn't need to know any of this is happening.
const player = new shaka.Player();
await player.attach(video);
await player.load("https://example.com/stream.mpd");

// Vertix only needs the same two DOM elements. Order relative to the
// player.load() call above doesn't matter.
const engine = new VertixEngine();
engine.attach(video, canvas);
engine.setMode("9:16");

engine.onMetricsUpdate((metrics) => {
  console.log(`fps: ${metrics.fps.toFixed(1)}`);
});

// Standard <video> API controls playback, same as with a plain file — the
// engine reacts to these events on its own, no engine.play()/seek() calls
// needed:
video.play();
video.currentTime = 30; // engine hears "seeking" and resets its tracking state

// Tear down in the reverse order: stop Vertix first, then Shaka.
// engine.detach();
// await player.destroy();
```

## The one real gotcha: cross-origin video and canvas readback

Vertix reads pixels off the video via `ctx.getImageData()` (for face
detection) and `canvas.drawImage(video, ...)` (for the actual reframed
output). If the video's underlying segments are cross-origin and don't
serve CORS headers, the browser marks the `<canvas>` "tainted" and
`getImageData()` throws a `SecurityError` — Vertix will fail loudly the
first time it tries to detect a face.

Fix: the host must mark the video element (and Shaka, hls.js, etc. must be
configured to actually respect it) as CORS-enabled *before* it starts
loading segments:

```ts
video.crossOrigin = "anonymous";
```

...and the origin serving the video/manifest/segments must return
`Access-Control-Allow-Origin` for your page's origin. This is entirely a
concern for whichever media framework is loading the content — Vertix
itself has no CORS configuration of its own, it just inherits whether the
canvas is tainted.

## hls.js / Video.js / a plain `<video src>`

Identical pattern — those also just end up with a regular
`HTMLVideoElement` that Vertix can `attach()` to. The only thing that
changes across players is how *they* get bytes into the element; from
Vertix's side, `attach(video, canvas)` is the whole integration surface
regardless of which one is driving playback.
