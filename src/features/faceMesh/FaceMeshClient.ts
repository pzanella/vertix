import type { DetectionTick, DetectionTickTrack } from "../../core";
import { FACE_MESH_ASSET_DIR, FACE_MESH_HOST_PAGE, FACE_MESH_WORKER_PATH } from "./faceMeshAssets";
import type { FaceMeshReadyMessage, FaceMeshWorkerRequest, FaceMeshWorkerResponse } from "./faceMeshProtocol";
import { CROP_SIZE_PX, cropRectFor, cropToSource, tracksToMesh, type CropRect } from "./meshGeometry";
import type { MeshCheck } from "./meshTimeline";

export const FACE_MESH_INIT_TIMEOUT_MS = 30_000;
const MIN_REQUEST_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_P95_FACTOR = 10;
const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 60_000;
const ROUND_TRIP_HISTORY = 100;

export type FaceMeshState = "loading" | "ready" | "failed";

/** One detection tick as the face mesh saw it. */
export interface FaceMeshTickRecord {
  mediaTimeSec: number;
  /** "checked": meshes came back; "skipped": the previous check was still running; "mismatch": no copy of that frame. */
  outcome: "checked" | "skipped" | "mismatch";
  faces: number;
  /** Frame sent to detection until its meshes came back. */
  resultAgeMs: number | null;
  /** Crops sent until the meshes came back. */
  roundTripMs: number | null;
  landmarkerMs: number[];
  meshesFound: number;
}

export interface FaceMeshClientEvents {
  onStateChange(state: FaceMeshState, reason: string | null): void;
  onCheck(check: MeshCheck): void;
  onCut(mediaTimeSec: number): void;
  onTick(record: FaceMeshTickRecord): void;
  onBlocked(host: string, api: string): void;
}

interface PendingCheck {
  mediaTimeSec: number;
  frameAt: number;
  sentAt: number;
  tracks: DetectionTickTrack[];
  crops: CropRect[];
  srcW: number;
  srcH: number;
  timeout: ReturnType<typeof setTimeout>;
}

type HostWindow = Window & typeof globalThis;

/**
 * Runs the face mesh worker for the "Face mesh" demo switch. The worker is
 * created inside a hidden same-origin iframe (public/face-mesh/host.html)
 * from a blob: URL, so it inherits that page's strict Content Security
 * Policy instead of the app page's. Crops the detection boxes of each tick
 * from a copy of the detected frame; one check in flight at a time.
 */
export class FaceMeshClient {
  state: FaceMeshState = "loading";
  failureReason: string | null = null;
  ready: FaceMeshReadyMessage | null = null;
  restarts = 0;

