// Browser check for lookahead: plays the cut test clips (and 3-speakers.mp4,
// for the active-speaker comparison) through the real engine in headless
// Chrome, once with lookahead off and once on, and reports for every known
// cut how many displayed frames the crop changed after the source cut.
//
// Starts its own Vite dev server and drives the engine directly (imported
// from /src/core), not the app UI. Results go to stdout and
// .eval/lookahead-check.json (gitignored).
//
// Usage (after `npm run build:wasm && npm run build:worker` and
// `npm run make:bench-clips`):
//   node scripts/check-lookahead.mjs [--only=<clip file>] [--chrome=/path/to/chrome] [--headed]
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
const DEBUG_PORT = 9333;
const CLIP_TIMEOUT_MS = 10 * 60 * 1000;

const ONLY = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const ALL_CLIPS = [
  { file: "cross-count.mp4", url: "/bench/cross-count.mp4", knownCutsSec: [4, 8, 12] },
  { file: "cross-same-count.mp4", url: "/bench/cross-same-count.mp4", knownCutsSec: [4, 8, 12] },
  { file: "cross-offset.mp4", url: "/bench/cross-offset.mp4", knownCutsSec: [4.08, 8.12, 12.16] },
  { file: "3-speakers.mp4", url: "/samples/3-speakers.mp4", knownCutsSec: [] },
];
const CLIPS = ONLY ? ALL_CLIPS.filter((clip) => clip.file === ONLY) : ALL_CLIPS;

// Runs in the page: plays every clip with lookahead off, then on.
async function runInPage(clips) {
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
  console.log("[check] wasm ready, warming up");
  await core.runUnrecordedWarmup(engine, video, { mode: "9:16", loadSource: load(clips[0].url), seconds: 3 });

  const runs = [];
  for (const clip of clips) {
    for (const lookahead of [false, true]) {
      console.log(`[check] ${clip.file}, lookahead ${lookahead ? "on" : "off"}`);
      const result = await core.runBenchmarkClip(engine, video, {
        clipName: clip.file,
        mode: "9:16",
        nominalFps: 25,
        warmupSec: 1,
        knownCutsSec: clip.knownCutsSec,
        lookahead,
        loadSource: load(clip.url),
        wasmBuild: { ...core.getActiveWasmBuild(), runOrder: null },
      });
      const { summary, raw } = result;
      runs.push({
        clip: clip.file,
        lookahead: result.lookahead,
        knownCuts: summary.knownCuts,
        cutsShown: summary.cutsShown,
        sceneCuts: summary.sceneCuts,
        displayErrorMs: summary.display.errorMs,
        displayed: summary.display.count,
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
    }
  }
  engine.destroy();
  return runs;
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
  await cdp.send("Page.enable");
  const loaded = new Promise((resolve) =>
    cdp.listeners.push((msg) => msg.method === "Page.loadEventFired" && resolve())
  );
  await cdp.send("Page.navigate", { url: appUrl });
  await loaded;

  const evaluation = cdp.send("Runtime.evaluate", {
    expression: `(${runInPage.toString()})(${JSON.stringify(CLIPS)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("check timed out")), CLIP_TIMEOUT_MS));
  const result = await Promise.race([evaluation, timeout]);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "page error");
  const runs = result.result.value;

  const rows = [];
  for (const run of runs) {
    for (const cut of run.knownCuts) {
      rows.push({
        clip: run.clip,
        lookahead: run.lookahead.enabled ? `${run.lookahead.lengthMs} ms` : "off",
        "cut s": cut.timeSec,
        "frames late": cut.framesLate ?? "missed",
        "crop changed at s": cut.shownMediaTimeSec,
        "found by": cut.source ?? "-",
      });
    }
  }
  console.table(rows);
  console.table(
    runs.map((run) => ({
      clip: run.clip,
      lookahead: !run.lookahead.enabled ? "off" : (run.lookahead.unavailableReason ?? `${run.lookahead.lengthMs} ms`),
      slot: run.lookahead.slotWidth ? `${run.lookahead.slotWidth}x${run.lookahead.slotHeight}` : "-",
      "buffer MB": Math.round((run.lookahead.bufferBytes / 1048576) * 10) / 10,
      "buffer drops": run.lookahead.droppedFrames,
      "dropped (est.)": run.frames.droppedFramesEstimate,
      "display err p50/p95 ms":
        run.displayErrorMs.count > 0
          ? `${run.displayErrorMs.p50.toFixed(1)}/${run.displayErrorMs.p95.toFixed(1)}`
          : "-",
      "trigger p95 ms": run.trigger.mainThreadMs.p95?.toFixed(3) ?? "-",
      "triggered detections": run.trigger.triggeredDetections,
      "irregular gaps": `${run.detectionGaps.irregular}/${run.detectionGaps.pairs}`,
      "detect p95 ms": run.detectionTotalMs.p95?.toFixed(1) ?? "-",
    }))
  );
  const speakers = runs.filter((run) => run.clip === "3-speakers.mp4");
  const agreement = speakers.length === 2 ? activeSpeakerAgreement(speakers[0], speakers[1]) : null;
  if (agreement) {
    console.log(
      `3-speakers.mp4 active speaker, off vs on: same in ${agreement.same}/${agreement.total} steps of 0.2 s`
    );
  }

  mkdirSync(join(root, ".eval"), { recursive: true });
  writeFileSync(
    join(root, ".eval/lookahead-check.json"),
    JSON.stringify({ checkedAt: new Date().toISOString(), runs, activeSpeakerAgreement: agreement }, null, 2)
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
