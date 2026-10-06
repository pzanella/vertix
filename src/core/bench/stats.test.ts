import { describe, expect, it } from "vitest";
import {
  EMPTY_SUMMARY,
  deltas,
  mean,
  medianOfPositive,
  percentileOfSorted,
  ratePerSecond,
  selectWhere,
  summarize,
} from "./stats";

describe("percentileOfSorted", () => {
  it("returns null for an empty sample", () => {
    expect(percentileOfSorted([], 50)).toBeNull();
  });

  it("returns the only value for a single-element sample", () => {
    expect(percentileOfSorted([7], 0)).toBe(7);
    expect(percentileOfSorted([7], 50)).toBe(7);
    expect(percentileOfSorted([7], 99)).toBe(7);
  });

  it("interpolates linearly between ranks (NumPy default)", () => {
    const sorted = [1, 2, 3, 4];
    expect(percentileOfSorted(sorted, 50)).toBeCloseTo(2.5);
    expect(percentileOfSorted(sorted, 25)).toBeCloseTo(1.75);
    expect(percentileOfSorted(sorted, 95)).toBeCloseTo(3.85);
  });

  it("matches known values on 1..100", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileOfSorted(sorted, 50)).toBeCloseTo(50.5);
    expect(percentileOfSorted(sorted, 95)).toBeCloseTo(95.05);
    expect(percentileOfSorted(sorted, 99)).toBeCloseTo(99.01);
  });

  it("clamps p to the sample range", () => {
    expect(percentileOfSorted([1, 5, 9], -10)).toBe(1);
    expect(percentileOfSorted([1, 5, 9], 0)).toBe(1);
    expect(percentileOfSorted([1, 5, 9], 100)).toBe(9);
    expect(percentileOfSorted([1, 5, 9], 150)).toBe(9);
  });
});

describe("mean", () => {
  it("returns null for an empty sample", () => {
    expect(mean([])).toBeNull();
  });

  it("averages typed arrays", () => {
    expect(mean(new Float64Array([1, 2, 3, 6]))).toBe(3);
  });
});

describe("summarize", () => {
  it("returns the empty summary for no samples", () => {
    expect(summarize([])).toEqual(EMPTY_SUMMARY);
  });

  it("does not depend on input order and does not mutate the input", () => {
    const input = new Float64Array([5, 1, 4, 2, 3]);
    const summary = summarize(input);
    expect(Array.from(input)).toEqual([5, 1, 4, 2, 3]);
    expect(summary).toEqual({ count: 5, mean: 3, p50: 3, p95: 4.8, p99: 4.96, max: 5 });
  });

  it("ignores NaN and infinite values", () => {
    const summary = summarize([1, NaN, 3, Infinity, -Infinity]);
    expect(summary.count).toBe(2);
    expect(summary.mean).toBe(2);
    expect(summary.max).toBe(3);
  });

  it("sorts numerically, not lexicographically", () => {
    expect(summarize([10, 9, 100]).max).toBe(100);
    expect(summarize([10, 9, 100]).p50).toBe(10);
  });
});

describe("selectWhere", () => {
  it("keeps values whose index passes the predicate", () => {
    const flags = [1, 0, 1, 0];
    expect(Array.from(selectWhere([10, 20, 30, 40], (i) => flags[i] === 0))).toEqual([20, 40]);
  });
});

describe("deltas", () => {
  it("returns consecutive differences", () => {
    expect(Array.from(deltas([0, 16, 33, 50]))).toEqual([16, 17, 17]);
  });

  it("returns an empty array for fewer than two values", () => {
    expect(deltas([]).length).toBe(0);
    expect(deltas([3]).length).toBe(0);
  });
});

describe("ratePerSecond", () => {
  it("returns events per second over the span", () => {
    expect(ratePerSecond([0, 40, 80, 120])).toBeCloseTo(25);
  });

  it("returns null when it cannot be computed", () => {
    expect(ratePerSecond([])).toBeNull();
    expect(ratePerSecond([5])).toBeNull();
    expect(ratePerSecond([5, 5])).toBeNull();
  });
});

describe("medianOfPositive", () => {
  it("ignores zero and negative steps", () => {
    expect(medianOfPositive([0, 0.04, 0.04, -1, 0.08])).toBeCloseTo(0.04);
  });

  it("returns null with no positive values", () => {
    expect(medianOfPositive([0, -1])).toBeNull();
  });
});
