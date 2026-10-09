import { CutTrigger } from "./lookahead/cutTrigger";

/**
 * Scores every frame's 64x48 thumbnail for the cut pre-screen, off the main
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
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvasCtx = canvas.getContext("2d", { willReadFrequently: true });
  }
  canvasCtx!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const scores = trigger.observe(canvasCtx!.getImageData(0, 0, canvas.width, canvas.height).data);
  ctx.postMessage({ type: "score", frameId: msg.frameId, ...scores });
};
