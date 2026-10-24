import { describe, expect, it } from "vitest";
import {
  MULTIPANE_HOLD_SEC,
  PANEL_EXIT_SEC,
  PANEL_MAX_SHIFT_HEIGHTS,
  PANEL_MAX_SHIFT_HEIGHTS_2,
  PANEL_STILL_SEC,
  PanelEvidence,
  panelPairShift,
  panelShiftThreshold,
  type PanelFace,
} from "./panelEvidence";

const DT = 0.2;
const EPS = 1e-3;

function face(id: number, cx: number, cy = 0.5, visible = true): PanelFace {
  return { id, cx, cy, w: 0.1, h: 0.2, visible };
}

function row(xs: number[], dx = 0): PanelFace[] {
  return xs.map((cx, id) => face(id, cx + dx));
}

/** One detection every DT seconds from `fromSec`; returns the evidence of each. */
function feed(panel: PanelEvidence, at: (i: number) => PanelFace[], count: number, fromSec = 0, cutAt = -1): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < count; i++) out.push(panel.observe(at(i), fromSec + i * DT, i === cutAt).evidence);
  return out;
}

describe("panelPairShift", () => {
  const previous = new Map([
    [0, { cx: 0.2, cy: 0.5, h: 0.2 }],
    [1, { cx: 0.5, cy: 0.5, h: 0.2 }],
    [2, { cx: 0.8, cy: 0.5, h: 0.2 }],
  ]);

  it("is the median for three faces (largest of the x and y shift, in face heights)", () => {
    const moved = [
      { id: 0, cx: 0.2, cy: 0.5, h: 0.2 },
      { id: 1, cx: 0.5, cy: 0.51, h: 0.2 },
      { id: 2, cx: 0.9, cy: 0.5, h: 0.2 },
    ];
    expect(panelPairShift(moved, previous)).toBeCloseTo(0.05, 6);
  });

  it("is the mean for two faces", () => {
    const moved = [
      { id: 0, cx: 0.2, cy: 0.5, h: 0.2 },
      { id: 1, cx: 0.52, cy: 0.5, h: 0.2 },
    ];
    expect(panelPairShift(moved, previous)).toBeCloseTo(0.05, 6);
  });

  it("is null with fewer than two matched faces", () => {
    expect(panelPairShift([{ id: 0, cx: 0.2, cy: 0.5, h: 0.2 }], previous)).toBeNull();
  });

  it("uses the two-face threshold for two faces and the panel threshold for more", () => {
    expect(panelShiftThreshold(2)).toBe(PANEL_MAX_SHIFT_HEIGHTS_2);
    expect(panelShiftThreshold(3)).toBe(PANEL_MAX_SHIFT_HEIGHTS);
  });
});

