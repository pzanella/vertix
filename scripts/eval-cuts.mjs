// Compares the WASM scene-cut detector with ffmpeg's cut detection.
//
// For each input, ffmpeg's scdet filter (threshold SCDET_THRESHOLD) gives
// the reference cuts; for clips made by make-cut-clips.mjs, the known join
// times are the ground truth instead. Every 5th frame (the app's detection
// interval) is decoded in memory as 320x240 RGBA and fed to a fresh
// ReframeEngine of each build. Reported per input: hits, misses and false
// cuts for the shipped rule (threshold + spike + minimum gap in media
// time), for
// threshold + spike without the gap, and for the threshold alone, plus the
// highest scores on non-cut detections.
//
// Usage (after `npm run build:wasm`, needs ffmpeg on PATH):
//   node scripts/eval-cuts.mjs                 sample clips + .eval/cut-clips/
//   node scripts/eval-cuts.mjs --licensed      streams listed in VERTIX_E2E_HLS_URLS
//                                              (.env.local); local use only
//   --build=simd|scalar                        run one build instead of both
//
// Licensed inputs are labelled by index only: their URLs and ffmpeg's error
// output are never printed. Results go to stdout and .eval/ (gitignored).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const evalDir = join(root, ".eval");
const args = process.argv.slice(2);
const licensed = args.includes("--licensed");
const onlyBuild = args.find((arg) => arg.startsWith("--build="))?.slice("--build=".length);

const FRAME_W = 320;
const FRAME_H = 240;
const FRAME_BYTES = FRAME_W * FRAME_H * 4;
// Must match FACE_DETECT_INTERVAL in src/core/VertixEngine.ts.
const DETECT_INTERVAL_FRAMES = 5;
// Must match wasm/src/scene_cut.rs.
const CUT_SCORE_THRESHOLD = 0.12;
const CUT_SPIKE_FACTOR = 3;
const CUT_SPIKE_HISTORY = 10;
// scdet's own default: scores of 10+ are hard cuts.
const SCDET_THRESHOLD = 10;

async function loadEngine(build) {
  const bindings = await import(join(root, "src/core/wasm", build, "wasm.js"));
  bindings.initSync({ module: readFileSync(join(root, "src/core/wasm", build, "wasm_bg.wasm")) });
  return new bindings.ReframeEngine();
}

/** Runs ffmpeg and resolves with its stdout; stderr is only kept for local files. */
function runFfmpeg(ffArgs, { onStdout, keepStderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", ...ffArgs]);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", onStdout);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const error = new Error(keepStderr ? `ffmpeg exited ${code}: ${stderr}` : `ffmpeg exited ${code}`);
        error.forbidden = /403/.test(stderr);
        reject(error);
      }
    });
  });
}

async function probeFrameRate(source, keepStderr) {
  let out = "";
  await new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate",
      "-of",
      "csv=p=0",
      source,
    ]);
    let stderr = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const error = new Error(keepStderr ? `ffprobe exited ${code}: ${stderr}` : `ffprobe exited ${code}`);
        error.forbidden = /403/.test(stderr);
        reject(error);
      }
    });
  });
  const [num, den] = out.trim().split("\n")[0].split("/").map(Number);
  return num / (den || 1);
}

async function scdetCuts(source, keepStderr) {
  let text = "";
  await runFfmpeg(["-i", source, "-an", "-vf", "scdet=threshold=1,metadata=print:file=-", "-f", "null", "-"], {
    onStdout: (chunk) => (text += chunk),
    keepStderr,
  });
  const cuts = [];
  let timeSec = null;
  for (const line of text.split("\n")) {
    const time = line.match(/pts_time:([0-9.]+)/);
    if (time) timeSec = Number(time[1]);
    const score = line.match(/lavfi\.scd\.score=([0-9.]+)/);
    if (score && timeSec !== null && Number(score[1]) >= SCDET_THRESHOLD) {
      cuts.push({ timeSec, score: Number(score[1]) });
    }
  }
  return cuts;
}

async function scoreDetections(source, fps, engines, keepStderr) {
  for (const engine of Object.values(engines)) engine.reset();
  const detections = [];
  let buffered = Buffer.alloc(0);
  let mismatches = 0;
  const handleFrame = (rgba) => {
    const timeSec = (detections.length * DETECT_INTERVAL_FRAMES) / fps;
    const scores = {};
    for (const [build, engine] of Object.entries(engines)) {
      engine.update_faces(rgba, timeSec);
      scores[build] = [...engine.last_cut_scores()];
    }
    const [first, ...others] = Object.values(scores);
    if (others.some((other) => other.some((value, i) => value !== first[i]))) mismatches += 1;
    const [hist, grid, isCut] = first;
    detections.push({ timeSec, hist, grid, isCut: isCut === 1 });
  };
  await runFfmpeg(
    [
      "-i",
      source,
      "-an",
      "-vf",
      `select='not(mod(n\\,${DETECT_INTERVAL_FRAMES}))',scale=${FRAME_W}:${FRAME_H}:flags=bilinear`,
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "-",
    ],
    {
      onStdout: (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= FRAME_BYTES) {
          handleFrame(new Uint8Array(buffered.subarray(0, FRAME_BYTES)));
          buffered = buffered.subarray(FRAME_BYTES);
        }
      },
      keepStderr,
    }
  );
  return { detections, buildMismatches: mismatches };
}

