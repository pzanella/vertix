/**
 * Pure descriptive statistics for benchmark samples. No DOM, no engine
 * state — everything here is a function of its arguments only.
 */

export interface SampleSummary {
  count: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export const EMPTY_SUMMARY: SampleSummary = { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };

/**
 * Percentile `p` (0-100) of an ascending-sorted sample, using linear
 * interpolation between the two closest ranks (the "R-7" / NumPy default
 * method): rank = (n - 1) * p / 100.
 */
export function percentileOfSorted(sorted: ArrayLike<number>, p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[n - 1];
  const rank = ((n - 1) * p) / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

export function mean(values: ArrayLike<number>): number | null {
  const n = values.length;
  if (n === 0) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  return sum / n;
}

/** Copies, sorts and summarizes `values`. Non-finite values are ignored. */
export function summarize(values: ArrayLike<number>): SampleSummary {
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) finite.push(values[i]);
  }
  if (finite.length === 0) return EMPTY_SUMMARY;
  const sorted = Float64Array.from(finite).sort();
  return {
    count: sorted.length,
    mean: mean(sorted),
    p50: percentileOfSorted(sorted, 50),
    p95: percentileOfSorted(sorted, 95),
    p99: percentileOfSorted(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/** Values at the indices where `include` is true — e.g. dropping warm-up samples. */
export function selectWhere(values: ArrayLike<number>, include: (index: number) => boolean): Float64Array {
  const selected: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (include(i)) selected.push(values[i]);
  }
  return Float64Array.from(selected);
}

/** Consecutive differences `values[i + 1] - values[i]`. */
export function deltas(values: ArrayLike<number>): Float64Array {
  const n = values.length;
  const out = new Float64Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++) out[i - 1] = values[i] - values[i - 1];
  return out;
}

/** Events per second over the span between the first and last timestamp (ms). Null with fewer than 2 timestamps or a zero span. */
export function ratePerSecond(timestampsMs: ArrayLike<number>): number | null {
  const n = timestampsMs.length;
  if (n < 2) return null;
  const spanMs = timestampsMs[n - 1] - timestampsMs[0];
  return spanMs > 0 ? ((n - 1) * 1000) / spanMs : null;
}

/** Median of the positive values only — used to estimate a video's frame duration from mediaTime steps. */
export function medianOfPositive(values: ArrayLike<number>): number | null {
  const positive: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) positive.push(values[i]);
  }
  return percentileOfSorted(Float64Array.from(positive).sort(), 50);
}
