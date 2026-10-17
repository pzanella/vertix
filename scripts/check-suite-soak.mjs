// Soak check for the benchmark suite: plays the in-app suite (the same
// steps as useBenchmark's runSuite, sample and test clips, sources loaded
// through Shaka like the app) several times in a row in headless Chrome,
// and records at every step: live workers (counted in the page by wrapping
// Worker), performance.memory, the engine's resource snapshot when the
// checkout has one (getResourceStats: WASM memory, buffers, tracks), and
// the resident memory of Chrome's processes (sampled from Node). Failures
// are recorded with their step, and the suite goes on with the next step.
//
// Usage (after `npm run build:wasm && npm run build:worker` and
// `npm run make:bench-clips`):
//   node scripts/check-suite-soak.mjs [--rounds=3] [--cpu-throttle=4] [--max-steps=<n>] [--root=<checkout>]
//                                     [--label=<name>] [--headed]
//
// --root runs another checkout (e.g. main in a git worktree) with this script.
// Results go to stdout and .eval/suite-soak-<label>.json (gitignored).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHROME, runInHeadlessChrome } from "./lib/headless-chrome.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(option("root") ?? here);
const label = option("label") ?? "current";
const rounds = Number(option("rounds") ?? 3);
const cpuThrottle = Number(option("cpu-throttle") ?? 4);
const maxSteps = Number(option("max-steps") ?? Infinity);

/** Runs in the page: the suite `rounds` times, one record per step. */
async function runInPage(rounds, maxSteps) {
  const live = { created: 0, live: 0 };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...workerArgs) {
      super(...workerArgs);
      live.created += 1;
      live.live += 1;
      this.terminated = false;
    }
    terminate() {
      if (!this.terminated) live.live -= 1;
      this.terminated = true;
      super.terminate();
    }
  };

  const core = await import("/src/core/index.ts");
  const { BENCHMARK_CLIPS } = await import("/src/components/Player/sampleClips.ts");
  const { DEFAULT_BENCHMARK_CONFIG, SETTLE_BETWEEN_CLIPS_MS, baselineClipIndices } =
    await import("/src/components/Benchmark/benchmarkConfig.ts");
  const shaka = (await import("/@id/shaka-player")).default;
  shaka.polyfill.installAll();

  const clips = BENCHMARK_CLIPS.filter((clip) => !clip.file.startsWith("local-"));
  const config = DEFAULT_BENCHMARK_CONFIG;
  const video = document.createElement("video");
  video.muted = false;
  video.playsInline = true;
  document.body.append(video);
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const engine = new core.VertixEngine();
  engine.attach(video, canvas);
  const player = new shaka.Player();
  await player.attach(video);
  const deadline = performance.now() + 15000;
  while (!engine.getState().wasmReady && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));

  const load = (url) => () => {
    void player
      .load(url, null, "video/mp4")
      .then(() => video.play())
      .catch((error) => console.error(`[check] load failed: ${error?.code ?? error}`));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const heap = () =>
    performance.memory
      ? { usedMB: performance.memory.usedJSHeapSize / 1048576, totalMB: performance.memory.totalJSHeapSize / 1048576 }
      : null;
  const engineStats = async () => (engine.getResourceStats ? await engine.getResourceStats().catch(() => null) : null);

  const records = [];
  for (let round = 1; round <= rounds; round++) {
    const steps = core
      .buildSuitePlan(clips.length, baselineClipIndices(config), core.isWasmSimdSupported())
      .slice(0, maxSteps ?? undefined);
    for (const [index, step] of steps.entries()) {
      const clip = clips[step.clipIndex];
      const record = {
        round,
        index,
        kind: step.kind,
        clip: clip.file,
        build: step.kind === "baseline" ? core.getActiveWasmBuild().variant : step.build.variant,
        lookahead: step.kind === "clip" ? step.lookahead : null,
        startedAtEpochMs: Date.now(),
        workersAtStart: { ...live },
        heapAtStart: heap(),
        statsAtStart: await engineStats(),
        detections: null,
        detectionMode: null,
        failure: null,
      };
      console.log(`[check] round ${round} step ${index + 1}/${steps.length} ${step.kind} ${clip.file} ${record.build}`);
      try {
        if (step.kind === "warmup") {
          await core.switchWasmBuild(step.build);
          await core.runUnrecordedWarmup(engine, video, {
            mode: "9:16",
            lookahead: true,
            loadSource: load(clip.url),
            seconds: config.wasmWarmupSec,
          });
        } else {
          await sleep(SETTLE_BETWEEN_CLIPS_MS);
          const reframed = step.kind === "clip";
          const result = await core.runBenchmarkClip(engine, video, {
            clipName: clip.file,
            mode: reframed ? "9:16" : "16:9",
            nominalFps: clip.nominalFps,
            knownCutsSec: clip.knownCutsSec,
            warmupSec: config.clipWarmupSec,
            lookahead: reframed ? step.lookahead : true,
            loadSource: load(clip.url),
            wasmBuild: reframed ? step.build : { ...core.getActiveWasmBuild(), runOrder: null },
          });
          record.detections = result.summary.detection.count;
          record.detectionMode =
            result.summary.detection.workerCount > 0
              ? "worker"
              : result.summary.detection.mainThreadCount > 0
                ? "main-thread"
                : null;
        }
      } catch (error) {
        record.failure = {
          name: error?.name,
          message: error?.message ?? String(error),
          failure: error?.failure ?? null,
        };
        console.error(`[check] step failed: ${record.failure.message}`);
      }
      record.endedAtEpochMs = Date.now();
      record.workersAtEnd = { ...live };
      record.statsAtEnd = await engineStats();
      records.push(record);
    }
  }
  engine.destroy();
  return records;
}

