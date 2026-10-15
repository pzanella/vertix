import { describe, expect, it } from "vitest";
import { STEP_UP_AFTER_MS, SlotHeightGovernor } from "./slotHeightGovernor";

/** Feeds readings every 300 ms for `ms`, with `dropShare` of the frames dropped. */
function play(
  governor: SlotHeightGovernor,
  state: { now: number; total: number; dropped: number },
  options: {
    ms: number;
    fps: number;
    dropShare: number;
    overflowDrops?: number;
  }
) {
  const reasons: string[] = [];
  for (let t = 0; t < options.ms; t += 300) {
    state.now += 300;
    const frames = (options.fps * 300) / 1000;
    state.total += frames;
    state.dropped += frames * options.dropShare;
    const reason = governor.update(
      state.now,
      options.fps,
      { droppedVideoFrames: state.dropped, totalVideoFrames: state.total },
      options.overflowDrops ?? 0
    );
    if (reason) reasons.push(reason);
  }
  return reasons;
}

const start = () => ({ now: 0, total: 0, dropped: 0 });

describe("SlotHeightGovernor", () => {
  it("keeps full height at 50 fps while few frames are dropped", () => {
    const governor = new SlotHeightGovernor();
    expect(play(governor, start(), { ms: 20_000, fps: 50, dropShare: 0.03 })).toEqual([]);
    expect(governor.reduced).toBe(false);
  });

  it("never reduces at 30 fps or less, whatever the drops", () => {
    const governor = new SlotHeightGovernor();
    play(governor, start(), { ms: 10_000, fps: 25, dropShare: 0.3, overflowDrops: 5 });
    expect(governor.reduced).toBe(false);
  });

  it("reduces above 30 fps when more than 5% of frames are dropped over a few seconds", () => {
    const governor = new SlotHeightGovernor();
    expect(play(governor, start(), { ms: 4000, fps: 50, dropShare: 0.1 })).toEqual(["drops"]);
    expect(governor.reduced).toBe(true);
  });

  it("reduces at once when the buffer overflows above 30 fps", () => {
    const governor = new SlotHeightGovernor();
    const state = start();
    play(governor, state, { ms: 600, fps: 50, dropShare: 0 });
    expect(play(governor, state, { ms: 300, fps: 50, dropShare: 0, overflowDrops: 1 })).toEqual(["overflow"]);
  });

  it("goes back to full height only after a sustained good period, without flipping", () => {
    const governor = new SlotHeightGovernor();
    const state = start();
    play(governor, state, { ms: 4000, fps: 50, dropShare: 0.1 });
    // Good, but not for long enough; then a bad stretch restarts the wait.
    expect(play(governor, state, { ms: STEP_UP_AFTER_MS / 2, fps: 50, dropShare: 0 })).toEqual([]);
    expect(play(governor, state, { ms: 4000, fps: 50, dropShare: 0.04 })).toEqual([]);
    expect(governor.reduced).toBe(true);
    expect(play(governor, state, { ms: STEP_UP_AFTER_MS + 4000, fps: 50, dropShare: 0 })).toEqual(["recovered"]);
    expect(governor.reduced).toBe(false);
  });

  it("goes back to full height at once when the frame rate drops to 30 fps or less", () => {
    const governor = new SlotHeightGovernor();
    const state = start();
    play(governor, state, { ms: 4000, fps: 50, dropShare: 0.1 });
    expect(play(governor, state, { ms: 300, fps: 25, dropShare: 0 })).toEqual(["frame-rate"]);
  });
});
