import { describe, expect, it } from "vitest";
import { FrameRingBuffer, type BufferedFrame } from "./frameRingBuffer";

function setUp(maxSlots = 4) {
  let created = 0;
  const buffer = new FrameRingBuffer(() => ({ id: created++ }), maxSlots);
  let frameIndex = 0;
  const capture = (mediaTimeSec: number, held = false) => {
    const slot = buffer.acquire();
    const frame = {
      slot,
      mediaTimeSec,
      presentedAtMs: mediaTimeSec * 1000,
      frameIndex: ++frameIndex,
      held,
      forced: false,
    };
    buffer.enqueue(frame);
    return frame;
  };
  const upTo = (sec: number) => (f: BufferedFrame<{ id: number }>) => f.mediaTimeSec <= sec;
  return { buffer, capture, upTo, created: () => created };
}

describe("FrameRingBuffer", () => {
  it("returns the latest due frame and counts the older ones as skipped", () => {
    const { buffer, capture, upTo } = setUp();
    capture(1.0);
    capture(1.04);
    capture(1.08);
    expect(buffer.takeLatest(upTo(0.9))).toBeNull();
    expect(buffer.takeLatest(upTo(1.05))?.mediaTimeSec).toBe(1.04);
    expect(buffer.skippedOnDisplay).toBe(1);
    expect(buffer.length).toBe(1);
  });

  it("reuses released slots instead of allocating", () => {
    const { buffer, capture, upTo, created } = setUp();
    for (let i = 0; i < 10; i++) {
      capture(i);
      buffer.release(buffer.takeLatest(upTo(i))!);
    }
    expect(created()).toBe(1);
  });

  it("drops the oldest waiting frame when every slot is in use", () => {
    const { buffer, capture, upTo } = setUp(2);
    capture(1);
    capture(2);
    capture(3);
    expect(buffer.overflowDrops).toBe(1);
    expect(buffer.allocatedSlots).toBe(2);
    expect(buffer.takeLatest(upTo(10))?.mediaTimeSec).toBe(3);
  });

  it("flush on seek drops every waiting frame and keeps the slots for reuse", () => {
    const { buffer, capture, upTo, created } = setUp();
    capture(1);
    capture(2);
    buffer.flush();
    expect(buffer.length).toBe(0);
    expect(buffer.takeLatest(upTo(Infinity))).toBeNull();
    capture(10);
    capture(11);
    expect(created()).toBe(2);
  });

  it("holds a paused frame until released, then shows it whatever its time", () => {
    const { buffer, capture, upTo } = setUp();
    capture(5, true);
    expect(buffer.takeLatest(upTo(Infinity))).toBeNull();
    buffer.releaseHeld();
    expect(buffer.takeLatest(upTo(0))?.mediaTimeSec).toBe(5);
  });

  it("finds a waiting frame by media time", () => {
    const { buffer, capture } = setUp();
    capture(1);
    capture(1.04);
    expect(buffer.find(1.04)?.frameIndex).toBe(2);
    expect(buffer.find(2)).toBeNull();
  });

  it("grows without dropping waiting frames", () => {
    const { buffer, capture } = setUp(2);
    capture(1);
    capture(2);
    buffer.setMaxSlots(4);
    capture(3);
    capture(4);
    expect(buffer.overflowDrops).toBe(0);
    expect(buffer.length).toBe(4);
  });

  it("shrinks as frames are released, without dropping waiting frames", () => {
    const { buffer, capture, upTo } = setUp(4);
    for (let i = 1; i <= 4; i++) capture(i);
    buffer.setMaxSlots(2);
    expect(buffer.length).toBe(4);
    expect(buffer.allocatedSlots).toBe(4);
    buffer.release(buffer.takeLatest(upTo(2))!);
    expect(buffer.allocatedSlots).toBe(2);
    expect(buffer.length).toBe(2);
  });
});
