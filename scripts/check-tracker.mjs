// Browser check for face tracks and layout rules: plays clips through the
// real engine in headless Chrome (9:16, lookahead as the build defaults it)
// once per panel variant, and reports layout changes and subject switches
// per minute, time per rule, track counts, pane swaps, tracker cost, and
// the mouth activity per track. With --aspect it instead plays the
// non-landscape test clips (`npm run make:aspect-clips`) in 9:16 and 16:9
// and checks they are shown whole.
//
// Usage (after `npm run build:wasm && npm run build:worker`):
//   node scripts/check-tracker.mjs [--clips=a.mp4,b.mp4] [--licensed] [--variants=evidence,until-moved]
//                                  [--aspect] [--root=<checkout>] [--label=<name>] [--headed]
//
// --licensed adds the clips listed in .env.local (see scripts/local-clips.mjs);
// they are reported by label only, never by URL. --root runs another
// checkout (for example main in a git worktree, for before/after numbers);
// metrics that checkout does not record are derived from its v5 fields.
// Results go to stdout and .eval/tracker-check-<label>.json (gitignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHROME, runInHeadlessChrome } from "./lib/headless-chrome.mjs";
import { readLocalClips } from "./local-clips.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(option("root") ?? here);
const label = option("label") ?? "current";
const SAMPLE_CLIPS = [
  { name: "1-speaker.mp4", fps: 25 },
  { name: "2-speakers-a.mp4", fps: 25 },
  { name: "2-speakers-b.mp4", fps: 50 },
  { name: "2-speakers-c.mp4", fps: 24000 / 1001 },
  { name: "2-speakers-d.mp4", fps: 30000 / 1001 },
  { name: "3-speakers.mp4", fps: 25 },
];
const wanted = option("clips")?.split(",");
const clips = [
  ...SAMPLE_CLIPS.filter((clip) => !wanted || wanted.includes(clip.name)).map((clip) => ({
    ...clip,
    url: `/samples/${clip.name}`,
    hls: false,
    stopAtSec: null,
  })),
  ...(args.includes("--licensed")
    ? readLocalClips(here)
        .filter((clip) => !wanted || wanted.includes(clip.label))
        .map((clip) => ({
          name: clip.label,
          url: clip.url,
          fps: null,
          hls: true,
          stopAtSec: clip.maxSeconds,
        }))
    : []),
];
const variants = (option("variants") ?? "evidence,until-moved").split(",");

