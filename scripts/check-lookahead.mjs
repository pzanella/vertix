// Browser check for lookahead: plays the cut test clips, 3-speakers.mp4
// (active-speaker comparison) and 2-speakers-b.mp4 (50 fps) through the
// real engine in headless Chrome, once with lookahead off and once on, and
// reports for every known cut how many displayed frames the crop changed
// after the source cut, plus the lookahead length of every run. Without
// --only it also checks the length after build switches, the 16:9 bypass
// and the 16:9 -> 9:16 switch.
//
// Starts its own Vite dev server and drives the engine directly (imported
// from /src/core), not the app UI. Results go to stdout and
// .eval/lookahead-check.json (gitignored).
//
// Usage (after `npm run build:wasm && npm run build:worker` and
// `npm run make:bench-clips`):
//   node scripts/check-lookahead.mjs [--only=<clip file>] [--chrome=/path/to/chrome] [--headed] [--cpu-throttle=<rate>] [--trigger-ab]
//
// --cpu-throttle slows the page's CPU by that factor (DevTools CPU
// throttling), a rough stand-in for a phone. 50 fps clips also run with
// lookahead on the scalar build. --trigger-ab adds, per clip, a run with
// lookahead on and VideoFrame hidden, so the cut trigger takes its bitmap
// path (labelled "bitmap trigger").
//
// Timings in headless Chrome are not representative of a real device; the
// frame counts are what this checks.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const chromePath =
  args.find((arg) => arg.startsWith("--chrome="))?.slice("--chrome=".length) ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const headed = args.includes("--headed");
const triggerAb = args.includes("--trigger-ab");
const cpuThrottle = Number(args.find((arg) => arg.startsWith("--cpu-throttle="))?.slice("--cpu-throttle=".length) ?? 1);
const DEBUG_PORT = 9333;
const CLIP_TIMEOUT_MS = 10 * 60 * 1000;

const ONLY = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const ALL_CLIPS = [
  { file: "cross-count.mp4", url: "/bench/cross-count.mp4", fps: 25, knownCutsSec: [4, 8, 12] },
  { file: "cross-same-count.mp4", url: "/bench/cross-same-count.mp4", fps: 25, knownCutsSec: [4, 8, 12] },
  { file: "cross-offset.mp4", url: "/bench/cross-offset.mp4", fps: 25, knownCutsSec: [4.08, 8.12, 12.16] },
  { file: "3-speakers.mp4", url: "/samples/3-speakers.mp4", fps: 25, knownCutsSec: [] },
  { file: "2-speakers-b.mp4", url: "/samples/2-speakers-b.mp4", fps: 50, knownCutsSec: [] },
];
const CLIPS = ONLY ? ALL_CLIPS.filter((clip) => clip.file === ONLY) : ALL_CLIPS;

/**
 * Runs in the page:
 * - every clip with lookahead off, then on (the build the page picks);
 * - the suite's build switches on cross-offset.mp4 (a fresh worker each
 *   time), to check the lookahead length is not inflated by warm-up;
 * - one 16:9 run (lookahead must be bypassed);
 * - a 16:9 -> 9:16 switch per build, timed.
 */
