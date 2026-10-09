// Checks that the SIMD and scalar WASM builds detect the same faces.
//
// Extracts frames from every clip in public/samples/ with ffmpeg (as raw
// 320x240 RGBA, the detector's input), feeds the same frames in the same
// order to a fresh ReframeEngine of each build, and compares the outputs:
// maximum absolute differences, face-count changes, and detections that
// cross one of the pipeline's thresholds in one build but not the other.
// Scene-cut scores (last_cut_scores) must match exactly.
//
// Usage (after `npm run build:wasm`, needs ffmpeg on PATH):
//   node scripts/compare-wasm-builds.mjs [framesPerSecond=2] [maxFramesPerClip=60]
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const samplesDir = join(root, "public/samples");
const framesPerSecond = Number(process.argv[2] ?? 2);
const maxFramesPerClip = Number(process.argv[3] ?? 60);

const FRAME_W = 320;
const FRAME_H = 240;
const FRAME_BYTES = FRAME_W * FRAME_H * 4;
const STRIDE = 7;

// Must match wasm/src/face.rs and src/core/VertixEngine.ts.
const CONF_THRESHOLD = 0.8;
const IOU_THRESHOLD = 0.4;
const MIN_SKIN_RATIO = 0.15;
const ASPECT_RANGE = [0.25, 3.0];
const MIN_SPEAKER_FACE_SIZE = 0.12;
const MIN_FACE_VISIBLE_FRACTION = 0.8;

// Detections whose box centers are this close (fraction of frame) are the same face.
const MATCH_MAX_CENTER_DISTANCE = 0.05;

async function loadEngine(build) {
  const bindings = await import(join(root, "src/core/wasm", build, "wasm.js"));
  bindings.initSync({ module: readFileSync(join(root, "src/core/wasm", build, "wasm_bg.wasm")) });
  return new bindings.ReframeEngine();
}

