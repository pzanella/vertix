import { FaceLandmarker } from "@mediapipe/tasks-vision";
import { installNetworkGuard, type GuardedScope } from "./networkGuard";
import { FACE_MESH_ASSET_DIR, FACE_MESH_MODEL_FILE, faceMeshWasmFiles } from "./faceMeshAssets";
import type {
  FaceMeshAssetTiming,
  FaceMeshInitMessage,
  FaceMeshWorkerRequest,
  FaceMeshWorkerResponse,
} from "./faceMeshProtocol";

/**
 * MediaPipe Face Landmarker for the "Face mesh" demo switch: CPU, IMAGE
 * mode, one face per crop, no blendshapes. Started by FaceMeshClient from a
 * blob: URL inside public/face-mesh/host.html, so it runs under that page's
 * Content Security Policy (connect-src 'self'), and behind the network
 * guard installed below. Every file comes from this origin.
 */
const ctx = self as unknown as Worker & GuardedScope;

let landmarker: FaceLandmarker | null = null;

const post = (message: FaceMeshWorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(message, transfer);

function flatEdges(connections: readonly { start: number; end: number }[]): Uint16Array {
  const edges = new Uint16Array(connections.length * 2);
  connections.forEach((c, i) => {
    edges[i * 2] = c.start;
    edges[i * 2 + 1] = c.end;
  });
  return edges;
}

function assetTimings(urls: string[]): FaceMeshAssetTiming[] {
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  return urls.map((url) => {
    const entry = entries.find((e) => e.name === url);
    return {
      file: url.slice(url.lastIndexOf("/") + 1),
      transferBytes: entry?.transferSize ?? 0,
      decodedBytes: entry?.decodedBodySize ?? 0,
      ms: entry ? entry.responseEnd - entry.startTime : 0,
    };
  });
}

async function init(msg: FaceMeshInitMessage): Promise<void> {
  installNetworkGuard(ctx, msg.baseUrl, (host, api) => post({ type: "blocked", host, api }));
  const assetUrl = (file: string) => new URL(`${FACE_MESH_ASSET_DIR}/${file}`, msg.baseUrl).href;
  const wasm = faceMeshWasmFiles(msg.simd);
  const fileset = { wasmLoaderPath: assetUrl(wasm.loader), wasmBinaryPath: assetUrl(wasm.binary) };
  const modelUrl = assetUrl(FACE_MESH_MODEL_FILE);

  const downloadStart = performance.now();
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`${FACE_MESH_MODEL_FILE}: HTTP ${response.status}`);
  const model = new Uint8Array(await response.arrayBuffer());
  const downloadMs = performance.now() - downloadStart;

  const loadStart = performance.now();
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: model, delegate: "CPU" },
    runningMode: "IMAGE",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
  const loadMs = performance.now() - loadStart;

  const tessellation = flatEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
  const contours = flatEdges(FaceLandmarker.FACE_LANDMARKS_CONTOURS);
  post(
    {
      type: "ready",
      simd: msg.simd,
      downloadMs,
      loadMs,
      assets: assetTimings([fileset.wasmLoaderPath, fileset.wasmBinaryPath, modelUrl]),
      tessellation,
      contours,
    },
    [tessellation.buffer, contours.buffer]
  );
}

function meshOf(crop: ImageBitmap): { mesh: Float32Array | null; ms: number } {
  const start = performance.now();
  const points = landmarker!.detect(crop).faceLandmarks[0];
  const ms = performance.now() - start;
  crop.close();
  if (!points) return { mesh: null, ms };
  const mesh = new Float32Array(points.length * 2);
  points.forEach((p, i) => {
    mesh[i * 2] = p.x;
    mesh[i * 2 + 1] = p.y;
  });
  return { mesh, ms };
}

/** Finds the WASM heap of the task by walking its (minified) fields for an Emscripten module. */
function wasmMemoryBytes(task: object | null): number | null {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): number | null => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 3) return null;
    seen.add(value);
    const heap = (value as { HEAPU8?: Uint8Array }).HEAPU8;
    if (heap instanceof Uint8Array) return heap.buffer.byteLength;
    for (const key of Object.keys(value)) {
      const found = visit((value as Record<string, unknown>)[key], depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(task, 0);
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

ctx.onmessage = (e: MessageEvent<FaceMeshWorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      init(msg).catch((err: unknown) => post({ type: "error", message: errorMessage(err) }));
    } else if (msg.type === "stats") {
      post({ type: "stats", requestId: msg.requestId, wasmMemoryBytes: wasmMemoryBytes(landmarker) });
    } else if (msg.type === "check") {
      if (!landmarker) {
        for (const crop of msg.crops) crop.close();
        post({ type: "error", requestId: msg.requestId, message: "not ready" });
        return;
      }
      const results = msg.crops.map(meshOf);
      const meshes = results.map((r) => r.mesh);
      post(
        { type: "checked", requestId: msg.requestId, meshes, landmarkerMs: results.map((r) => r.ms) },
        meshes.filter((m): m is Float32Array => m !== null).map((m) => m.buffer)
      );
    }
  } catch (err) {
    post({ type: "error", message: errorMessage(err), requestId: "requestId" in msg ? msg.requestId : undefined });
  }
};