async function runInPage(clips, extras, triggerAb) {
  const core = await import("/src/core/index.ts");
  const video = document.createElement("video");
  video.muted = false;
  video.playsInline = true;
  document.body.append(video);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const engine = new core.VertixEngine();
  engine.attach(video, canvas);
  console.log("[check] engine attached");
  const deadline = performance.now() + 15000;
  while (!engine.getState().wasmReady && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (!engine.getState().wasmReady) throw new Error("WASM never became ready");

  const load = (url) => () => {
    video.src = url;
    void video.play();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log("[check] wasm ready, warming up");
  await core.runUnrecordedWarmup(engine, video, { mode: "9:16", loadSource: load(clips[0].url), seconds: 3 });

  const runs = [];
  const run = async (clip, lookahead, label, mode = "9:16") => {
    console.log(`[check] ${label}: ${clip.file}, ${mode}, lookahead ${lookahead ? "on" : "off"}`);
    const result = await core.runBenchmarkClip(engine, video, {
      clipName: clip.file,
      mode,
      nominalFps: clip.fps,
      warmupSec: 1,
      knownCutsSec: clip.knownCutsSec,
      lookahead,
      loadSource: load(clip.url),
      wasmBuild: { ...core.getActiveWasmBuild(), runOrder: null },
    });
    const { summary, raw } = result;
    runs.push({
      label,
      clip: clip.file,
      mode,
      build: core.getActiveWasmBuild().variant,
      lookahead: result.lookahead,
      knownCuts: summary.knownCuts,
      cutsShown: summary.cutsShown,
      sceneCuts: summary.sceneCuts,
      displayErrorMs: summary.display.errorMs,
      clockErrorMs: summary.display.clockErrorMs,
      clockErrorAbsMs: summary.display.clockErrorAbsMs,
      frameOffset: summary.display.frameOffset,
      displayed: summary.display.count,
      effectiveFps: summary.effectiveFps,
      frames: summary.frames,
      trigger: summary.trigger,
      detectionGaps: summary.detectionGaps,
      detectionTotalMs: summary.detection.totalMs,
      detections: {
        frameMediaTimeSec: raw.detections.frameMediaTimeSec,
        resolvedFaces: raw.detections.resolvedFaces,
        resolvedCx: raw.detections.resolvedCx,
        triggered: raw.detections.triggered,
      },
    });
  };

  for (const clip of clips) {
    await run(clip, false, "clips");
    await run(clip, true, "clips");
    if (triggerAb) {
      const videoFrame = globalThis.VideoFrame;
      globalThis.VideoFrame = undefined;
      await run(clip, true, "bitmap trigger");
      globalThis.VideoFrame = videoFrame;
    }
    if (clip.fps > 30) {
      const pageBuild = core.getActiveWasmBuild();
      const other = pageBuild.variant === "simd" ? "scalar" : "simd";
      await core.switchWasmBuild({ variant: other, reason: "benchmark-suite" });
      await core.runUnrecordedWarmup(engine, video, {
        mode: "9:16",
        lookahead: true,
        loadSource: load(clip.url),
        seconds: 3,
      });
      await run(clip, true, "clips");
      await core.switchWasmBuild(pageBuild);
    }
  }

  const modeSwitches = [];
  if (extras) {
    const offset = clips.find((c) => c.file === "cross-offset.mp4") ?? clips[0];
    for (const variant of ["scalar", "simd"]) {
      await core.switchWasmBuild({ variant, reason: "benchmark-suite" });
      await core.runUnrecordedWarmup(engine, video, {
        mode: "9:16",
        lookahead: true,
        loadSource: load(offset.url),
        seconds: 3,
      });
      await run(offset, true, `after switch to ${variant}`);
    }
    await run(clips[0], true, "16:9", "16:9");

    for (const variant of ["simd", "scalar"]) {
      await core.switchWasmBuild({ variant, reason: "benchmark-suite" });
      engine.setMode("9:16");
      engine.setLookaheadEnabled(true);
      video.src = "/samples/1-speaker.mp4";
      await video.play();
      await sleep(8000);
      engine.setMode("16:9");
      await sleep(1500);
      const { lengthMs, delayFrames, lengthSource } = engine.getLookaheadStatus();
      const switchedAt = performance.now();
      engine.setMode("9:16");
      const anchorSec = engine.getDisplayedMediaTime();
      const status = engine.getLookaheadStatus();
      let croppedMs = null;
      let resumedMs = null;
      while (performance.now() - switchedAt < 2000 && (croppedMs === null || resumedMs === null)) {
        await new Promise((r) => requestAnimationFrame(r));
        const elapsed = performance.now() - switchedAt;
        if (croppedMs === null && engine.getState().speakerCount > 0) croppedMs = elapsed;
        if (resumedMs === null && engine.getDisplayedMediaTime() > anchorSec) resumedMs = elapsed;
      }
      video.pause();
      modeSwitches.push({
        build: variant,
        lengthMs: status.lengthMs,
        delayFrames: status.delayFrames,
        lengthSource: status.lengthSource,
        lengthIn16x9: { lengthMs, delayFrames, lengthSource },
        firstFrameMs: 0,
        croppedMs,
        resumedMs,
      });
    }
  }
  engine.destroy();
  return { runs, modeSwitches };
}

/** Share of 0.2 s steps where both runs show the same speaker count and (for one face) the same person. */
function activeSpeakerAgreement(off, on) {
  const at = (run, t) => {
    let index = -1;
    run.detections.frameMediaTimeSec.forEach((ft, i) => {
      if (ft <= t + 1e-4 && (index < 0 || ft >= run.detections.frameMediaTimeSec[index])) index = i;
    });
    return index < 0 ? null : { count: run.detections.resolvedFaces[index], cx: run.detections.resolvedCx[index] };
  };
  let same = 0;
  let total = 0;
  for (let t = 1; t < 11.5; t += 0.2) {
    const a = at(off, t);
    const b = at(on, t);
    if (!a || !b) continue;
    total += 1;
    const sameCount = a.count === b.count;
    const samePerson = a.count !== 1 || Math.abs(a.cx - b.cx) < 0.08;
    if (sameCount && samePerson) same += 1;
  }
  return { same, total };
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const listener of this.listeners) listener(msg);
      }
    };
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function pageTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome did not open a debugging port");
}

