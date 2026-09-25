import initWasm, { ReframeEngine } from "./wasm/wasm.js";

/**
 * Runs the WASM face detector off the main thread, including reading the
 * frame's pixels back from an ImageBitmap — the main thread only draws
 * and resizes the source frame via createImageBitmap() (browser-internal,
 * doesn't block JS) and hands the result over; getImageData's actual
 * GPU→CPU readback happens here instead. Loaded as a plain static file
 * rather than through Vite's own worker-import mechanisms — see
 * scripts/build-worker.mjs for why. Shared as a single instance across
 * the whole app (see VertixEngine's getSharedDetectionWorker), and the
 * main thread falls back to running WASM itself if this worker never
 * reports ready.
 *
 * Typed as `Worker` rather than `DedicatedWorkerGlobalScope` to avoid
 * adding the `webworker` lib to the project's DOM-based tsconfig, which
 * conflicts with it — both interfaces agree on the postMessage/onmessage
 * shape used here.
 */
const ctx = self as unknown as Worker;

let engine: InstanceType<typeof ReframeEngine> | null = null;

// This bundle is built as a classic script, not a module (see
// build-worker.mjs), so it can't rely on wasm.js's default `import.meta.url`
// resolution — pass the .wasm path explicitly instead.
const wasmUrl = new URL("wasm_bg.wasm", self.location.href);

// Post failures back instead of letting them become a silent unhandled
// rejection in here — otherwise the main thread just waits forever for a
// "ready" that never comes.
initWasm({ module_or_path: wasmUrl })
  .then(() => {
    engine = new ReframeEngine();
    ctx.postMessage({ type: "ready" });
  })
  .catch((err: unknown) => {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  });

interface DetectMessage {
  type: "detect";
  requestId: number;
  bitmap: ImageBitmap;
}
interface ResetMessage {
  type: "reset";
}

// Pixel extraction (draw the frame, read its bytes back) happens here, not
// on the main thread — the caller already resizes the frame down to the
// detector's input size via createImageBitmap before sending it, so this
// canvas just needs to match whatever size that bitmap comes in at.
// willReadFrequently since getImageData runs on every detect message.
let detectCanvas: OffscreenCanvas | null = null;
let detectCtx: OffscreenCanvasRenderingContext2D | null = null;

ctx.onmessage = (e: MessageEvent<DetectMessage | ResetMessage>) => {
  const msg = e.data;
  if (msg.type === "reset") {
    engine?.reset();
    return;
  }
  if (msg.type === "detect") {
    // Still instantiating WASM — drop this tick, the caller will just try
    // again on its next one.
    if (!engine) {
      msg.bitmap.close();
      return;
    }
    if (!detectCanvas || detectCanvas.width !== msg.bitmap.width || detectCanvas.height !== msg.bitmap.height) {
      detectCanvas = new OffscreenCanvas(msg.bitmap.width, msg.bitmap.height);
      detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
    }
    detectCtx!.drawImage(msg.bitmap, 0, 0);
    msg.bitmap.close();
    const rgba = detectCtx!.getImageData(0, 0, detectCanvas.width, detectCanvas.height).data;

    // Timed around inference only, not the surrounding readback/postMessage
    // — this is what shows up as "Worker Latency" in the analytics panel.
    const start = performance.now();
    const faces = engine.update_faces(new Uint8Array(rgba.buffer));
    const tookMs = performance.now() - start;
    ctx.postMessage({ type: "result", requestId: msg.requestId, faces, tookMs }, [faces.buffer]);
  }
};
