//! Detects hard cuts between two consecutive detection frames (320x240
//! RGBA, ~5 per second). All accumulation is integer math, so the SIMD and
//! scalar builds produce identical scores.

use std::collections::VecDeque;

const FRAME_W: usize = 320;
const FRAME_H: usize = 240;
const PIXELS: u32 = (FRAME_W * FRAME_H) as u32;

/// 4 levels per RGB channel -> 64 colour bins.
const HIST_BINS: usize = 64;
/// Luma is averaged over 8x8 blocks -> a 40x30 grid.
const BLOCK: usize = 8;
const GRID_COLS: usize = FRAME_W / BLOCK;
const GRID_ROWS: usize = FRAME_H / BLOCK;
const GRID_CELLS: usize = GRID_COLS * GRID_ROWS;
const MAX_BLOCK_SUM: u32 = (BLOCK * BLOCK * 255) as u32;

/// Minimum histogram score (H) or grid score (G), each 0..1, for a cut.
/// Calibrated on the sample clips at detection rate: no-cut pairs peaked at
/// H 0.072 / G 0.070, cross-clip cuts started at H 0.181 / G 0.166.
pub const CUT_SCORE_THRESHOLD: f64 = 0.12;
/// The score that crossed CUT_SCORE_THRESHOLD must also be at least this
/// multiple of its own median over the last CUT_SPIKE_HISTORY detections,
/// so steady high motion (handheld camera, fast pan) doesn't count as a cut.
pub const CUT_SPIKE_FACTOR: f64 = 3.0;
/// Number of past detections the spike median uses. Until this many exist
/// (start of playback, after a seek) only the absolute threshold applies.
pub const CUT_SPIKE_HISTORY: usize = 10;
/// After a cut, the next this many detections (~1 s at 25 fps) can't be
/// cuts. A flash or fast fade between two takes crosses the threshold on
/// several detections in a row; without this gap each one would snap the
/// crop and reset tracking again.
pub const CUT_MIN_GAP_DETECTIONS: u32 = 5;

#[derive(Clone, Copy, Default)]
pub struct CutScores {
    /// Colour histogram distance (half the L1 distance), 0..1.
    pub hist: f64,
    /// Mean absolute luma difference on the 40x30 block grid, 0..1.
    pub grid: f64,
    pub is_cut: bool,
}

pub struct SceneCutDetector {
    prev_hist: [u32; HIST_BINS],
    prev_grid: [u32; GRID_CELLS],
    has_prev: bool,
    hist_history: VecDeque<f64>,
    grid_history: VecDeque<f64>,
    detections_since_cut: u32,
}

impl SceneCutDetector {
    pub fn new() -> Self {
        Self {
            prev_hist: [0; HIST_BINS],
            prev_grid: [0; GRID_CELLS],
            has_prev: false,
            hist_history: VecDeque::with_capacity(CUT_SPIKE_HISTORY),
            grid_history: VecDeque::with_capacity(CUT_SPIKE_HISTORY),
            detections_since_cut: CUT_MIN_GAP_DETECTIONS,
        }
    }

    /// Scores `rgba` against the previous frame passed in, then keeps it as
    /// the new previous frame. The first frame after a reset scores 0.
    pub fn observe(&mut self, rgba: &[u8]) -> CutScores {
        let (hist, grid) = frame_signature(rgba);
        if !self.has_prev {
            self.prev_hist = hist;
            self.prev_grid = grid;
            self.has_prev = true;
            return CutScores::default();
        }

        let hist_l1: u32 = hist.iter().zip(&self.prev_hist).map(|(a, b)| a.abs_diff(*b)).sum();
        let grid_l1: u64 = grid.iter().zip(&self.prev_grid).map(|(a, b)| a.abs_diff(*b) as u64).sum();
        let hist_score = hist_l1 as f64 / (2 * PIXELS) as f64;
        let grid_score = grid_l1 as f64 / (GRID_CELLS as u64 * MAX_BLOCK_SUM as u64) as f64;

        let is_spike_now = is_spike(hist_score, &self.hist_history) || is_spike(grid_score, &self.grid_history);
        let is_cut = is_spike_now && self.detections_since_cut >= CUT_MIN_GAP_DETECTIONS;
        self.detections_since_cut = if is_cut { 0 } else { self.detections_since_cut.saturating_add(1) };

        push_capped(&mut self.hist_history, hist_score);
        push_capped(&mut self.grid_history, grid_score);
        self.prev_hist = hist;
        self.prev_grid = grid;

        CutScores { hist: hist_score, grid: grid_score, is_cut }
    }

    pub fn reset(&mut self) {
        self.has_prev = false;
        self.hist_history.clear();
        self.grid_history.clear();
        self.detections_since_cut = CUT_MIN_GAP_DETECTIONS;
    }
}

