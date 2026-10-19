import { summarize, type BenchmarkClipExtension, type LookaheadLengths, type SampleSummary } from "../../core";
import type { FaceMeshAssetTiming } from "./faceMeshProtocol";
import type { FaceMeshTickRecord } from "./FaceMeshClient";
import type { ShownMeshKind } from "./meshTimeline";

/** What one displayed frame showed: the "worst" kind of its meshes, or "empty". */
export type MeshFrameKind = ShownMeshKind | "empty";

const KIND_ORDER: MeshFrameKind[] = ["empty", "held", "stepped", "interpolated"];

/** One kind per frame: empty without meshes, else held over stepped over interpolated. */
export function frameKindOf(kinds: readonly ShownMeshKind[]): MeshFrameKind {
  if (kinds.length === 0) return "empty";
  return kinds.reduce<MeshFrameKind>(
    (worst, kind) => (KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(worst) ? kind : worst),
    "interpolated"
  );
}

/** The "faceMesh" block of a benchmark run (schema v7, BenchmarkClipResult.extensions.faceMesh). */
export interface FaceMeshBenchBlock {
  landmark: {
    /** Face Landmarker time per face, in the worker. */
    perFaceMs: SampleSummary;
    /** Crops sent until the meshes came back, per tick. */
    perTickMs: SampleSummary;
    /** Frame sent to detection until its meshes came back. */
    resultAgeMs: SampleSummary;
    checkedTicks: number;
    skippedTicks: number;
    frameMismatches: number;
    facesPerCheckedTick: number | null;
    /** Share of checked faces with no mesh (turned heads). */
    noMeshShare: number | null;
    workerRestarts: number;
  };
  drawMs: SampleSummary;
  /** Share of displayed frames by what they showed. */
  frames: { displayed: number } & Record<MeshFrameKind, number>;
  /** A track's mesh appearing or disappearing on screen, per minute of displayed media time. */
  flickerEventsPerMinute: number | null;
  lookahead: LookaheadLengths;
  init: { simd: boolean; downloadMs: number; loadMs: number; assets: FaceMeshAssetTiming[] } | null;
  wasmMemoryBytes: number | null;
  /** Requests the network guard stopped (should stay 0 on screen; MediaPipe's metrics logger is expected here). */
  blockedRequests: { count: number; hosts: string[] };
}

export interface FaceMeshBenchSources {
  lookahead(): LookaheadLengths;
  init(): FaceMeshBenchBlock["init"];
  wasmMemoryBytes(): Promise<number | null>;
  workerRestarts(): number;
}

/** Records the face mesh measurements of one benchmark run; only created while the switch is on. */
export class FaceMeshBenchRecorder implements BenchmarkClipExtension {
  readonly key = "faceMesh";
  private recording = false;
  private warmupSec = 0;
  private restartsAtStart = 0;
  private perFace: number[] = [];
  private perTick: number[] = [];
  private resultAges: number[] = [];
  private draws: number[] = [];
  private checked = 0;
  private skipped = 0;
  private mismatches = 0;
  private faces = 0;
  private noMesh = 0;
  private kinds: Record<MeshFrameKind, number> = { interpolated: 0, stepped: 0, held: 0, empty: 0 };
  private flickerEvents = 0;
  private visible = new Set<number>();
  private firstFrameSec: number | null = null;
  private lastFrameSec: number | null = null;
  private blockedHosts: string[] = [];

  constructor(private readonly sources: FaceMeshBenchSources) {}

  start({ warmupSec }: { warmupSec: number }): void {
    this.recording = true;
    this.warmupSec = warmupSec;
    this.restartsAtStart = this.sources.workerRestarts();
    this.perFace = [];
    this.perTick = [];
    this.resultAges = [];
    this.draws = [];
    this.checked = this.skipped = this.mismatches = this.faces = this.noMesh = this.flickerEvents = 0;
    this.kinds = { interpolated: 0, stepped: 0, held: 0, empty: 0 };
    this.visible = new Set();
    this.firstFrameSec = this.lastFrameSec = null;
    this.blockedHosts = [];
  }

  recordTick(record: FaceMeshTickRecord): void {
    if (!this.recording || record.mediaTimeSec < this.warmupSec) return;
    if (record.outcome === "skipped") this.skipped += 1;
    else if (record.outcome === "mismatch") this.mismatches += 1;
    else {
      this.checked += 1;
      this.faces += record.faces;
      this.noMesh += record.faces - record.meshesFound;
      this.perFace.push(...record.landmarkerMs);
      if (record.roundTripMs !== null) this.perTick.push(record.roundTripMs);
      if (record.resultAgeMs !== null) this.resultAges.push(record.resultAgeMs);
    }
  }

  recordFrame(
    mediaTimeSec: number,
    trackIds: readonly number[],
    kinds: readonly ShownMeshKind[],
    drawMs: number
  ): void {
    if (!this.recording || mediaTimeSec < this.warmupSec) return;
    this.firstFrameSec ??= mediaTimeSec;
    this.lastFrameSec = mediaTimeSec;
    this.draws.push(drawMs);
    this.kinds[frameKindOf(kinds)] += 1;
    const now = new Set(trackIds);
    for (const id of now) if (!this.visible.has(id)) this.flickerEvents += 1;
    for (const id of this.visible) if (!now.has(id)) this.flickerEvents += 1;
    this.visible = now;
  }

  recordBlocked(host: string): void {
    if (this.recording) this.blockedHosts.push(host);
  }

  async finish(): Promise<FaceMeshBenchBlock> {
    this.recording = false;
    const displayed = Object.values(this.kinds).reduce((a, b) => a + b, 0);
    const share = (n: number) => (displayed > 0 ? n / displayed : 0);
    const minutes =
      this.firstFrameSec !== null && this.lastFrameSec !== null ? (this.lastFrameSec - this.firstFrameSec) / 60 : 0;
    return {
      landmark: {
        perFaceMs: summarize(this.perFace),
        perTickMs: summarize(this.perTick),
        resultAgeMs: summarize(this.resultAges),
        checkedTicks: this.checked,
        skippedTicks: this.skipped,
        frameMismatches: this.mismatches,
        facesPerCheckedTick: this.checked > 0 ? this.faces / this.checked : null,
        noMeshShare: this.faces > 0 ? this.noMesh / this.faces : null,
        workerRestarts: this.sources.workerRestarts() - this.restartsAtStart,
      },
      drawMs: summarize(this.draws),
      frames: {
        displayed,
        interpolated: share(this.kinds.interpolated),
        stepped: share(this.kinds.stepped),
        held: share(this.kinds.held),
        empty: share(this.kinds.empty),
      },
      flickerEventsPerMinute: minutes > 0 ? this.flickerEvents / minutes : null,
      lookahead: this.sources.lookahead(),
      init: this.sources.init(),
      wasmMemoryBytes: await this.sources.wasmMemoryBytes(),
      blockedRequests: { count: this.blockedHosts.length, hosts: [...new Set(this.blockedHosts)] },
    };
  }
}
