import { describe, expect, it } from "vitest";
import { FrameRingBuffer } from "./frameRingBuffer";

function setUp(maxSlots = 4) {
  let created = 0;
  const buffer = new FrameRingBuffer(() => ({ id: created++ }), maxSlots);
  let frameIndex = 0;
  const capture = (mediaTimeSec: number, dueMs: number) => {
    const slot = buffer.acquire();
    const frame = { slot, mediaTimeSec, dueMs, frameIndex: ++frameIndex };
    buffer.enqueue(frame);
    return frame;
  };
  return { buffer, capture, created: () => created };
}

describe("FrameRingBuffer", () => {
  it("holds a frame until its due time", () => {
    const { buffer, capture } = setUp();
    capture(1.0, 1200);
    expect(buffer.takeDue(1199)).toBeNull();
    expect(buffer.takeDue(1200)?.mediaTimeSec).toBe(1.0);
    expect(buffer.length).toBe(0);
  });

  it("returns the latest due frame and counts the older ones as skipped", () => {
    const { buffer, capture } = setUp();
    capture(1.0, 100);
    capture(1.04, 140);
    capture(1.08, 180);
    expect(buffer.takeDue(150)?.mediaTimeSec).toBe(1.04);
    expect(buffer.skippedOnDisplay).toBe(1);
    expect(buffer.length).toBe(1);
  });

  it("reuses released slots instead of allocating", () => {
    const { buffer, capture, created } = setUp();
    for (let i = 0; i < 10; i++) {
      capture(i, i);
      buffer.release(buffer.takeDue(i)!);
    }
    expect(created()).toBe(1);
  });

  it("drops the oldest waiting frame when every slot is in use", () => {
    const { buffer, capture } = setUp(2);
    capture(1, 100);
    capture(2, 200);
    capture(3, 300);
    expect(buffer.overflowDrops).toBe(1);
    expect(buffer.allocatedSlots).toBe(2);
    expect(buffer.takeDue(1000)?.mediaTimeSec).toBe(3);
  });

  it("flush on seek drops every waiting frame and keeps the slots for reuse", () => {
    const { buffer, capture, created } = setUp();
    capture(1, 100);
    capture(2, 200);
    buffer.flush();
    expect(buffer.length).toBe(0);
    expect(buffer.takeDue(Infinity)).toBeNull();
    capture(10, 1000);
    capture(11, 1040);
    expect(created()).toBe(2);
  });

  it("holds a paused frame until released, then shows it", () => {
    const { buffer, capture } = setUp();
    capture(5, Infinity);
    expect(buffer.takeDue(1e12)).toBeNull();
    buffer.releaseHeld(500);
    expect(buffer.takeDue(500)?.mediaTimeSec).toBe(5);
  });

  it("finds a waiting frame by media time", () => {
    const { buffer, capture } = setUp();
    capture(1, 100);
    capture(1.04, 140);
    expect(buffer.find(1.04)?.dueMs).toBe(140);
    expect(buffer.find(2)).toBeNull();
  });
});
