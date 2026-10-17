import { describe, expect, it } from "vitest";
import { PersonCountDebouncer } from "./personCount";

describe("PersonCountDebouncer timing is the same in seconds at 25 and 50 fps", () => {
  /** Media time from the first agreeing detection to the commit, detecting every 5 frames. */
  function secondsToCommit(fps: number, from: number, to: number): number {
    const debouncer = new PersonCountDebouncer();
    const intervalSec = 5 / fps;
    let atSec = 0;
    for (let i = 0; i < 20; i++) debouncer.observe(from, true, (atSec += intervalSec));
    const startSec = atSec + intervalSec;
    while (debouncer.observe(to, true, (atSec += intervalSec)) !== to) {
      if (atSec > 10) throw new Error("never committed");
    }
    return Math.round((atSec - startSec) * 1000) / 1000;
  }

  it.each([25, 50])("changes the count after 1.0s at %i fps", (fps) => {
    expect(secondsToCommit(fps, 1, 2)).toBe(1);
  });

  it.each([25, 50])("drops to zero after 0.2s at %i fps", (fps) => {
    expect(secondsToCommit(fps, 1, 0)).toBe(0.2);
  });

  it("never commits on a single detection, however long after the previous one", () => {
    const debouncer = new PersonCountDebouncer();
    debouncer.observe(1, false, 0);
    expect(debouncer.observe(1, false, 0.2)).toBe(1);
    expect(debouncer.observe(2, true, 5)).toBe(1);
  });
});

describe("PersonCountDebouncer after a scene cut", () => {
  it("commits the cut detection's count immediately", () => {
    const debouncer = new PersonCountDebouncer();
    for (let atSec = 0.2; atSec <= 3; atSec += 0.2) debouncer.observe(2, true, atSec);
    expect(debouncer.commitNow(1, 3.2)).toBe(1);
  });

  it("uses the short debounce for changes starting within 1.0s of the cut", () => {
    const debouncer = new PersonCountDebouncer();
    debouncer.commitNow(1, 5);
    expect(debouncer.observe(2, true, 5.2)).toBe(1);
    expect(debouncer.observe(2, true, 5.4)).toBe(2);
  });

  it("uses the normal debounce for changes starting 1.0s or more after the cut", () => {
    const debouncer = new PersonCountDebouncer();
    debouncer.commitNow(1, 5);
    debouncer.observe(1, true, 5.6);
    expect(debouncer.observe(2, true, 6)).toBe(1);
    expect(debouncer.observe(2, true, 6.4)).toBe(1);
    expect(debouncer.observe(2, true, 7)).toBe(2);
  });
});