/** Resident memory (MB) of the Chrome processes using this check's profile. */
function chromeRssMb() {
  try {
    const lines = execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .split("\n")
      .filter((line) => line.includes("vertix-check-"));
    let renderer = 0;
    let gpu = 0;
    let total = 0;
    for (const line of lines) {
      const kb = Number(line.trim().split(/\s+/, 1)[0]);
      if (!Number.isFinite(kb)) continue;
      total += kb;
      if (line.includes("--type=renderer")) renderer += kb;
      if (line.includes("--type=gpu-process")) gpu += kb;
    }
    return { totalMB: total / 1024, rendererMB: renderer / 1024, gpuMB: gpu / 1024 };
  } catch {
    return null;
  }
}

const rssSamples = [];
const sampler = setInterval(() => rssSamples.push({ atEpochMs: Date.now(), ...chromeRssMb() }), 2000);

const mb = (bytes) => (bytes === null || bytes === undefined ? "-" : (bytes / 1048576).toFixed(1));
try {
  const records = await runInHeadlessChrome({
    root,
    pageFunction: runInPage,
    args: [rounds, Number.isFinite(maxSteps) ? maxSteps : null],
    chromePath: option("chrome") ?? DEFAULT_CHROME,
    headed: args.includes("--headed"),
    cpuThrottle,
    timeoutMs: 4 * 60 * 60 * 1000,
  });
  clearInterval(sampler);
  for (const record of records) {
    const sample = rssSamples.filter((s) => s.atEpochMs <= record.startedAtEpochMs).at(-1);
    record.chromeRssAtStart = sample ?? null;
  }
  console.table(
    records.map((r) => ({
      round: r.round,
      step: r.index + 1,
      kind: r.kind,
      clip: r.clip,
      build: r.build,
      lookahead: r.lookahead === null ? "-" : r.lookahead ? "on" : "off",
      detections: r.detections ?? "-",
      "workers live (created)": `${r.workersAtStart.live} (${r.workersAtStart.created})`,
      "engine: detection / cut workers live (created)": r.statsAtStart
        ? `${r.statsAtStart.workers.detection.live} (${r.statsAtStart.workers.detection.created}) / ${r.statsAtStart.workers.cutTrigger.live} (${r.statsAtStart.workers.cutTrigger.created})`
        : "-",
      "JS heap MB": r.heapAtStart ? r.heapAtStart.usedMB.toFixed(1) : "-",
      "worker wasm MB": mb(r.statsAtStart?.wasmMemoryBytes.detectionWorker),
      "main wasm MB": r.statsAtStart
        ? Object.entries(r.statsAtStart.wasmMemoryBytes.mainThread)
            .map(([build, bytes]) => `${build} ${mb(bytes)}`)
            .join(" ") || "-"
        : "-",
      "frame buffer MB": mb(r.statsAtStart?.engine.frameBufferBytes),
      "renderer RSS MB": r.chromeRssAtStart?.rendererMB?.toFixed(0) ?? "-",
      "Chrome RSS MB": r.chromeRssAtStart?.totalMB?.toFixed(0) ?? "-",
      failure: r.failure?.message ?? "",
    }))
  );
  mkdirSync(join(here, ".eval"), { recursive: true });
  writeFileSync(
    join(here, `.eval/suite-soak-${label}.json`),
    JSON.stringify({ checkedAt: new Date().toISOString(), cpuThrottle, rounds, records, rssSamples }, null, 2)
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  process.exit();
}
