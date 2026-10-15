import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class FakeVideoFrame {
  closed = false;
  close() {
    this.closed = true;
  }
}

const drawn: unknown[] = [];
let failDraw = false;
const posted: Record<string, unknown>[] = [];
const workerScope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: never) => void } = {
  onmessage: null,
  postMessage: (message) => posted.push(message),
};

vi.stubGlobal("self", workerScope);
vi.stubGlobal("VideoFrame", FakeVideoFrame);
vi.stubGlobal(
  "OffscreenCanvas",
  class {
    constructor(
      public width: number,
      public height: number
    ) {}
    getContext() {
      return {
        imageSmoothingQuality: "low",
        drawImage(source: unknown) {
          if (failDraw) throw new DOMException("cannot draw", "InvalidStateError");
          drawn.push(source);
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      };
    }
  }
);

const send = (data: object) => workerScope.onmessage!({ data });

describe("cutTriggerWorker", () => {
  beforeAll(async () => {
    await import("./cutTriggerWorker");
  });
  beforeEach(() => {
    drawn.length = 0;
    posted.length = 0;
    failDraw = false;
  });

  it("scores a VideoFrame, closes it, and echoes the generation", () => {
    const frame = new FakeVideoFrame();
    send({ type: "score", generation: 3, frameId: 7, source: frame });
    expect(frame.closed).toBe(true);
    expect(posted).toEqual([
      expect.objectContaining({ generation: 3, frameId: 7, wasVideoFrame: true, failed: false }),
    ]);
    // Scaled on a GPU canvas first, then read back small.
    expect(drawn[0]).toBe(frame);
    expect(drawn).toHaveLength(2);
  });

  it("closes the VideoFrame and reports the failure when it cannot be drawn", () => {
    const frame = new FakeVideoFrame();
    failDraw = true;
    send({ type: "score", generation: 1, frameId: 2, source: frame });
    expect(frame.closed).toBe(true);
    expect(posted).toEqual([expect.objectContaining({ frameId: 2, wasVideoFrame: true, failed: true })]);
  });

  it("scores and closes a bitmap", () => {
    const bitmap = { close: vi.fn() };
    send({ type: "score", generation: 1, frameId: 3, source: bitmap });
    expect(bitmap.close).toHaveBeenCalled();
    expect(posted).toEqual([expect.objectContaining({ frameId: 3, wasVideoFrame: false, failed: false })]);
  });
});