/** Greedy one-to-one matching: a cut is hit by the first detection frame at or after it. */
function matchCuts(truthSec, detectedSec, fps) {
  const before = 0.5 / fps;
  const after = (DETECT_INTERVAL_FRAMES + 0.5) / fps;
  const unmatched = new Set(detectedSec.keys());
  let hits = 0;
  const missedSec = [];
  for (const cut of truthSec) {
    const match = [...unmatched].find((i) => detectedSec[i] >= cut - before && detectedSec[i] <= cut + after);
    if (match === undefined) missedSec.push(cut);
    else {
      hits += 1;
      unmatched.delete(match);
    }
  }
  return {
    hits,
    misses: missedSec.length,
    falseCuts: unmatched.size,
    missedSec,
    falseCutSec: [...unmatched].map((i) => detectedSec[i]),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** JS replica of scene_cut.rs without the minimum gap between cuts. */
function thresholdAndSpikeCutsSec(detections) {
  const isSpike = (key, i) => {
    const score = detections[i][key];
    if (score < CUT_SCORE_THRESHOLD) return false;
    const history = detections.slice(Math.max(1, i - CUT_SPIKE_HISTORY), i).map((d) => d[key]);
    return history.length < CUT_SPIKE_HISTORY || score >= CUT_SPIKE_FACTOR * median(history);
  };
  return detections.filter((d, i) => i > 0 && (isSpike("hist", i) || isSpike("grid", i))).map((d) => d.timeSec);
}

function round(value, digits = 3) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

/** Reads one variable from the environment, else from .env.local (gitignored). */
function readLocalEnv(name) {
  if (process.env[name]) return process.env[name];
  const envFile = join(root, ".env.local");
  if (!existsSync(envFile)) return "";
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && match[1] === name) return match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return "";
}

function inputs() {
  if (licensed) {
    const urls = readLocalEnv("VERTIX_E2E_HLS_URLS")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean);
    return urls.map((source, i) => ({ label: `licensed clip ${i + 1}`, source, keepStderr: false, joinsSec: null }));
  }
  const samplesDir = join(root, "public/samples");
  const cutClipsDir = join(evalDir, "cut-clips");
  const samples = readdirSync(samplesDir)
    .filter((file) => file.endsWith(".mp4"))
    .map((file) => ({ label: file, source: join(samplesDir, file), keepStderr: true, joinsSec: [] }));
  const cutClips = existsSync(cutClipsDir)
    ? readdirSync(cutClipsDir)
        .filter((file) => file.endsWith(".mp4"))
        .map((file) => ({
          label: `cut-clips/${file}`,
          source: join(cutClipsDir, file),
          keepStderr: true,
          joinsSec: JSON.parse(readFileSync(join(cutClipsDir, file.replace(/\.mp4$/, ".json")), "utf8")).joinsSec,
        }))
    : [];
  return [...samples, ...cutClips];
}

const builds = onlyBuild ? [onlyBuild] : ["simd", "scalar"];
const engines = Object.fromEntries(await Promise.all(builds.map(async (build) => [build, await loadEngine(build)])));

const results = [];
const skipped = [];
for (const input of inputs()) {
  try {
    const fps = await probeFrameRate(input.source, input.keepStderr);
    const scdet = await scdetCuts(input.source, input.keepStderr);
    const { detections, buildMismatches } = await scoreDetections(input.source, fps, engines, input.keepStderr);
    const truthSec = input.joinsSec ?? scdet.map((cut) => cut.timeSec);
    const spikeRuleSec = detections.filter((d) => d.isCut).map((d) => d.timeSec);
    const absoluteRuleSec = detections
      .filter((d) => d.hist >= CUT_SCORE_THRESHOLD || d.grid >= CUT_SCORE_THRESHOLD)
      .map((d) => d.timeSec);
    const cutTimes = new Set(spikeRuleSec);
    const nonCut = detections.filter((d) => !cutTimes.has(d.timeSec));
    results.push({
      input: input.label,
      groundTruth: input.joinsSec ? "known join times" : `ffmpeg scdet >= ${SCDET_THRESHOLD}`,
      fps: round(fps),
      detections: detections.length,
      buildMismatches: builds.length > 1 ? buildMismatches : null,
      truthCutsSec: truthSec.map((t) => round(t)),
      scdetCuts: scdet.map((cut) => ({ timeSec: round(cut.timeSec), score: round(cut.score, 1) })),
      detectedCuts: detections
        .filter((d) => d.isCut)
        .map((d) => ({ timeSec: round(d.timeSec), hist: round(d.hist), grid: round(d.grid) })),
      shippedRule: matchCuts(truthSec, spikeRuleSec, fps),
      thresholdAndSpikeRule: matchCuts(truthSec, thresholdAndSpikeCutsSec(detections), fps),
      thresholdOnlyRule: matchCuts(truthSec, absoluteRuleSec, fps),
      maxNonCutScores: {
        hist: round(Math.max(0, ...nonCut.map((d) => d.hist))),
        grid: round(Math.max(0, ...nonCut.map((d) => d.grid))),
      },
    });
    console.error(`[eval-cuts] ${input.label}: done`);
  } catch (error) {
    if (error.forbidden) {
      skipped.push({ input: input.label, reason: "HTTP 403" });
      console.error(`[eval-cuts] ${input.label}: skipped (HTTP 403)`);
    } else if (input.keepStderr) {
      throw error;
    } else {
      skipped.push({ input: input.label, reason: error.message });
      console.error(`[eval-cuts] ${input.label}: skipped (${error.message})`);
    }
  }
}

const report = { builds, results, skipped };
mkdirSync(evalDir, { recursive: true });
writeFileSync(join(evalDir, licensed ? "eval-cuts-licensed.json" : "eval-cuts.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.some((r) => r.buildMismatches) ? 1 : 0;
