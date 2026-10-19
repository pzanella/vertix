import type { DeviceClass, OverlayFrame, VertixEngine } from "../../core";
import { drawMeshes, type MeshEdges } from "./drawMesh";
import { FaceMeshBenchRecorder } from "./faceMeshBench";
import {
  FaceMeshClient,
  type FaceMeshClientEvents,
  type FaceMeshState,
  type FaceMeshTickRecord,
} from "./FaceMeshClient";
import { MeshLatency, nextMinimumMs } from "./meshLookahead";
import { MESH_STYLES, type MeshStyleId } from "./meshStyles";
import { MeshTimeline, type ShownMeshKind } from "./meshTimeline";

/** The engine calls the face mesh needs. */
export type FaceMeshEngine = Pick<
  VertixEngine,
  | "observeDetections"
  | "setOverlayRenderer"
  | "setSourceViewDetection"
  | "setMinimumLookaheadMs"
  | "getLookaheadLengths"
  | "getMetrics"
>;

export interface FaceMeshStatus {
  state: FaceMeshState;
  reason: string | null;
  /** performance.now() when loading started, while loading. */
  loadingSinceMs: number | null;
  /** How the frames of the last second were shown; null without meshes. */
  mode: "interpolated" | "steps" | null;
  /** Checks fall behind the detection ticks (skipped ticks, or slower than a tick). */
  behind: boolean;
  minimumLookaheadMs: number | null;
  blockedRequests: number;
}

export interface FaceMeshControllerOptions {
  baseUrl: string;
  simd: boolean;
  device: DeviceClass;
  overlay: HTMLCanvasElement;
  style: MeshStyleId;
  onStatus(status: FaceMeshStatus): void;
  createClient?(
    events: FaceMeshClientEvents
  ): Pick<
    FaceMeshClient,
    "state" | "ready" | "restarts" | "captureFrame" | "check" | "wasmMemoryBytes" | "roundTripP50Ms" | "destroy"
  >;
}

// Readout windows.
const RECENT_FRAMES_MS = 1000;
const RECENT_TICKS_MS = 5000;
// Tick-driven readout updates at most this often (each one re-renders the app).
const STATUS_INTERVAL_MS = 500;
const BEHIND_SKIPPED_SHARE = 0.2;
const DEFAULT_FRAME_INTERVAL_MS = 40;

/**
 * The "Face mesh" demo switch while it is on: runs the face mesh on each
 * detection tick and draws it on the overlay, smoothly where the lookahead
 * allows. Nothing here changes what Vertix decides. Construct to switch on,
 * stop() to switch off: then no worker, no observer, no overlay renderer,
 * no 16:9 detection and no minimum lookahead remain.
 */
export class FaceMeshController {
  readonly bench: FaceMeshBenchRecorder;
  private readonly client: ReturnType<NonNullable<FaceMeshControllerOptions["createClient"]>>;
  private readonly timeline = new MeshTimeline();
  private readonly latency = new MeshLatency();
  private readonly stopObserving: () => void;
  private style: MeshStyleId;
  private edges: MeshEdges | null = null;
  private appliedMinimumMs: number | null = null;
  private lastFrameAt: number | null = null;
  private loadingSinceMs: number | null = performance.now();
  private reason: string | null = null;
  private blockedRequests = 0;
  private recentFrames: { at: number; interpolated: boolean }[] = [];
  private recentTicks: { at: number; skipped: boolean }[] = [];
  private drawScratch = { points: new Float32Array(0) };
  private lastDrawnSec: number | null = null;
  private lastStatusAt = -Infinity;
  private stopped = false;

  constructor(
    private readonly engine: FaceMeshEngine,
    private readonly options: FaceMeshControllerOptions
  ) {
    this.style = options.style;
    const events: FaceMeshClientEvents = {
      onStateChange: (state, reason) => this.onStateChange(state, reason),
      onCheck: (check) => this.timeline.addCheck(check),
      onCut: (mediaTimeSec) => this.timeline.addCut(mediaTimeSec),
      onTick: (record) => this.onTick(record),
      onBlocked: (host) => {
        this.blockedRequests += 1;
        this.bench.recordBlocked(host);
        this.emitStatus();
      },
    };
    this.client = options.createClient?.(events) ?? new FaceMeshClient(options.baseUrl, options.simd, events);
    this.bench = new FaceMeshBenchRecorder({
      lookahead: () => this.engine.getLookaheadLengths(),
      init: () => {
        const ready = this.client.ready;
        return ready
          ? { simd: ready.simd, downloadMs: ready.downloadMs, loadMs: ready.loadMs, assets: ready.assets }
          : null;
      },
      wasmMemoryBytes: () => this.client.wasmMemoryBytes(),
      workerRestarts: () => this.client.restarts,
    });
    this.stopObserving = engine.observeDetections({
      onFrame: (source, mediaTimeSec) => {
        const now = performance.now();
        if (this.lastFrameAt !== null) this.latency.recordTickInterval(now - this.lastFrameAt);
        this.lastFrameAt = now;
        this.client.captureFrame(source, mediaTimeSec);
      },
      onTick: (tick) => this.client.check(tick),
    });
    engine.setSourceViewDetection(true);
    engine.setOverlayRenderer(options.overlay, (frame) => this.render(frame));
    this.emitStatus();
  }