function extractFrames(file) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      join(samplesDir, file),
      "-vf",
      `fps=${framesPerSecond},scale=${FRAME_W}:${FRAME_H}:flags=bilinear`,
      "-frames:v",
      String(maxFramesPerClip),
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: FRAME_BYTES * maxFramesPerClip + 1 }
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${result.stderr}`);
  const frames = [];
  for (let offset = 0; offset + FRAME_BYTES <= result.stdout.length; offset += FRAME_BYTES) {
    frames.push(new Uint8Array(result.stdout.subarray(offset, offset + FRAME_BYTES)));
  }
  return frames;
}

function unpack(flat) {
  const faces = [];
  for (let i = 0; i + STRIDE - 1 < flat.length; i += STRIDE) {
    faces.push({
      cx: flat[i],
      cy: flat[i + 1],
      w: flat[i + 2],
      h: flat[i + 3],
      motion: flat[i + 4],
      score: flat[i + 5],
      skinRejected: flat[i + 6] !== 0,
    });
  }
  return faces;
}

function corners(face) {
  return { x1: face.cx - face.w / 2, y1: face.cy - face.h / 2, x2: face.cx + face.w / 2, y2: face.cy + face.h / 2 };
}

function iou(a, b) {
  const ca = corners(a);
  const cb = corners(b);
  const inter =
    Math.max(0, Math.min(ca.x2, cb.x2) - Math.max(ca.x1, cb.x1)) *
    Math.max(0, Math.min(ca.y2, cb.y2) - Math.max(ca.y1, cb.y1));
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

function isSkinTone(r, g, b) {
  return (
    r > 95 && g > 40 && b > 20 && Math.max(r, g, b) - Math.min(r, g, b) > 15 && Math.abs(r - g) > 15 && r > g && r > b
  );
}

// JS port of face.rs skin_ratio, from the reconstructed box (may differ from
// the WASM by one pixel row/column at the box edge; used for margins only).
function skinRatio(rgba, face) {
  const { x1, y1, x2, y2 } = corners(face);
  const toPixel = (value, size) => Math.min(size - 1, Math.max(0, Math.trunc(Math.max(0, value * size))));
  const px1 = toPixel(x1, FRAME_W);
  const px2 = toPixel(x2, FRAME_W);
  const py1 = toPixel(y1, FRAME_H);
  const py2 = toPixel(y2, FRAME_H);
  if (px2 <= px1 || py2 <= py1) return 0;
  let skin = 0;
  let total = 0;
  for (let y = py1; y < py2; y += 2) {
    for (let x = px1; x < px2; x += 2) {
      const i = (y * FRAME_W + x) * 4;
      if (isSkinTone(rgba[i], rgba[i + 1], rgba[i + 2])) skin += 1;
      total += 1;
    }
  }
  return total === 0 ? 0 : skin / total;
}

function visibleFraction(face) {
  const { x1, y1, x2, y2 } = corners(face);
  const visibleW = Math.max(0, Math.min(1, x2) - Math.max(0, x1));
  const visibleH = Math.max(0, Math.min(1, y2) - Math.max(0, y1));
  const area = face.w * face.h;
  return area > 0 ? (visibleW * visibleH) / area : 0;
}

function isSpeakerSized(face) {
  return (
    (face.h >= MIN_SPEAKER_FACE_SIZE || face.w >= MIN_SPEAKER_FACE_SIZE) &&
    visibleFraction(face) >= MIN_FACE_VISIBLE_FRACTION
  );
}

/** Greedy nearest-center matching between the two builds' detections. */
function matchDetections(simdFaces, scalarFaces) {
  const pairs = [];
  const unmatchedScalar = new Set(scalarFaces.keys());
  const unmatchedSimd = [];
  simdFaces.forEach((face, simdIndex) => {
    let best = -1;
    let bestDistance = MATCH_MAX_CENTER_DISTANCE;
    for (const scalarIndex of unmatchedScalar) {
      const other = scalarFaces[scalarIndex];
      const distance = Math.hypot(face.cx - other.cx, face.cy - other.cy);
      if (distance <= bestDistance) {
        best = scalarIndex;
        bestDistance = distance;
      }
    }
    if (best === -1) unmatchedSimd.push(simdIndex);
    else {
      pairs.push([face, scalarFaces[best]]);
      unmatchedScalar.delete(best);
    }
  });
  return { pairs, unmatchedSimd, unmatchedScalar: [...unmatchedScalar] };
}

/** Distance of a lone detection to each filter it could have failed in the other build. */
function thresholdMargins(face, sameBuildFaces, rgba) {
  const aspect = face.w / face.h;
  const maxIou = Math.max(0, ...sameBuildFaces.filter((other) => other !== face).map((other) => iou(face, other)));
  return {
    confidence: face.score - CONF_THRESHOLD,
    nmsIou: maxIou - IOU_THRESHOLD,
    aspect: Math.min(aspect - ASPECT_RANGE[0], ASPECT_RANGE[1] - aspect),
    skinRatio: skinRatio(rgba, face) - MIN_SKIN_RATIO,
  };
}

const simdEngine = await loadEngine("simd");
const scalarEngine = await loadEngine("scalar");

const maxDiff = { box: 0, score: 0, motion: 0, cutScores: 0 };
const minMargin = { confidence: Infinity, skinRatio: Infinity };
const crossings = [];
let frameCount = 0;
let detectionCount = 0;

const clips = readdirSync(samplesDir).filter((file) => file.endsWith(".mp4"));
for (const clip of clips) {
  simdEngine.reset();
  scalarEngine.reset();
  const frames = extractFrames(clip);
  frames.forEach((rgba, frame) => {
    frameCount += 1;
    const mediaTimeSec = frame / framesPerSecond;
    const simdFaces = unpack(simdEngine.update_faces(rgba, mediaTimeSec));
    const scalarFaces = unpack(scalarEngine.update_faces(rgba, mediaTimeSec));
    detectionCount += simdFaces.length;
    const where = { clip, frame, mediaTimeSec };

    const simdCut = simdEngine.last_cut_scores();
    const scalarCut = scalarEngine.last_cut_scores();
    simdCut.forEach((value, i) => {
      maxDiff.cutScores = Math.max(maxDiff.cutScores, Math.abs(value - scalarCut[i]));
    });
    if (simdCut[2] !== scalarCut[2]) {
      crossings.push({ ...where, kind: "scene cut", simd: [...simdCut], scalar: [...scalarCut] });
    }

    for (const face of simdFaces) {
      minMargin.confidence = Math.min(minMargin.confidence, face.score - CONF_THRESHOLD);
      minMargin.skinRatio = Math.min(minMargin.skinRatio, Math.abs(skinRatio(rgba, face) - MIN_SKIN_RATIO));
    }

    const count = (faces) => ({
      total: faces.length,
      kept: faces.filter((face) => !face.skinRejected).length,
      skinRejected: faces.filter((face) => face.skinRejected).length,
      speakerSized: faces.filter((face) => !face.skinRejected && isSpeakerSized(face)).length,
    });
    const simdCount = count(simdFaces);
    const scalarCount = count(scalarFaces);
    if (JSON.stringify(simdCount) !== JSON.stringify(scalarCount)) {
      crossings.push({ ...where, kind: "face count", simd: simdCount, scalar: scalarCount });
    }

    const { pairs, unmatchedSimd, unmatchedScalar } = matchDetections(simdFaces, scalarFaces);
    for (const [simd, scalar] of pairs) {
      for (const key of ["cx", "cy", "w", "h"]) maxDiff.box = Math.max(maxDiff.box, Math.abs(simd[key] - scalar[key]));
      maxDiff.score = Math.max(maxDiff.score, Math.abs(simd.score - scalar.score));
      maxDiff.motion = Math.max(maxDiff.motion, Math.abs(simd.motion - scalar.motion));
      if (simd.skinRejected !== scalar.skinRejected) {
        crossings.push({
          ...where,
          kind: "skin ratio 0.15",
          simd: { skinRejected: simd.skinRejected, ratio: skinRatio(rgba, simd) },
          scalar: { skinRejected: scalar.skinRejected, ratio: skinRatio(rgba, scalar) },
        });
      }
      if (!simd.skinRejected && isSpeakerSized(simd) !== isSpeakerSized(scalar)) {
        crossings.push({
          ...where,
          kind: "size/visibility filter",
          simd: { speakerSized: isSpeakerSized(simd), w: simd.w, h: simd.h, visible: visibleFraction(simd) },
          scalar: { speakerSized: isSpeakerSized(scalar), w: scalar.w, h: scalar.h, visible: visibleFraction(scalar) },
        });
      }
    }
    for (const index of unmatchedSimd) {
      crossings.push({
        ...where,
        kind: "detection only in simd (confidence 0.8, NMS IoU 0.4 or aspect filter)",
        detection: simdFaces[index],
        margins: thresholdMargins(simdFaces[index], simdFaces, rgba),
      });
    }
    for (const index of unmatchedScalar) {
      crossings.push({
        ...where,
        kind: "detection only in scalar (confidence 0.8, NMS IoU 0.4 or aspect filter)",
        detection: scalarFaces[index],
        margins: thresholdMargins(scalarFaces[index], scalarFaces, rgba),
      });
    }
  });
}

console.log(
  JSON.stringify(
    {
      clips: clips.length,
      frames: frameCount,
      framesPerSecond,
      simdDetections: detectionCount,
      maxAbsDiff: maxDiff,
      closestToThreshold: {
        confidenceAbove08: minMargin.confidence,
        skinRatioFrom015: minMargin.skinRatio,
      },
      thresholdCrossings: crossings,
    },
    null,
    2
  )
);
process.exitCode = crossings.length > 0 ? 1 : 0;
