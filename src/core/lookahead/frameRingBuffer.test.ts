import { describe, expect, it } from "vitest";
import { FrameRingBuffer, type BufferedFrame } from "./frameRingBuffer";

interface TestSlot {
  id: number;
  bytes: number;
}

function setUp(maxSlots = 4, budgetBytes = Number.POSITIVE_INFINITY) {
  let created = 0;
  const size = { bytes: 1 };
  const buffer = new FrameRingBuffer<TestSlot>(
    {
      create: () => ({ id: created++, bytes: size.bytes }),
      bytesPerNewSlot: () => size.bytes,
      bytesOf: (slot) => slot.bytes,
      isCurrent: (slot) => slot.bytes === size.bytes,
    },
    maxSlots,
    budgetBytes
  );
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
  const upTo = (sec: number) => (f: BufferedFrame<TestSlot>) => f.mediaTimeSec <= sec;
  return { buffer, capture, upTo, size, created: () => created };
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

  it("stays within the byte budget", () => {
    const { buffer, capture } = setUp(10, 3);
    for (let i = 1; i <= 5; i++) capture(i);
    expect(buffer.allocatedSlots).toBe(3);
    expect(buffer.allocatedBytes).toBe(3);
    expect(buffer.overflowDrops).toBe(2);
  });

  describe("720p -> 540p copies at the 96 MiB budget limit", () => {
    const BUDGET = 96 * 1024 * 1024;
    const BYTES_720 = 1280 * 720 * 4;
    const BYTES_540 = 960 * 540 * 4;

    /** Plays `frames` frames at `fps`, each shown `delayFrames(t)` frames after capture; returns the frames shown. */
    function playThrough(
      env: ReturnType<typeof setUp>,
      from: number,
      frames: number,
      delayFrames: (i: number) => number
    ) {
      const shown: number[] = [];
      for (let i = from; i < from + frames; i++) {
        env.capture(i);
        const due = env.buffer.takeLatest(env.upTo(i - delayFrames(i)));
        if (due) {
          shown.push(due.mediaTimeSec);
          env.buffer.release(due);
        }
      }
      return shown;
    }

    it("same delay: old copies are swapped one for one, no frame dropped, never over the budget", () => {
      const env = setUp(Math.floor(BUDGET / BYTES_720), BUDGET);
      env.size.bytes = BYTES_720;
      // 26 frames waiting + the one being captured: 27 slots of 720p, the most the budget holds.
      playThrough(env, 0, 100, () => 26);
      expect(env.buffer.allocatedSlots).toBe(27);
      env.size.bytes = BYTES_540;
      env.buffer.setMaxSlots(27);
      playThrough(env, 100, 100, () => 26);
      expect(env.buffer.overflowDrops).toBe(0);
      expect(env.buffer.peakAllocatedBytes).toBeLessThanOrEqual(BUDGET);
      expect(env.buffer.allocatedBytes).toBeLessThanOrEqual(27 * BYTES_540);
      console.log(
        `720p -> 540p, same delay: peak ${env.buffer.peakAllocatedBytes} B of ${BUDGET} B, overflow ${env.buffer.overflowDrops}`
      );
    });

    it("delay growing at the switch: drops the oldest waiting frames rather than going over the budget", () => {
      const env = setUp(Math.floor(BUDGET / BYTES_720), BUDGET);
      env.size.bytes = BYTES_720;
      playThrough(env, 0, 100, () => 26);
      env.size.bytes = BYTES_540;
      env.buffer.setMaxSlots(42);
      // The delay grows to 40 frames at once: more frames must wait than the old copies leave room for.
      const shown = playThrough(env, 100, 200, () => 40);
      expect(env.buffer.peakAllocatedBytes).toBeLessThanOrEqual(BUDGET);
      expect(env.buffer.overflowDrops).toBeGreaterThan(0);
      for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThan(shown[i - 1]);
      // Once the old copies are gone, the 40-frame delay fits in 540p copies.
      expect(env.buffer.allocatedBytes).toBe(env.buffer.allocatedSlots * BYTES_540);
      console.log(
        `720p -> 540p, delay 26 -> 40: peak ${env.buffer.peakAllocatedBytes} B of ${BUDGET} B, overflow ${env.buffer.overflowDrops}`
      );
    });
  });

  describe("takeNearest", () => {
    it("takes the frame at the due time", () => {
      const { buffer, capture } = setUp();
      capture(1.0);
      capture(1.02);
      capture(1.04);
      expect(buffer.takeNearest(1.02, 0.02, true)?.mediaTimeSec).toBe(1.02);
      expect(buffer.skippedOnDisplay).toBe(1);
    });

    it("waits when the due frame is not there yet and the screen is not behind", () => {
      const { buffer, capture } = setUp();
      capture(1.02);
      expect(buffer.takeNearest(1.0, 0.02, false)).toBeNull();
    });

    it("never shows a frame early at the start (nothing shown yet)", () => {
      const { buffer, capture } = setUp();
      capture(1.02);
      capture(1.04);
      expect(buffer.takeNearest(1.0, 0.02, false)).toBeNull();
    });

    it("when the due frame was never captured and the screen is behind, takes the newer frame on a tie", () => {
      const { buffer, capture } = setUp();
      capture(0.98);
      capture(1.02);
      expect(buffer.takeNearest(1.0, 0.02, true)?.mediaTimeSec).toBe(1.02);
    });

    it("takes the nearer earlier frame when the newer one is further", () => {
      const { buffer, capture } = setUp();
      capture(0.99);
      capture(1.02);
      expect(buffer.takeNearest(1.0, 0.02, true)?.mediaTimeSec).toBe(0.99);
    });

    it("never takes a frame more than one frame newer", () => {
      const { buffer, capture } = setUp();
      capture(1.06);
      expect(buffer.takeNearest(1.0, 0.02, true)).toBeNull();
    });
  });
});
