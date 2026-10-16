import type { FaceBox } from "../layoutEngine";

/** A detected face for tests: square, centred at (cx, cy), `size` a fraction of the frame. */
export function testFace(cx: number, cy: number, size: number, motion = 0): FaceBox {
  return { cx, cy, w: size, h: size, motion, lowerFaceMotion: motion, confidence: 0.9 };
}

/** Detection times every `intervalSec` (5 Hz by default), starting at `intervalSec`. */
export function* detectionTimes(durationSec: number, intervalSec = 0.2): Generator<number> {
  for (let t = intervalSec; t <= durationSec + 1e-9; t += intervalSec) yield Math.round(t * 1000) / 1000;
}