fn frame_signature(rgba: &[u8]) -> ([u32; HIST_BINS], [u32; GRID_CELLS]) {
    let mut hist = [0u32; HIST_BINS];
    let mut grid = [0u32; GRID_CELLS];
    for y in 0..FRAME_H {
        let row = y * FRAME_W;
        let grid_row = (y / BLOCK) * GRID_COLS;
        for x in 0..FRAME_W {
            let idx = (row + x) * 4;
            let (r, g, b) = (rgba[idx] as u32, rgba[idx + 1] as u32, rgba[idx + 2] as u32);
            hist[((r >> 6) << 4 | (g >> 6) << 2 | (b >> 6)) as usize] += 1;
            grid[grid_row + x / BLOCK] += (77 * r + 150 * g + 29 * b) >> 8;
        }
    }
    (hist, grid)
}

fn is_spike(score: f64, history: &VecDeque<f64>) -> bool {
    if score < CUT_SCORE_THRESHOLD {
        return false;
    }
    if history.len() < CUT_SPIKE_HISTORY {
        return true;
    }
    score >= CUT_SPIKE_FACTOR * median(history)
}

fn median(values: &VecDeque<f64>) -> f64 {
    let mut sorted: Vec<f64> = values.iter().copied().collect();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 { (sorted[mid - 1] + sorted[mid]) / 2.0 } else { sorted[mid] }
}

fn push_capped(history: &mut VecDeque<f64>, value: f64) {
    if history.len() == CUT_SPIKE_HISTORY {
        history.pop_front();
    }
    history.push_back(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(r: u8, g: u8, b: u8) -> Vec<u8> {
        [r, g, b, 255].repeat(FRAME_W * FRAME_H)
    }

    /// Left half one colour, right half another: same histogram when mirrored, different grid.
    fn split(left: [u8; 3], right: [u8; 3]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRAME_W * FRAME_H * 4);
        for _ in 0..FRAME_H {
            for x in 0..FRAME_W {
                let [r, g, b] = if x < FRAME_W / 2 { left } else { right };
                frame.extend_from_slice(&[r, g, b, 255]);
            }
        }
        frame
    }

    #[test]
    fn first_frame_is_never_a_cut() {
        let mut detector = SceneCutDetector::new();
        let scores = detector.observe(&solid(200, 30, 30));
        assert!(!scores.is_cut);
        assert_eq!(scores.hist, 0.0);
    }

    #[test]
    fn identical_frames_score_zero() {
        let mut detector = SceneCutDetector::new();
        detector.observe(&solid(120, 120, 120));
        let scores = detector.observe(&solid(120, 120, 120));
        assert_eq!((scores.hist, scores.grid, scores.is_cut), (0.0, 0.0, false));
    }

    #[test]
    fn colour_change_is_a_cut() {
        let mut detector = SceneCutDetector::new();
        detector.observe(&solid(200, 30, 30));
        let scores = detector.observe(&solid(30, 30, 200));
        assert_eq!(scores.hist, 1.0);
        assert!(scores.is_cut);
    }

    #[test]
    fn layout_change_with_same_colours_is_a_cut_by_grid() {
        let mut detector = SceneCutDetector::new();
        let dark = [20, 20, 20];
        let light = [230, 230, 230];
        detector.observe(&split(dark, light));
        let scores = detector.observe(&split(light, dark));
        assert_eq!(scores.hist, 0.0);
        assert!(scores.grid >= CUT_SCORE_THRESHOLD);
        assert!(scores.is_cut);
    }

    #[test]
    fn steady_high_scores_are_not_spikes() {
        let mut detector = SceneCutDetector::new();
        let a = solid(200, 30, 30);
        let b = solid(30, 30, 200);
        detector.observe(&a);
        for i in 0..CUT_SPIKE_HISTORY {
            detector.observe(if i % 2 == 0 { &b } else { &a });
        }
        let next = if CUT_SPIKE_HISTORY % 2 == 0 { &b } else { &a };
        let scores = detector.observe(next);
        assert!(scores.hist >= CUT_SCORE_THRESHOLD);
        assert!(!scores.is_cut);
    }

    #[test]
    fn no_second_cut_within_the_gap() {
        let mut detector = SceneCutDetector::new();
        let a = solid(200, 30, 30);
        let b = solid(30, 30, 200);
        detector.observe(&a);
        assert!(detector.observe(&b).is_cut);
        for _ in 0..CUT_MIN_GAP_DETECTIONS {
            assert!(!detector.observe(&b).is_cut);
        }
        assert!(detector.observe(&a).is_cut);
    }

    #[test]
    fn reset_forgets_previous_frame() {
        let mut detector = SceneCutDetector::new();
        detector.observe(&solid(200, 30, 30));
        detector.reset();
        assert!(!detector.observe(&solid(30, 30, 200)).is_cut);
    }
}
