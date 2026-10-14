import { CutTrigger, TRIGGER_H, TRIGGER_W } from "./lookahead/cutTrigger";

/**
 * Scores every frame's 64x48 thumbnail (scaled here from the 160x120
 * bitmap the main thread sends) for the cut pre-screen, off the main
 * thread and apart from the detection worker (which is busy for 50-200 ms
 * per detection, so a message queued behind it would arrive too late).
 * Plain JS, no WASM. Bundled like faceDetectionWorker.ts, see
 * scripts/build-worker.mjs.
 */
const ctx = self as unknown as Worker;

const trigger = new CutTrigger();
let canvas: OffscreenCanvas | null = null;
let canvasCtx: OffscreenCanvasRenderingContext2D | null = null;

interface ScoreMessage {
  type: "score";
  frameId: number;
  bitmap: ImageBitmap;
}
interface ResetMessage {
  type: "reset";
}

ctx.onmessage = (e: MessageEvent<ScoreMessage | ResetMessage>) => {
  const msg = e.data;
  if (msg.type === "reset") {
    trigger.reset();
    return;
  }
  const { bitmap } = msg;
  if (!canvas) {
    canvas = new OffscreenCanvas(TRIGGER_W, TRIGGER_H);
    canvasCtx = canvas.getContext("2d", { willReadFrequently: true });
  }
  // The pixel readback of the frame happens here, off the main thread.
  canvasCtx!.drawImage(bitmap, 0, 0, TRIGGER_W, TRIGGER_H);
  bitmap.close();
  const scores = trigger.observe(canvasCtx!.getImageData(0, 0, TRIGGER_W, TRIGGER_H).data);
  ctx.postMessage({ type: "score", frameId: msg.frameId, ...scores });
};
