// Tracker + layout rules cost per detection, measured in Node with a
// precise timer (the browser checks' timer is too coarse for it). Synthetic
// scenes: 1, 2 and 3 foreground faces, and a rally (3 large faces, 12 small).
//
// Usage: npx vite-node scripts/bench-tracker.ts
import { LayoutPlanner } from "../src/core/tracking/layoutPlanner";
import type { FaceBox } from "../src/core/layoutEngine";

const FRAME = { srcW: 1280, srcH: 720, outW: 405, outH: 720 };
const DETECTIONS = 20000;

function face(cx: number, cy: number, h: number, t: number, seed: number): FaceBox {
  const jitter = 0.004 * Math.sin(t * 7 + seed);
  return {
    cx: cx + jitter,
    cy: cy + jitter,
    w: h * 0.56,
    h,
    motion: 2 + Math.abs(Math.sin(t * 3 + seed)) * 5,
    lowerFaceMotion: 6,
    confidence: 0.9,
  };
}

const SCENES: Record<string, (t: number) => FaceBox[]> = {
  "1 face": (t) => [face(0.5, 0.4, 0.3, t, 1)],
  "2 faces": (t) => [face(0.3, 0.4, 0.25, t, 1), face(0.7, 0.4, 0.25, t, 2)],
  "3 faces": (t) => [face(0.2, 0.4, 0.22, t, 1), face(0.5, 0.4, 0.22, t, 2), face(0.8, 0.4, 0.22, t, 3)],
  "rally (3 + 12 small)": (t) => [
    face(0.3, 0.45, 0.25, t, 1),
    face(0.5, 0.4, 0.3, t, 2),
    face(0.7, 0.45, 0.24, t, 3),
    ...Array.from({ length: 12 }, (_, i) => face(0.05 + i * 0.08, 0.2, 0.07, t, 10 + i)),
  ],
};

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

for (const [name, scene] of Object.entries(SCENES)) {
  const planner = new LayoutPlanner();
  const samples: number[] = [];
  for (let i = 1; i <= DETECTIONS; i++) {
    const t = i * 0.2;
    const faces = scene(t);
    const start = performance.now();
    planner.plan(faces, 0.05, t, false, FRAME);
    samples.push(performance.now() - start);
  }
  samples.splice(0, 1000);
  samples.sort((a, b) => a - b);
  console.log(
    `${name}: p50 ${(percentile(samples, 0.5) * 1000).toFixed(1)} µs, p95 ${(percentile(samples, 0.95) * 1000).toFixed(1)} µs`
  );
}