  setStyle(style: MeshStyleId): void {
    this.style = style;
  }

  /** After a seek, a mode switch or a new source: nothing from before is drawn or interpolated. */
  reset(): void {
    this.timeline.clear();
    this.lastFrameAt = null;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopObserving();
    this.engine.setOverlayRenderer(null, null);
    this.engine.setSourceViewDetection(false);
    this.engine.setMinimumLookaheadMs(null);
    this.client.destroy();
    this.timeline.clear();
  }

  private onStateChange(state: FaceMeshState, reason: string | null): void {
    this.reason = reason;
    if (state === "loading") this.loadingSinceMs ??= performance.now();
    else this.loadingSinceMs = null;
    if (state === "ready" && this.client.ready) {
      this.edges = { tessellation: this.client.ready.tessellation, contours: this.client.ready.contours };
    }
    if (state === "failed") {
      this.engine.setMinimumLookaheadMs(null);
      this.engine.setSourceViewDetection(false);
      this.appliedMinimumMs = null;
    }
    this.emitStatus();
  }

  private onTick(record: FaceMeshTickRecord): void {
    const now = performance.now();
    this.bench.recordTick(record);
    this.recentTicks.push({ at: now, skipped: record.outcome === "skipped" });
    this.recentTicks = this.recentTicks.filter((t) => now - t.at <= RECENT_TICKS_MS);
    if (record.outcome !== "checked" || record.resultAgeMs === null) return;
    this.latency.recordResultAge(record.resultAgeMs);
    const frameMs = this.engine.getMetrics().frameTimeMs || DEFAULT_FRAME_INTERVAL_MS;
    const minimum = nextMinimumMs(this.appliedMinimumMs, this.latency.minimumMs(frameMs, this.options.device));
    if (minimum !== this.appliedMinimumMs) {
      this.appliedMinimumMs = minimum;
      this.engine.setMinimumLookaheadMs(minimum);
    }
    if (now - this.lastStatusAt >= STATUS_INTERVAL_MS) this.emitStatus();
  }

  private render(frame: OverlayFrame): void {
    if (!this.edges || this.client.state !== "ready") return;
    const start = performance.now();
    const meshes = this.timeline.meshesAt(frame.mediaTimeSec);
    drawMeshes(frame, meshes, this.edges, MESH_STYLES[this.style], this.drawScratch);
    const drawMs = performance.now() - start;
    const kinds: ShownMeshKind[] = meshes.map((m) => m.kind);
    const afterCut = this.lastDrawnSec !== null && this.timeline.cutBetween(this.lastDrawnSec, frame.mediaTimeSec);
    this.lastDrawnSec = frame.mediaTimeSec;
    this.bench.recordFrame(
      frame.mediaTimeSec,
      meshes.map((m) => m.trackId),
      kinds,
      drawMs,
      afterCut
    );
    if (meshes.length > 0) {
      this.recentFrames.push({ at: start, interpolated: kinds.every((k) => k === "interpolated") });
    }
  }

  private emitStatus(): void {
    const now = performance.now();
    this.lastStatusAt = now;
    this.recentFrames = this.recentFrames.filter((f) => now - f.at <= RECENT_FRAMES_MS);
    const interpolatedShare =
      this.recentFrames.length > 0
        ? this.recentFrames.filter((f) => f.interpolated).length / this.recentFrames.length
        : null;
    const skippedShare =
      this.recentTicks.length > 0 ? this.recentTicks.filter((t) => t.skipped).length / this.recentTicks.length : 0;
    const roundTrip = this.client.roundTripP50Ms;
    const tickInterval = this.latency.tickIntervalP50Ms;
    this.options.onStatus({
      state: this.client.state,
      reason: this.reason,
      loadingSinceMs: this.client.state === "loading" ? this.loadingSinceMs : null,
      mode: interpolatedShare === null ? null : interpolatedShare >= 0.5 ? "interpolated" : "steps",
      behind:
        skippedShare > BEHIND_SKIPPED_SHARE ||
        (roundTrip !== null && tickInterval !== null && roundTrip > tickInterval),
      minimumLookaheadMs: this.appliedMinimumMs,
      blockedRequests: this.blockedRequests,
    });
  }
}
