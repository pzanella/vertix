import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let failDraw = false;
const posted: Record<string, unknown>[] = [];
const workerScope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: never) => void } = {
  onmessage: null,
  postMessage: (message) => posted.push(message),
};

vi.stubGlobal("self", workerScope);
vi.stubGlobal(
  "OffscreenCanvas",
  class {
    constructor(
      public width: number,
      public height: number
    ) {}
    getContext() {
      return {
        drawImage() {
          if (failDraw) throw new DOMException("cannot draw", "InvalidStateError");
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
    posted.length = 0;
    failDraw = false;
  });

  it("scores a bitmap, closes it, and echoes the generation", () => {
    const bitmap = { close: vi.fn() };
    send({ type: "score", generation: 3, frameId: 7, bitmap });
    expect(bitmap.close).toHaveBeenCalled();
    expect(posted).toEqual([expect.objectContaining({ generation: 3, frameId: 7, failed: false })]);
  });

  it("closes the bitmap and reports the failure when it cannot be drawn", () => {
    const bitmap = { close: vi.fn() };
    failDraw = true;
    send({ type: "score", generation: 1, frameId: 2, bitmap });
    expect(bitmap.close).toHaveBeenCalled();
    expect(posted).toEqual([expect.objectContaining({ frameId: 2, failed: true })]);
  });
});
