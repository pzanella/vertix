import { importWasmBindings, type WasmBindings, type WasmBuildVariant } from "./wasmBuild";

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

let engine: InstanceType<WasmBindings["ReframeEngine"]> | null = null;

// The main thread picks the build (see wasmBuild.ts) and sends it in the
// first message; nothing is fetched before that, so only one .wasm binary
// is downloaded. This bundle is built as a classic script, not a module
// (see build-worker.mjs), so it can't rely on wasm.js's default
// `import.meta.url` resolution — the .wasm path is passed explicitly.
// Failures are posted back instead of becoming a silent unhandled
// rejection in here — otherwise the main thread just waits forever for a
// "ready" that never comes.
function initEngine(build: WasmBuildVariant): void {
  const wasmUrl = new URL(`wasm_${build}_bg.wasm`, self.location.href);
  importWasmBindings(build)
    .then(async (bindings) => {
      await bindings.default({ module_or_path: wasmUrl });
      engine = new bindings.ReframeEngine();
      ctx.postMessage({ type: "ready", build });
    })
    .catch((err: unknown) => {
      ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    });
}

interface InitMessage {
  type: "init";
  build: WasmBuildVariant;
}
interface DetectMessage {
  type: "detect";
  requestId: number;
  bitmap: ImageBitmap;
  /** Benchmark mode only: also time the pixel readback below. */
  measureReadback?: boolean;
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

ctx.onmessage = (e: MessageEvent<InitMessage | DetectMessage | ResetMessage>) => {
  const msg = e.data;
  if (msg.type === "init") {
    initEngine(msg.build);
    return;
  }
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
    const readbackStart = msg.measureReadback ? performance.now() : 0;
    detectCtx!.drawImage(msg.bitmap, 0, 0);
    msg.bitmap.close();
    const rgba = detectCtx!.getImageData(0, 0, detectCanvas.width, detectCanvas.height).data;
    const readbackMs = msg.measureReadback ? performance.now() - readbackStart : 0;

    // Timed around inference only, not the surrounding readback/postMessage
    // — this is what shows up as "Worker Latency" in the analytics panel.
    const start = performance.now();
    const faces = engine.update_faces(new Uint8Array(rgba.buffer));
    const tookMs = performance.now() - start;
    ctx.postMessage({ type: "result", requestId: msg.requestId, faces, tookMs, readbackMs }, [faces.buffer]);
  }
};
