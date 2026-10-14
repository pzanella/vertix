import { CutTrigger, TRIGGER_H, TRIGGER_SOURCE_H, TRIGGER_SOURCE_W, TRIGGER_W } from "./lookahead/cutTrigger";

/**
 * Scores every frame's 64x48 thumbnail for the cut pre-screen, off the
 * main thread and apart from the detection worker (which is busy for
 * 50-200 ms per detection, so a message queued behind it would arrive too
 * late). The frame comes as a VideoFrame (the decoded frame itself; closed
 * here as soon as it is drawn, also on errors) or as a 160x120 bitmap of
 * the buffered copy. Plain JS, no WASM. Bundled like faceDetectionWorker.ts,
 * see scripts/build-worker.mjs.
 */
const ctx = self as unknown as Worker;

const trigger = new CutTrigger();
let canvas: OffscreenCanvas | null = null;
let canvasCtx: OffscreenCanvasRenderingContext2D | null = null;
// A VideoFrame is first scaled on the GPU to the bitmap path's size, so the
// readback is of 160x120 pixels, not the full frame, and the scores match.
let stageCanvas: OffscreenCanvas | null = null;
let stageCtx: OffscreenCanvasRenderingContext2D | null = null;

interface ScoreMessage {
  type: "score";
  generation: number;
  frameId: number;
  source: VideoFrame | ImageBitmap;
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
  const { source, generation, frameId } = msg;
  const wasVideoFrame = typeof VideoFrame !== "undefined" && source instanceof VideoFrame;
  let pixels: Uint8ClampedArray;
  try {
    if (!canvas) {
      canvas = new OffscreenCanvas(TRIGGER_W, TRIGGER_H);
      canvasCtx = canvas.getContext("2d", { willReadFrequently: true });
    }
    let scaled: CanvasImageSource = source;
    if (wasVideoFrame) {
      if (!stageCanvas) {
        stageCanvas = new OffscreenCanvas(TRIGGER_SOURCE_W, TRIGGER_SOURCE_H);
        stageCtx = stageCanvas.getContext("2d");
        stageCtx!.imageSmoothingQuality = "low";
      }
      stageCtx!.drawImage(source, 0, 0, TRIGGER_SOURCE_W, TRIGGER_SOURCE_H);
      scaled = stageCanvas;
    }
    // The pixel readback of the frame happens here, off the main thread.
    canvasCtx!.drawImage(scaled, 0, 0, TRIGGER_W, TRIGGER_H);
    pixels = canvasCtx!.getImageData(0, 0, TRIGGER_W, TRIGGER_H).data;
  } catch {
    ctx.postMessage({
      type: "score",
      generation,
      frameId,
      wasVideoFrame,
      failed: true,
      hist: 0,
      grid: 0,
      triggered: false,
    });
    return;
  } finally {
    source.close();
  }
  const scores = trigger.observe(pixels);
  ctx.postMessage({ type: "score", generation, frameId, wasVideoFrame, failed: false, ...scores });
};
