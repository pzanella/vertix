/** Messages between FaceMeshClient (main thread) and faceMeshWorker.ts. */

export interface FaceMeshInitMessage {
  type: "init";
  /** Absolute URL of the app's base (the worker runs from a blob: URL and cannot resolve relative ones). */
  baseUrl: string;
  simd: boolean;
}

export interface FaceMeshCheckMessage {
  type: "check";
  requestId: number;
  /** One square crop per face, CROP_SIZE_PX on each side. */
  crops: ImageBitmap[];
}

export interface FaceMeshStatsMessage {
  type: "stats";
  requestId: number;
}

export type FaceMeshWorkerRequest = FaceMeshInitMessage | FaceMeshCheckMessage | FaceMeshStatsMessage;

export interface FaceMeshAssetTiming {
  file: string;
  /** Bytes over the network (0 from the HTTP cache) and decoded, from Resource Timing. */
  transferBytes: number;
  decodedBytes: number;
  ms: number;
}

export interface FaceMeshReadyMessage {
  type: "ready";
  simd: boolean;
  /** Fetching the model (the WASM loader and binary are fetched during loadMs). */
  downloadMs: number;
  /** Loading the WASM and building the task. */
  loadMs: number;
  assets: FaceMeshAssetTiming[];
  /** Mesh edges as flat [from, to] point-index pairs. */
  tessellation: Uint16Array;
  contours: Uint16Array;
}

export interface FaceMeshCheckResult {
  type: "checked";
  requestId: number;
  /** Per crop: flat [x, y] per mesh point, normalised to the crop; null when no face mesh was found. */
  meshes: (Float32Array | null)[];
  landmarkerMs: number[];
}

export interface FaceMeshStatsResult {
  type: "stats";
  requestId: number;
  wasmMemoryBytes: number | null;
}

/** A request the network guard stopped (see networkGuard.ts). */
export interface FaceMeshBlockedMessage {
  type: "blocked";
  host: string;
  api: string;
}

export interface FaceMeshErrorMessage {
  type: "error";
  message: string;
  requestId?: number;
}

export type FaceMeshWorkerResponse =
  FaceMeshReadyMessage | FaceMeshCheckResult | FaceMeshStatsResult | FaceMeshBlockedMessage | FaceMeshErrorMessage;
