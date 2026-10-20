import { describe, expect, it, vi } from "vitest";
import type { DetectionObserver, LookaheadLengths, OverlayFrame, OverlayRenderer } from "../../core";
import { FaceMeshController, type FaceMeshEngine, type FaceMeshStatus } from "./FaceMeshController";
import type { FaceMeshClientEvents, FaceMeshState, FaceMeshTickRecord } from "./FaceMeshClient";
import type { FaceMeshReadyMessage } from "./faceMeshProtocol";
import { MESH_LOOKAHEAD_MIN_SAMPLES } from "./meshLookahead";

vi.stubGlobal(
  "Path2D",
  class {
    moveTo() {}
    lineTo() {}
  }
);

function fakeEngine() {
  const calls: string[] = [];
  let observer: DetectionObserver | null = null;
  let renderer: OverlayRenderer | null = null;
  let minimumMs: number | null = null;
  const engine: FaceMeshEngine = {
    observeDetections: (o) => {
      observer = o;
      calls.push("observe");
      return () => {
        observer = null;
        calls.push("unobserve");
      };
    },
    setOverlayRenderer: (canvas, r) => {
      renderer = r;
      calls.push(`renderer:${canvas ? "on" : "off"}`);
    },
    setSourceViewDetection: (enabled) => calls.push(`sourceView:${enabled}`),
    setMinimumLookaheadMs: (ms) => {
      minimumMs = ms;
      calls.push(`minimum:${ms}`);
    },
    getLookaheadLengths: (): LookaheadLengths => ({ lengthMs: 320, baseLengthMs: 160, minimumMs }),
    getMetrics: () => ({ frameTimeMs: 40 }) as ReturnType<FaceMeshEngine["getMetrics"]>,
  };
  return {
    engine,
    calls,
    observer: () => observer,
    renderer: () => renderer,
    minimumMs: () => minimumMs,
  };
}

function fakeClient() {
  let events: FaceMeshClientEvents | null = null;
  const client = {
    state: "loading" as FaceMeshState,
    ready: null as FaceMeshReadyMessage | null,
    restarts: 0,
    destroyed: false,
    captureFrame: vi.fn(),
    check: vi.fn(),
    wasmMemoryBytes: () => Promise.resolve(1024),
    roundTripP50Ms: 40,
    destroy() {
      this.destroyed = true;
    },
  };
  return {
    client,
    create: (e: FaceMeshClientEvents) => {
      events = e;
      return client;
    },
    events: () => events!,
    becomeReady() {
      client.state = "ready";
      client.ready = {
        type: "ready",
        simd: true,
        downloadMs: 10,
        loadMs: 20,
        assets: [],
        tessellation: new Uint16Array([0, 1]),
        contours: new Uint16Array([0, 1]),
      };
      events!.onStateChange("ready", null);
    },
  };
}

const checkedTick = (mediaTimeSec: number): FaceMeshTickRecord => ({
  mediaTimeSec,
  outcome: "checked",
  faces: 1,
  resultAgeMs: 60,
  roundTripMs: 40,
  landmarkerMs: [19],
  meshesFound: 1,
});

function setUp(device: "desktop" | "mobile" = "desktop") {
  const engine = fakeEngine();
  const client = fakeClient();
  const statuses: FaceMeshStatus[] = [];
  const controller = new FaceMeshController(engine.engine, {
    baseUrl: "https://example.test/vertix/",
    simd: true,
    device,
    overlay: {} as HTMLCanvasElement,
    style: "cyan",
    onStatus: (s) => statuses.push(s),
    createClient: client.create,
  });
  /** Detection frames 0.2 s apart (wall time too), each checked. */
  const ticks = (count: number) => {
    for (let i = 0; i < count; i++) {
      vi.advanceTimersByTime(200);
      engine.observer()!.onFrame!({} as OffscreenCanvas, i * 0.2);
      client.events().onTick(checkedTick(i * 0.2));
    }
  };
  return { engine, client, controller, statuses, ticks };
}

describe("FaceMeshController", () => {
  it("on: observes detections, draws on the overlay and detects in 16:9; off: undoes all of it, with no minimum lookahead", () => {
    const { engine, client, controller } = setUp();
    expect(engine.calls).toEqual(["observe", "sourceView:true", "renderer:on"]);
    controller.stop();
    expect(engine.calls.slice(3)).toEqual(["unobserve", "renderer:off", "sourceView:false", "minimum:null"]);
    expect(client.client.destroyed).toBe(true);
    expect(engine.observer()).toBeNull();
  });

  it("on desktop, sets the minimum lookahead from measured latency once there is enough of it", () => {
    vi.useFakeTimers();
    const { engine, client, ticks } = setUp();
    client.becomeReady();
    ticks(MESH_LOOKAHEAD_MIN_SAMPLES);
    expect(engine.minimumMs()).toBeNull();
    ticks(1);
    // 200 ms tick interval + 60 ms result age + one 40 ms frame + 30 ms margin.
    expect(engine.minimumMs()).toBe(330);
    vi.useRealTimers();
  });

  it("on a phone, never raises the lookahead", () => {
    vi.useFakeTimers();
    const { engine, client, ticks } = setUp("mobile");
    client.becomeReady();
    ticks(30);
    expect(engine.calls.some((c) => c.startsWith("minimum:") && c !== "minimum:null")).toBe(false);
    vi.useRealTimers();
  });

  it("drops the minimum and the 16:9 detection when loading fails", () => {
    vi.useFakeTimers();
    const { engine, client, ticks, statuses } = setUp();
    client.becomeReady();
    ticks(MESH_LOOKAHEAD_MIN_SAMPLES + 1);
    expect(engine.minimumMs()).toBe(330);
    client.events().onStateChange("failed", "timeout");
    expect(engine.minimumMs()).toBeNull();
    expect(engine.calls.at(-1)).toBe("sourceView:false");
    expect(statuses.at(-1)).toMatchObject({ reason: "timeout", minimumLookaheadMs: null });
    vi.useRealTimers();
  });

  it("draws nothing before the face mesh is ready, then the mesh of the frame on screen", () => {
    const { engine, client } = setUp();
    const strokes: number[] = [];
    const ctx = {
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      stroke: () => strokes.push(1),
    } as unknown as CanvasRenderingContext2D;
    const frame: OverlayFrame = {
      ctx,
      width: 405,
      height: 720,
      mediaTimeSec: 1.05,
      srcW: 1280,
      srcH: 720,
      views: [{ source: { x: 0, y: 0, w: 405, h: 720 }, dest: { x: 0, y: 0, w: 405, h: 720 } }],
    };
    client.events().onCheck({ mediaTimeSec: 1, meshes: new Map([[1, new Float32Array([0.1, 0.1, 0.2, 0.2])]]) });
    engine.renderer()!(frame);
    expect(strokes).toHaveLength(0);
    client.becomeReady();
    engine.renderer()!({ ...frame, mediaTimeSec: 1.2 });
    expect(strokes).toHaveLength(2);
  });

  it("counts requests the network guard stopped", () => {
    const { client, statuses } = setUp();
    client.events().onBlocked("odml.pa.googleapis.com", "fetch");
    expect(statuses.at(-1)!.blockedRequests).toBe(1);
  });
});
