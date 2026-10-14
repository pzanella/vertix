/**
 * Cheap per-frame pre-screen for hard cuts, on a 64x48 thumbnail of every
 * frame. It does not decide cuts: it only asks for an immediate detection
 * on a frame that might be one, and the WASM detector (wasm/src/scene_cut.rs,
 * unchanged thresholds) makes the call. Its scores also locate a cut found
 * on a regular detection tick: the frame with the biggest jump since the
 * previous detection. Same two measures as the detector, at thumbnail size.
 */

export const TRIGGER_W = 64;
export const TRIGGER_H = 48;
/**
 * Size the main thread draws each frame at before handing it to the
 * trigger worker, which scales it down to TRIGGER_W x TRIGGER_H. Kept above
 * the size below which Chrome may keep a 2D canvas on the CPU (drawing a
 * GPU frame into such a canvas would read the whole frame back on the
 * main thread).
 */
export const TRIGGER_SOURCE_W = 160;
export const TRIGGER_SOURCE_H = 120;
const PIXELS = TRIGGER_W * TRIGGER_H;
const HIST_BINS = 64;
const BLOCK = 8;
const GRID_COLS = TRIGGER_W / BLOCK;
const GRID_ROWS = TRIGGER_H / BLOCK;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const MAX_BLOCK_SUM = BLOCK * BLOCK * 255;

// Tuned to miss nothing: half the detector's CUT_SCORE_THRESHOLD (0.12) and
// a lower spike factor (detector: 3.0). Scores here are frame to frame, so
// normal motion stays far below; a false trigger costs one extra detection.
export const TRIGGER_SCORE_THRESHOLD = 0.06;
export const TRIGGER_SPIKE_FACTOR = 2;
export const TRIGGER_SPIKE_HISTORY = 10;

export interface TriggerScores {
  hist: number;
  grid: number;
  triggered: boolean;
}

function signature(rgba: ArrayLike<number>): { hist: Uint32Array; grid: Uint32Array } {
  const hist = new Uint32Array(HIST_BINS);
  const grid = new Uint32Array(GRID_CELLS);
  for (let y = 0; y < TRIGGER_H; y++) {
    const gridRow = Math.floor(y / BLOCK) * GRID_COLS;
    for (let x = 0; x < TRIGGER_W; x++) {
      const i = (y * TRIGGER_W + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)] += 1;
      grid[gridRow + Math.floor(x / BLOCK)] += (77 * r + 150 * g + 29 * b) >> 8;
    }
  }
  return { hist, grid };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isSpike(score: number, history: number[]): boolean {
  if (score < TRIGGER_SCORE_THRESHOLD) return false;
  if (history.length < TRIGGER_SPIKE_HISTORY) return true;
  return score >= TRIGGER_SPIKE_FACTOR * median(history);
}

function pushCapped(history: number[], value: number): void {
  if (history.length === TRIGGER_SPIKE_HISTORY) history.shift();
  history.push(value);
}

export class CutTrigger {
  private prev: { hist: Uint32Array; grid: Uint32Array } | null = null;
  private histHistory: number[] = [];
  private gridHistory: number[] = [];

  /** Scores a TRIGGER_W x TRIGGER_H RGBA frame against the previous one. The first frame after a reset scores 0. */
  observe(rgba: ArrayLike<number>): TriggerScores {
    const current = signature(rgba);
    const prev = this.prev;
    this.prev = current;
    if (!prev) return { hist: 0, grid: 0, triggered: false };

    let histL1 = 0;
    for (let i = 0; i < HIST_BINS; i++) histL1 += Math.abs(current.hist[i] - prev.hist[i]);
    let gridL1 = 0;
    for (let i = 0; i < GRID_CELLS; i++) gridL1 += Math.abs(current.grid[i] - prev.grid[i]);
    const hist = histL1 / (2 * PIXELS);
    const grid = gridL1 / (GRID_CELLS * MAX_BLOCK_SUM);

    const triggered = isSpike(hist, this.histHistory) || isSpike(grid, this.gridHistory);
    pushCapped(this.histHistory, hist);
    pushCapped(this.gridHistory, grid);
    return { hist, grid, triggered };
  }

  reset(): void {
    this.prev = null;
    this.histHistory = [];
    this.gridHistory = [];
  }
}

/** One frame's trigger score, kept for cut localisation. */
export interface ScoredFrame {
  mediaTimeSec: number;
  /** max(hist, grid). */
  score: number;
}

/**
 * The frame in (afterSec, upToSec] with the biggest frame-to-frame jump:
 * where a cut found on the detection at `upToSec` most likely happened.
 * Falls back to `upToSec` without scores for that range.
 */
export function locateCut(scores: readonly ScoredFrame[], afterSec: number | null, upToSec: number): number {
  let best: ScoredFrame | null = null;
  for (const s of scores) {
    if (s.mediaTimeSec > upToSec + 1e-4) continue;
    if (afterSec !== null && s.mediaTimeSec <= afterSec + 1e-4) continue;
    if (best === null || s.score > best.score) best = s;
  }
  return best?.mediaTimeSec ?? upToSec;
}
