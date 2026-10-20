/** Face mesh assets, served from public/face-mesh/ (see scripts/build-worker.mjs). */
export const FACE_MESH_ASSET_DIR = "face-mesh";
export const FACE_MESH_MODEL_FILE = "face_landmarker.task";
/** Hosts the worker under a strict Content Security Policy of its own. */
export const FACE_MESH_HOST_PAGE = "host.html";
export const FACE_MESH_WORKER_PATH = "workers/faceMeshWorker.js";

export function faceMeshWasmFiles(simd: boolean): { loader: string; binary: string } {
  const name = simd ? "vision_wasm_internal" : "vision_wasm_nosimd_internal";
  return { loader: `${name}.js`, binary: `${name}.wasm` };
}