/** Runs in the page: every clip once per panel variant, recording the tracks of every detection. */
async function runInPage(clips, variants) {
  const core = await import("/src/core/index.ts");
  const video = document.createElement("video");
  // Unmuted, so the audio gate sees the clip's audio (headless Chrome autoplays it).
  video.muted = false;
  video.playsInline = true;
  document.body.append(video);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const engine = new core.VertixEngine();
  engine.attach(video, canvas);
  const deadline = performance.now() + 15000;
  while (!engine.getState().wasmReady && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (!engine.getState().wasmReady) throw new Error("WASM never became ready");

  let shakaPlayer = null;
  const load = (clip) => async () => {
    if (!clip.hls) {
      video.src = clip.url;
      void video.play();
      return;
    }
    if (!shakaPlayer) {
      const shaka = (await import("/@id/shaka-player")).default;
      shaka.polyfill.installAll();
      shakaPlayer = new shaka.Player();
      await shakaPlayer.attach(video);
    }
    video.crossOrigin = "anonymous";
    await shakaPlayer
      .load(clip.url)
      .catch((error) => console.error(`[check] ${clip.name} failed to load (Shaka error ${error?.code ?? "?"})`));
    void video.play();
  };

  // Not a BenchmarkRecorder feature: the check collects every track snapshot itself.
  let snapshots = [];
  const setProbe = engine.setBenchmarkProbe.bind(engine);
  engine.setBenchmarkProbe = (probe) => {
    if (probe) {
      probe.recordTrackSnapshot = (t, tracks, subject, rule, shot, largest, cut, displayedRule) =>
        snapshots.push({
          t,
          audioEnergy: engine.getMetrics().audioEnergy,
          rule,
          displayedRule,
          shot,
          largest,
          cut,
          subject,
          tracks: tracks.map((tr) => ({
            id: tr.id,
            cx: tr.cx,
            w: tr.w,
            h: tr.h,
            fg: tr.foreground,
            mouth: tr.mouthActivity,
            lower: tr.lowerFaceMotion,
          })),
        });
    }
    setProbe(probe);
  };

  await core.runUnrecordedWarmup(engine, video, { mode: "9:16", loadSource: load(clips[0]), seconds: 3 });
  const runs = [];
  for (const clip of clips) {
    for (const variant of engine.setPanelVariant ? variants : ["n/a"]) {
      if (engine.setPanelVariant) engine.setPanelVariant(variant);
      console.log(`[check] ${clip.hls ? "local clip" : clip.name}, panel ${variant}`);
      snapshots = [];
      const loadSource = load(clip);
      // Checkouts without stopAtSec support: end the clip by seeking to its end.
      const stopAtEnd = () => {
        if (clip.stopAtSec && video.currentTime >= clip.stopAtSec + 0.5 && Number.isFinite(video.duration)) {
          video.currentTime = video.duration;
        }
      };
      video.addEventListener("timeupdate", stopAtEnd);
      const result = await core.runBenchmarkClip(engine, video, {
        clipName: clip.name,
        mode: "9:16",
        nominalFps: clip.fps,
        warmupSec: 1,
        loadSource: () => void loadSource(),
        stopAtSec: clip.stopAtSec ?? undefined,
        wasmBuild: { ...core.getActiveWasmBuild(), runOrder: null },
      });
      video.removeEventListener("timeupdate", stopAtEnd);
      const { summary, raw } = result;
      runs.push({
        clip: clip.name,
        variant,
        lookahead: result.lookahead.lengthMs,
        measuredSeconds: summary.measuredSeconds,
        layoutChanges: summary.layoutChanges,
        tracking: summary.tracking ?? null,
        detections: {
          t: raw.detections.frameMediaTimeSec,
          resolvedFaces: raw.detections.resolvedFaces,
          resolvedCx: raw.detections.resolvedCx,
          warmup: raw.detections.warmup,
        },
        snapshots,
      });
    }
  }
  engine.destroy();
  return runs;
}

/** Plays each non-landscape clip in 9:16 and 16:9 and reads what the engine shows. */
async function runAspectInPage(clips) {
  const core = await import("/src/core/index.ts");
  const video = document.createElement("video");
  video.muted = true;
  document.body.append(video);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const engine = new core.VertixEngine();
  engine.attach(video, canvas);
  const deadline = performance.now() + 15000;
  while (!engine.getState().wasmReady && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  for (const clip of clips) {
    for (const mode of ["9:16", "16:9"]) {
      engine.setMode(mode);
      video.src = clip;
      await video.play();
      const frameMetadata = await new Promise((resolve) => video.requestVideoFrameCallback((_, m) => resolve(m)));
      await sleep(2500);
      const state = engine.getState();
      const metrics = engine.getMetrics();
      const ctx = canvas.getContext("2d");
      const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      const shown = { w: canvas.width, h: canvas.height };
      const scale = Math.min(shown.w / video.videoWidth, shown.h / video.videoHeight);
      const fitted = { w: Math.round(video.videoWidth * scale), h: Math.round(video.videoHeight * scale) };
      results.push({
        clip: clip.split("/").pop(),
        mode,
        videoSize: `${video.videoWidth}x${video.videoHeight}`,
        frameMetadataSize: `${frameMetadata.width}x${frameMetadata.height}`,
        sourceShownAsIs: state.sourceShownAsIs,
        canvas: `${shown.w}x${shown.h}`,
        canvasAspect: Math.round((shown.w / shown.h) * 1000) / 1000,
        pictureInCanvas: `${fitted.w}x${fitted.h}`,
        barPixel: fitted.w < shown.w ? pixel(2, shown.h / 2) : fitted.h < shown.h ? pixel(shown.w / 2, 2) : null,
        speakerCount: state.speakerCount,
        detectionRateHz: metrics.detectionRateHz,
        lookahead: metrics.lookahead.bypassed ? "bypassed" : `${metrics.lookahead.lengthMs} ms`,
      });
      video.pause();
    }
  }
  engine.destroy();
  return results;
}

const RULES = ["broll", "single", "stacked", "subject", "group", "grid"];

/** v5 checkouts: rule from the resolved face count, subject switches from jumps of the single face. */
function derivedTracking(run) {
  const { t, resolvedFaces, resolvedCx, warmup } = run.detections;
  const timeMs = Object.fromEntries(RULES.map((rule) => [rule, 0]));
  let switches = 0;
  let total = 0;
  for (let i = 0; i + 1 < t.length; i++) {
    if (warmup[i]) continue;
    const dt = t[i + 1] - t[i];
    const n = resolvedFaces[i];
    timeMs[n === 0 ? "broll" : n === 1 ? "single" : n === 2 ? "stacked" : "grid"] += dt;
    total += dt;
    if (n === 1 && resolvedFaces[i + 1] === 1 && Math.abs(resolvedCx[i + 1] - resolvedCx[i]) >= 0.15) switches += 1;
  }
  const minutes = run.measuredSeconds / 60;
  return {
    layoutChangesPerMin: run.layoutChanges / minutes,
    subjectSwitchesPerMin: switches / minutes,
    timeInRulePct: Object.fromEntries(RULES.map((rule) => [rule, total > 0 ? (timeMs[rule] / total) * 100 : 0])),
    paneSwaps: null,
    leftToRightFlips: null,
    foregroundTracks: { mean: null },
    backgroundTracks: { mean: null },
    trackerMs: { p50: null, p95: null },
  };
}

/** Mean mouth activity and lower-face change per track (visible, foreground), sorted by track ID. */
function mouthPerTrack(run) {
  const byId = new Map();
  for (const snapshot of run.snapshots) {
    for (const track of snapshot.tracks) {
      if (!track.fg) continue;
      const entry = byId.get(track.id) ?? { id: track.id, cx: 0, mouth: 0, lower: 0, n: 0, subjectN: 0 };
      entry.cx += track.cx;
      entry.mouth += track.mouth;
      entry.lower += track.lower;
      entry.n += 1;
      if (snapshot.subject === track.id) entry.subjectN += 1;
      byId.set(track.id, entry);
    }
  }
  return [...byId.values()]
    .filter((e) => e.n >= 10)
    .map((e) => ({
      track: e.id,
      "mean cx": (e.cx / e.n).toFixed(2),
      detections: e.n,
      "as subject": e.subjectN,
      "mouth activity (new)": (e.mouth / e.n).toFixed(2),
      "lower-face change (old)": (e.lower / e.n).toFixed(2),
    }));
}

const fixed = (value, digits = 1) => (value === null || value === undefined ? "-" : value.toFixed(digits));

try {
  if (args.includes("--aspect")) {
    const results = await runInHeadlessChrome({
      root,
      pageFunction: runAspectInPage,
      args: [["/bench/aspect-portrait.mp4", "/bench/aspect-square.mp4", "/bench/aspect-rotated.mp4"]],
      chromePath: option("chrome") ?? DEFAULT_CHROME,
      headed: args.includes("--headed"),
    });
    console.table(results);
    mkdirSync(join(here, ".eval"), { recursive: true });
    writeFileSync(join(here, ".eval/aspect-check.json"), JSON.stringify(results, null, 2));
  } else {
    const runs = await runInHeadlessChrome({
      root,
      pageFunction: runInPage,
      args: [clips, variants],
      chromePath: option("chrome") ?? DEFAULT_CHROME,
      headed: args.includes("--headed"),
      timeoutMs: 60 * 60 * 1000,
    });
    const rows = runs.map((run) => {
      const tracking = run.tracking ?? derivedTracking(run);
      return {
        clip: run.clip,
        panel: run.variant,
        "layout changes / min": fixed(tracking.layoutChangesPerMin),
        "subject switches / min": fixed(tracking.subjectSwitchesPerMin),
        "time per rule %": Object.entries(tracking.timeInRulePct)
          .filter(([, pct]) => pct >= 0.5)
          .map(([rule, pct]) => `${rule} ${pct.toFixed(0)}`)
          .join(", "),
        "fg / bg tracks": `${fixed(tracking.foregroundTracks.mean)} / ${fixed(tracking.backgroundTracks.mean)}`,
        "pane swaps": tracking.paneSwaps ?? "-",
        "left-right flips": tracking.leftToRightFlips ?? "-",
        "tracker p50 / p95 ms": `${fixed(tracking.trackerMs.p50, 3)} / ${fixed(tracking.trackerMs.p95, 3)}`,
      };
    });
    console.table(rows);
    for (const run of runs.filter((r) => r.snapshots.length > 0 && r.variant === runs[0].variant)) {
      console.log(`Mouth activity per foreground track, ${run.clip}:`);
      console.table(mouthPerTrack(run));
    }
    mkdirSync(join(here, ".eval"), { recursive: true });
    writeFileSync(
      join(here, `.eval/tracker-check-${label}.json`),
      JSON.stringify({ checkedAt: new Date().toISOString(), rows, runs }, null, 2)
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.exit();
}