describe("PanelEvidence", () => {
  it("is not evidence on the first detection", () => {
    expect(new PanelEvidence().observe(row([0.2, 0.5, 0.8]), 0, false).evidence).toBe(false);
  });

  it("is evidence after PANEL_STILL_SEC of still pairs, with the seats left to right", () => {
    const panel = new PanelEvidence();
    const still = feed(panel, () => row([0.8, 0.2, 0.5]), 12);
    expect(still.indexOf(true) * DT).toBeGreaterThanOrEqual(PANEL_STILL_SEC - EPS);
    expect(still.slice(still.indexOf(true)).every(Boolean)).toBe(true);
    const seats = panel.observe(row([0.8, 0.2, 0.5]), 12 * DT, false).seats;
    expect(seats.map((seat) => seat.trackId)).toEqual([1, 2, 0]);
  });

  it("is evidence for two still faces (an interview)", () => {
    expect(feed(new PanelEvidence(), () => row([0.25, 0.7]), 10).some(Boolean)).toBe(true);
  });

  it("stays no evidence for moving faces (a crowd)", () => {
    expect(feed(new PanelEvidence(), (i) => row([0.2, 0.5, 0.8], i * 0.1), 30).some(Boolean)).toBe(false);
    expect(feed(new PanelEvidence(), (i) => row([0.25, 0.7], i * 0.1), 30).some(Boolean)).toBe(false);
  });

  it("keeps the evidence through one moving pair (a head turn)", () => {
    const outcome = feed(new PanelEvidence(), (i) => row([0.2, 0.5, 0.8], i === 10 ? 0.1 : 0), 20);
    expect(outcome.slice(8).every(Boolean)).toBe(true);
  });

  it("leaves the evidence after PANEL_EXIT_SEC of consecutive moving pairs", () => {
    const panel = new PanelEvidence();
    feed(panel, () => row([0.2, 0.5, 0.8]), 10);
    const outcome = feed(panel, (i) => row([0.2, 0.5, 0.8], i * 0.1), 10, 10 * DT);
    const left = outcome.indexOf(false);
    expect(left * DT).toBeGreaterThanOrEqual(PANEL_EXIT_SEC - EPS);
    expect(left * DT).toBeLessThanOrEqual(PANEL_EXIT_SEC + DT + EPS);
  });

  it("is no evidence after a cut until the panel is still again", () => {
    const panel = new PanelEvidence();
    feed(panel, () => row([0.2, 0.5, 0.8]), 12);
    const afterCut = feed(panel, () => row([0.2, 0.5, 0.8]), 12, 2.4, 0);
    expect(afterCut[0]).toBe(false);
    expect(afterCut.indexOf(true) * DT).toBeGreaterThanOrEqual(PANEL_STILL_SEC - EPS);
  });

  it("holds the seat of a missing face for MULTIPANE_HOLD_SEC, then drops it", () => {
    const panel = new PanelEvidence();
    feed(panel, () => row([0.25, 0.5, 0.75]), 10);
    const startSec = 10 * DT;
    const missing = () => [face(0, 0.25), face(1, 0.5, 0.5, false), face(2, 0.75)];
    const seatsAt = (i: number) => panel.observe(missing(), startSec + i * DT, false).seats;
    const during = seatsAt(0);
    expect(during).toHaveLength(3);
    expect(during[1].held).toBe(true);
    const lastSeenSec = startSec - DT;
    let i = 1;
    while (startSec + i * DT - lastSeenSec <= MULTIPANE_HOLD_SEC - EPS) expect(seatsAt(i++)).toHaveLength(3);
    expect(seatsAt(i + 1)).toHaveLength(2);
  });

  it("lets a new confirmed face at the same place take over a held seat", () => {
    const panel = new PanelEvidence();
    feed(panel, () => row([0.25, 0.7]), 10);
    panel.observe([face(0, 0.25), face(1, 0.7, 0.5, false)], 2, false);
    const seats = panel.observe([face(0, 0.25), face(7, 0.71)], 2.2, false).seats;
    expect(seats.map((seat) => seat.trackId)).toEqual([0, 7]);
    expect(seats.every((seat) => !seat.held)).toBe(true);
  });

  it("does not seat a new face until it has been still for PANEL_STILL_SEC (a false box)", () => {
    const panel = new PanelEvidence();
    feed(panel, () => row([0.25, 0.7]), 10);
    const withBox = (i: number) => [face(0, 0.25), face(1, 0.7), face(9, 0.65, 0.71, i % 2 === 0)];
    for (let i = 0; i < 10; i++) expect(panel.observe(withBox(i), 2 + i * DT, false).seats).toHaveLength(2);
    const still = [face(0, 0.25), face(1, 0.7), face(9, 0.4, 0.71)];
    let seatsCount = 2;
    for (let i = 0; i < 8; i++) seatsCount = panel.observe(still, 4 + i * DT, false).seats.length;
    expect(seatsCount).toBe(3);
  });

  it("is reset by reset()", () => {
    const panel = new PanelEvidence();
    feed(panel, () => row([0.2, 0.5, 0.8]), 12);
    panel.reset();
    expect(panel.observe(row([0.2, 0.5, 0.8]), 10, false).evidence).toBe(false);
  });
});
