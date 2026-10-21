import { describe, expect, it } from "vitest";
import {
  PANEL_EXIT_SEC,
  PANEL_MAX_SHIFT_HEIGHTS,
  PANEL_STILL_SEC,
  PanelEvidence,
  panelPairShift,
  type PanelFace,
} from "./panelEvidence";

const DT = 0.2;

function faces(xs: number[], dx = 0): PanelFace[] {
  return xs.map((cx, id) => ({ id, cx: cx + dx, cy: 0.5, h: 0.2 }));
}

/** Runs `observe` on one detection every DT seconds, from `fromSec`, with the faces `at(i)` for the i-th detection. */
function feed(
  evidence: PanelEvidence,
  at: (i: number) => PanelFace[],
  count: number,
  fromSec = 0,
  cutAt = -1
): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < count; i++) out.push(evidence.observe(at(i), fromSec + i * DT, i === cutAt));
  return out;
}

describe("panelPairShift", () => {
  it("is the median over the matched faces of the largest centre shift in face heights", () => {
    const previous = new Map([
      [0, { cx: 0.2, cy: 0.5, h: 0.2 }],
      [1, { cx: 0.5, cy: 0.5, h: 0.2 }],
      [2, { cx: 0.8, cy: 0.5, h: 0.2 }],
    ]);
    const moved = [
      { id: 0, cx: 0.2, cy: 0.5, h: 0.2 },
      { id: 1, cx: 0.5, cy: 0.5 + 0.01, h: 0.2 },
      { id: 2, cx: 0.8 + 0.1, cy: 0.5, h: 0.2 },
    ];
    expect(panelPairShift(moved, previous)).toBeCloseTo(0.05, 6);
  });

  it("is null with fewer than three matched faces", () => {
    expect(panelPairShift(faces([0.2, 0.5]), new Map())).toBeNull();
  });
});

describe("PanelEvidence", () => {
  it("is not evidence on the first detection", () => {
    expect(new PanelEvidence().observe(faces([0.2, 0.5, 0.8]), 0, false)).toBe(false);
  });

  it("is evidence after PANEL_STILL_SEC of still pairs (a static panel)", () => {
    const evidence = new PanelEvidence();
    const still = feed(evidence, () => faces([0.2, 0.5, 0.8]), 12);
    const firstStill = still.indexOf(true);
    expect(firstStill).toBeGreaterThan(0);
    expect(firstStill * DT).toBeGreaterThanOrEqual(PANEL_STILL_SEC - 1e-3);
    expect(still.slice(firstStill).every(Boolean)).toBe(true);
  });

  it("stays no evidence for moving faces (a crowd)", () => {
    const evidence = new PanelEvidence();
    const moving = feed(evidence, (i) => faces([0.2, 0.5, 0.8], i * 0.1), 30);
    expect(moving.some(Boolean)).toBe(false);
  });

  it("keeps the evidence through one moving pair (a head turn)", () => {
    const evidence = new PanelEvidence();
    const outcome = feed(evidence, (i) => faces([0.2, 0.5, 0.8], i === 10 ? 0.1 : 0), 20);
    expect(outcome[10]).toBe(true);
    expect(outcome.slice(10).every(Boolean)).toBe(true);
  });

  it("leaves the evidence after PANEL_EXIT_SEC of consecutive moving pairs", () => {
    const evidence = new PanelEvidence();
    feed(evidence, () => faces([0.2, 0.5, 0.8]), 10);
    const outcome = feed(evidence, (i) => faces([0.2, 0.5, 0.8], i * 0.1), 10, 10 * DT);
    const firstMoving = outcome.indexOf(false);
    expect(firstMoving).toBeGreaterThanOrEqual(0);
    expect(firstMoving * DT).toBeGreaterThanOrEqual(PANEL_EXIT_SEC - 1e-3);
    expect(firstMoving * DT).toBeLessThanOrEqual(PANEL_EXIT_SEC + DT + 1e-3);
  });

  it("is no evidence after a cut until the evidence exists again", () => {
    const evidence = new PanelEvidence();
    feed(evidence, () => faces([0.2, 0.5, 0.8]), 12);
    const afterCut = feed(evidence, () => faces([0.2, 0.5, 0.8]), 12, 2.4, 0);
    expect(afterCut[0]).toBe(false);
    expect(afterCut.indexOf(true) * DT).toBeGreaterThanOrEqual(PANEL_STILL_SEC - 1e-3);
  });

  it("leaves the evidence when the number of faces changes", () => {
    const evidence = new PanelEvidence();
    feed(evidence, () => faces([0.2, 0.5, 0.8]), 12);
    expect(evidence.observe(faces([0.2, 0.5]), 2.4, false)).toBe(false);
  });

  it("uses the threshold in face heights", () => {
    const evidence = new PanelEvidence();
    feed(evidence, (i) => faces([0.2, 0.5, 0.8], i * (PANEL_MAX_SHIFT_HEIGHTS * 0.2 * 0.5)), 20);
    expect(evidence.observe(faces([0.2, 0.5, 0.8], 0.2 * PANEL_MAX_SHIFT_HEIGHTS * 0.5 * 20), 4, false)).toBe(true);
  });

  it("is reset by reset()", () => {
    const evidence = new PanelEvidence();
    feed(evidence, () => faces([0.2, 0.5, 0.8]), 12);
    evidence.reset();
    expect(evidence.observe(faces([0.2, 0.5, 0.8]), 10, false)).toBe(false);
  });
});