  private frame: HTMLIFrameElement | null = null;
  private worker: Worker | null = null;
  private bootstrapUrl: string | null = null;
  private initTimeout: ReturnType<typeof setTimeout> | null = null;
  private restartTimes: number[] = [];
  private nextRequestId = 1;
  private pending = new Map<number, PendingCheck>();
  private pendingStats = new Map<number, (bytes: number | null) => void>();
  private roundTrips: number[] = [];
  private copy: OffscreenCanvas | null = null;
  private copyCtx: OffscreenCanvasRenderingContext2D | null = null;
  private copiedMediaTimeSec: number | null = null;
  private copiedAt = 0;
  private cropCanvas: OffscreenCanvas | null = null;
  private cropCtx: OffscreenCanvasRenderingContext2D | null = null;
  private destroyed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly simd: boolean,
    private readonly events: FaceMeshClientEvents
  ) {
    this.startHost();
  }

  /** Copies the frame a detection is about to run on, so its boxes can be cropped from it once the tracks are known. */
  captureFrame(source: HTMLVideoElement | OffscreenCanvas, mediaTimeSec: number): void {
    if (this.state !== "ready") return;
    const w = source instanceof OffscreenCanvas ? source.width : source.videoWidth;
    const h = source instanceof OffscreenCanvas ? source.height : source.videoHeight;
    if (w === 0 || h === 0) return;
    if (!this.copy || this.copy.width !== w || this.copy.height !== h) {
      this.copy = new OffscreenCanvas(w, h);
      this.copyCtx = this.copy.getContext("2d", { alpha: false });
    }
    this.copyCtx!.drawImage(source, 0, 0);
    this.copiedMediaTimeSec = mediaTimeSec;
    this.copiedAt = performance.now();
  }

  /** Sends the crops of this tick's tracks to the worker, or records why not. */
  check(tick: DetectionTick): void {
    if (tick.cutAtSec !== null) this.events.onCut(tick.cutAtSec);
    if (this.state !== "ready" || !this.worker || !this.copy) return;
    const tracks = tracksToMesh(tick.tracks);
    const record = (outcome: FaceMeshTickRecord["outcome"]) =>
      this.events.onTick({
        mediaTimeSec: tick.mediaTimeSec,
        outcome,
        faces: tracks.length,
        resultAgeMs: null,
        roundTripMs: null,
        landmarkerMs: [],
        meshesFound: 0,
      });
    if (this.copiedMediaTimeSec !== tick.mediaTimeSec) {
      record("mismatch");
      return;
    }
    if (this.pending.size > 0) {
      record("skipped");
      return;
    }
    if (tracks.length === 0) {
      this.events.onCheck({ mediaTimeSec: tick.mediaTimeSec, meshes: new Map() });
      return;
    }
    const crops = tracks.map((t) => cropRectFor(t, tick.srcW, tick.srcH));
    const bitmaps = crops.map((crop) => this.cropBitmap(crop, tick.srcW));
    const requestId = this.nextRequestId++;
    const timeoutMs = Math.max(MIN_REQUEST_TIMEOUT_MS, (this.roundTripP95() ?? 0) * REQUEST_TIMEOUT_P95_FACTOR);
    this.pending.set(requestId, {
      mediaTimeSec: tick.mediaTimeSec,
      frameAt: this.copiedAt,
      sentAt: performance.now(),
      tracks,
      crops,
      srcW: tick.srcW,
      srcH: tick.srcH,
      timeout: setTimeout(() => this.restart(`a check got no answer within ${Math.round(timeoutMs)} ms`), timeoutMs),
    });
    this.post({ type: "check", requestId, crops: bitmaps }, bitmaps);
  }

  /** The worker's WASM heap size, or null. */
  wasmMemoryBytes(): Promise<number | null> {
    if (!this.worker || this.state !== "ready") return Promise.resolve(null);
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingStats.delete(requestId);
        resolve(null);
      }, 2000);
      this.pendingStats.set(requestId, (bytes) => {
        clearTimeout(timeout);
        resolve(bytes);
      });
      this.post({ type: "stats", requestId });
    });
  }

  /** Median time from crops sent to meshes back, over the recent checks. */
  get roundTripP50Ms(): number | null {
    if (this.roundTrips.length === 0) return null;
    const sorted = [...this.roundTrips].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  destroy(): void {
    this.destroyed = true;
    this.stopWorker();
    this.frame?.remove();
    this.frame = null;
    this.copy = null;
    this.cropCanvas = null;
  }

  private startHost(): void {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.title = "Face mesh worker host";
    frame.src = new URL(`${FACE_MESH_ASSET_DIR}/${FACE_MESH_HOST_PAGE}`, this.baseUrl).href;
    frame.addEventListener("load", () => this.startWorker(), { once: true });
    frame.addEventListener("error", () => this.fail("the face mesh host page did not load"), { once: true });
    this.frame = frame;
    this.armInitTimeout();
    document.body.appendChild(frame);
  }

  private startWorker(): void {
    const host = this.frame?.contentWindow as HostWindow | null;
    if (this.destroyed || !host) return;
    try {
      const workerUrl = new URL(FACE_MESH_WORKER_PATH, this.baseUrl).href;
      const bootstrap = new host.Blob([`importScripts(${JSON.stringify(workerUrl)});`], { type: "text/javascript" });
      this.bootstrapUrl = host.URL.createObjectURL(bootstrap);
      const worker = new host.Worker(this.bootstrapUrl);
      worker.onmessage = (e: MessageEvent<FaceMeshWorkerResponse>) => this.onMessage(worker, e.data);
      worker.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        if (worker === this.worker) this.restart(e.message || "worker error");
      };
      this.worker = worker;
      this.post({ type: "init", baseUrl: this.baseUrl, simd: this.simd });
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private armInitTimeout(): void {
    if (this.initTimeout) clearTimeout(this.initTimeout);
    this.initTimeout = setTimeout(
      () => this.fail(`not ready within ${FACE_MESH_INIT_TIMEOUT_MS / 1000} s`),
      FACE_MESH_INIT_TIMEOUT_MS
    );
  }

  private onMessage(worker: Worker, msg: FaceMeshWorkerResponse): void {
    if (worker !== this.worker) return;
    if (msg.type === "blocked") {
      this.events.onBlocked(msg.host, msg.api);
    } else if (msg.type === "ready") {
      if (this.initTimeout) clearTimeout(this.initTimeout);
      this.initTimeout = null;
      this.ready = msg;
      this.setState("ready", null);
    } else if (msg.type === "stats") {
      this.pendingStats.get(msg.requestId)?.(msg.wasmMemoryBytes);
      this.pendingStats.delete(msg.requestId);
    } else if (msg.type === "checked") {
      this.onChecked(msg.requestId, msg.meshes, msg.landmarkerMs);
    } else if (msg.type === "error") {
      if (this.state === "loading") this.fail(msg.message);
      else this.restart(msg.message);
    }
  }

  private onChecked(requestId: number, meshes: (Float32Array | null)[], landmarkerMs: number[]): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    const now = performance.now();
    const roundTripMs = now - pending.sentAt;
    this.roundTrips.push(roundTripMs);
    if (this.roundTrips.length > ROUND_TRIP_HISTORY) this.roundTrips.shift();

    const byTrack = new Map<number, Float32Array | null>();
    pending.tracks.forEach((track, i) => {
      const mesh = meshes[i] ?? null;
      byTrack.set(track.id, mesh && cropToSource(mesh, pending.crops[i], pending.srcW, pending.srcH));
    });
    this.events.onCheck({ mediaTimeSec: pending.mediaTimeSec, meshes: byTrack });
    this.events.onTick({
      mediaTimeSec: pending.mediaTimeSec,
      outcome: "checked",
      faces: pending.tracks.length,
      resultAgeMs: now - pending.frameAt,
      roundTripMs,
      landmarkerMs,
      meshesFound: meshes.filter((m) => m !== null).length,
    });
  }

  private cropBitmap(crop: CropRect, srcW: number): ImageBitmap {
    this.cropCanvas ??= new OffscreenCanvas(CROP_SIZE_PX, CROP_SIZE_PX);
    this.cropCtx ??= this.cropCanvas.getContext("2d", { alpha: false });
    const ctx = this.cropCtx!;
    const scale = this.copy!.width / srcW;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CROP_SIZE_PX, CROP_SIZE_PX);
    ctx.drawImage(
      this.copy!,
      crop.x * scale,
      crop.y * scale,
      crop.side * scale,
      crop.side * scale,
      0,
      0,
      CROP_SIZE_PX,
      CROP_SIZE_PX
    );
    return this.cropCanvas.transferToImageBitmap();
  }

  private roundTripP95(): number | null {
    if (this.roundTrips.length === 0) return null;
    const sorted = [...this.roundTrips].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
  }

  private post(message: FaceMeshWorkerRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(message, transfer);
  }

  private restart(reason: string): void {
    if (this.destroyed || this.state === "failed") return;
    const now = performance.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= RESTART_LIMIT) {
      this.fail(`${reason}; ${RESTART_LIMIT} restarts within ${RESTART_WINDOW_MS / 1000} s`);
      return;
    }
    this.restartTimes.push(now);
    this.restarts += 1;
    this.stopWorker();
    this.setState("loading", reason);
    this.armInitTimeout();
    this.startWorker();
  }

  private fail(reason: string): void {
    if (this.destroyed) return;
    this.stopWorker();
    this.failureReason = reason;
    this.setState("failed", reason);
  }

  private stopWorker(): void {
    if (this.initTimeout) clearTimeout(this.initTimeout);
    this.initTimeout = null;
    for (const pending of this.pending.values()) clearTimeout(pending.timeout);
    this.pending.clear();
    for (const resolve of this.pendingStats.values()) resolve(null);
    this.pendingStats.clear();
    this.worker?.terminate();
    this.worker = null;
    if (this.bootstrapUrl) (this.frame?.contentWindow as HostWindow | null)?.URL.revokeObjectURL(this.bootstrapUrl);
    this.bootstrapUrl = null;
  }

  private setState(state: FaceMeshState, reason: string | null): void {
    this.state = state;
    this.events.onStateChange(state, reason);
  }
}