const server = await createServer({ root, logLevel: "error", server: { port: 0 } });
await server.listen();
const appUrl = server.resolvedUrls.local[0];
const profileDir = mkdtempSync(join(tmpdir(), "vertix-check-"));
const chrome = spawn(
  chromePath,
  [
    ...(headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" }
);

try {
  const cdp = new Cdp(await pageTarget());
  await cdp.open();
  cdp.listeners.push((msg) => {
    if (msg.method === "Runtime.exceptionThrown") console.error("[page]", msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description).join(" ");
      if (msg.params.type === "error") console.error("[page]", text);
      else if (text.startsWith("[check]")) console.log(new Date().toISOString().slice(11, 19), text);
    }
  });
  await cdp.send("Runtime.enable");
  if (cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
  await cdp.send("Page.enable");
  const loaded = new Promise((resolve) =>
    cdp.listeners.push((msg) => msg.method === "Page.loadEventFired" && resolve())
  );
  await cdp.send("Page.navigate", { url: appUrl });
  await loaded;

  const evaluation = cdp.send("Runtime.evaluate", {
    expression: `(${runInPage.toString()})(${JSON.stringify(CLIPS)}, ${JSON.stringify(!ONLY)}, ${JSON.stringify(triggerAb)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("check timed out")), CLIP_TIMEOUT_MS));
  const result = await Promise.race([evaluation, timeout]);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "page error");
  const { runs, modeSwitches } = result.result.value;
  const lookaheadLabel = (l) =>
    !l.enabled ? "off" : (l.unavailableReason ?? (l.bypassed ? "bypassed" : `${l.lengthMs} ms (${l.delayFrames} f)`));

  const rows = [];
  for (const run of runs.filter((r) => r.label === "clips")) {
    for (const cut of run.knownCuts) {
      rows.push({
        clip: run.clip,
        lookahead: lookaheadLabel(run.lookahead),
        "cut s": cut.timeSec,
        "frames late": cut.framesLate ?? "missed",
        "crop changed at s": cut.shownMediaTimeSec,
        "found by": cut.source ?? "-",
      });
    }
  }
  if (cpuThrottle > 1) console.log(`CPU throttled ${cpuThrottle}x`);
  console.table(rows);
  console.table(
    runs.map((run) => ({
      run: run.label,
      clip: run.clip,
      mode: run.mode,
      build: run.build,
      lookahead: lookaheadLabel(run.lookahead),
      "L source": run.lookahead.lengthSource,
      "audio delay ms": run.lookahead.audioDelayMs,
      slot: run.lookahead.slotWidth ? `${run.lookahead.slotWidth}x${run.lookahead.slotHeight}` : "-",
      "slots / MB": `${run.lookahead.allocatedSlots} / ${Math.round((run.lookahead.bufferBytes / 1048576) * 10) / 10}`,
      "overflow / skipped": `${run.lookahead.overflowDrops} / ${run.lookahead.skippedOnDisplay}`,
      "ms at slot height": Object.entries(run.lookahead.timeAtSlotHeightMs ?? {})
        .map(([height, ms]) => `${height}: ${Math.round(ms)}`)
        .join(", "),
      fps: run.effectiveFps?.toFixed(1) ?? "-",
      "dropped (playback quality)": `${run.frames.playbackQualityDroppedFrames}/${run.frames.playbackQualityTotalFrames}`,
      "display err p50/p95 ms":
        run.displayErrorMs.count > 0
          ? `${run.displayErrorMs.p50.toFixed(1)}/${run.displayErrorMs.p95.toFixed(1)}`
          : "-",
      "clock err p95 / |p95| ms":
        run.clockErrorMs.count > 0 ? `${run.clockErrorMs.p95.toFixed(1)} / ${run.clockErrorAbsMs.p95.toFixed(1)}` : "-",
      "frame offset p95": run.frameOffset.count > 0 ? run.frameOffset.p95.toFixed(2) : "-",
      "trigger path": run.trigger.path ?? "-",
      "trigger p95 ms (draw / post)":
        run.trigger.mainThreadMs.p95 === null
          ? "-"
          : `${run.trigger.mainThreadMs.p95.toFixed(2)} (${run.trigger.drawMs.p95.toFixed(2)} / ${run.trigger.postMs.p95.toFixed(2)})`,
      "trigger skipped busy": run.trigger.skippedBusy ?? "-",
      "triggered detections": run.trigger.triggeredDetections,
      "irregular gaps": `${run.detectionGaps.irregular}/${run.detectionGaps.pairs}`,
      "detect p95 ms": run.detectionTotalMs.p95?.toFixed(1) ?? "-",
    }))
  );
  if (modeSwitches.length > 0) {
    console.log("16:9 -> 9:16 switch (ms after the switch):");
    console.table(
      modeSwitches.map((m) => ({
        build: m.build,
        L: `${m.lengthMs} ms (${m.delayFrames} f, ${m.lengthSource})`,
        "9:16 frame shown": m.firstFrameMs,
        "shown cropped": m.croppedMs === null ? "no" : Math.round(m.croppedMs),
        "picture moves again": m.resumedMs === null ? "no" : Math.round(m.resumedMs),
        "audio silent": m.lengthMs + 30,
      }))
    );
  }
  const speakers = runs.filter((run) => run.clip === "3-speakers.mp4" && run.label === "clips");
  const agreement = speakers.length === 2 ? activeSpeakerAgreement(speakers[0], speakers[1]) : null;
  if (agreement) {
    console.log(
      `3-speakers.mp4 active speaker, off vs on: same in ${agreement.same}/${agreement.total} steps of 0.2 s`
    );
  }

  mkdirSync(join(root, ".eval"), { recursive: true });
  writeFileSync(
    join(root, ".eval/lookahead-check.json"),
    JSON.stringify(
      { checkedAt: new Date().toISOString(), cpuThrottle, runs, modeSwitches, activeSpeakerAgreement: agreement },
      null,
      2
    )
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  chrome.kill();
  // Vite's close() waits for the page's HMR socket, which a killed Chrome
  // may never close: don't wait for it.
  await Promise.race([server.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  rmSync(profileDir, { recursive: true, force: true });
  process.exit();
}
