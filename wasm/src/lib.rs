use wasm_bindgen::prelude::*;

mod face;
use face::FaceTracker;

const GRID_COLS: usize = 32;
const GRID_ROWS: usize = 18;

/// How many frames a face target stays trusted after the last confirmed
/// detection, before falling back to the generic saliency scan. Covers the
/// gap between periodic detection updates plus brief turns/occlusions.
const FACE_TARGET_TTL_FRAMES: u32 = 24;
/// How much a fresh detection moves the trusted face position, per update
/// (0-1). Low-pass-filters the raw detection's frame-to-frame jitter before
/// it reaches the PID, instead of asking the PID to smooth it.
const FACE_TARGET_SMOOTHING: f64 = 0.12;

/// Ignore saliency shifts smaller than this (in analysis pixels) so the
/// crop doesn't hunt for a new target on tiny, noisy score changes.
const DEAD_ZONE_PX: f64 = 5.0;
/// Max pan speed per frame (analysis pixels) — caps how fast the virtual
/// camera can move, so a sudden score change can't cause a hard jump cut.
const MAX_PAN_SPEED: f64 = 3.0;

// PID gains, softened for a slower, more cinematic pan — less proportional
// snap (KP), more derivative damping relative to KP so the slower response
// still settles instead of gently overshooting.
const PID_KP: f64 = 0.03;
const PID_KI: f64 = 0.0015;
const PID_KD: f64 = 0.07;
const PID_I_MAX: f64 = 200.0;

/// Score multiplier for blocks that contain skin-tone pixels (likely a person).
const SKIN_BOOST: f64 = 3.0;
/// Score multiplier for blocks with motion between frames.
const MOTION_BOOST: f64 = 2.0;

/// Simple RGB skin-tone check (Peer et al.) — works across skin tones
/// without needing color-space conversion.
#[inline(always)]
pub(crate) fn is_skin_tone(r: u8, g: u8, b: u8) -> bool {
    let ri = r as i32;
    let gi = g as i32;
    let bi = b as i32;
    r > 95
        && g > 40
        && b > 20
        && ri.max(gi).max(bi) - ri.min(gi).min(bi) > 15
        && (ri - gi).abs() > 15
        && ri > gi
        && ri > bi
}

/// Finds the horizontal center of "interesting" content in a frame.
///
/// The frame is split into a grid of blocks. Each block gets a score from
/// texture (luma variance), contrast, skin tone, and motion versus the
/// previous frame. Scores are biased toward the center and the upper third
/// of the frame (where faces usually are), then averaged into one X position.
fn saliency_center_x(rgba: &[u8], prev: Option<&[u8]>, width: u32, height: u32) -> f64 {
    let w = width as usize;
    let h = height as usize;
    let bw = w / GRID_COLS;
    let bh = h / GRID_ROWS;
    if bw == 0 || bh == 0 {
        return (width / 2) as f64;
    }
    let block_pixels = (bw * bh) as f64;

    let mut col_score = vec![0.0f64; GRID_COLS];

    let cx = (GRID_COLS as f64 - 1.0) / 2.0;
    let sigma_x = GRID_COLS as f64 / 3.0;

    // Vertical bias peaks at ~35% from the top, favoring faces/heads.
    let cy_bias = GRID_ROWS as f64 * 0.35;

    for gy in 0..GRID_ROWS {
        let y0 = gy * bh;

        let dy = gy as f64 - cy_bias;
        let sigma_y = GRID_ROWS as f64 / 2.5;
        let vert_weight = 0.5 + 0.5 * (-dy * dy / (2.0 * sigma_y * sigma_y)).exp();

        for gx in 0..GRID_COLS {
            let x0 = gx * bw;

            let mut sum_luma = 0.0f64;
            let mut sum_luma_sq = 0.0f64;
            let mut sum_grad = 0.0f64;
            let mut skin_count = 0u32;
            let mut motion_sum = 0.0f64;

            for by in 0..bh {
                let row_off = (y0 + by) * w * 4;
                for bx in 0..bw {
                    let px = x0 + bx;
                    let idx = row_off + px * 4;
                    let r = rgba[idx];
                    let g = rgba[idx + 1];
                    let b = rgba[idx + 2];

                    let luma = 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64;
                    sum_luma += luma;
                    sum_luma_sq += luma * luma;

                    if is_skin_tone(r, g, b) {
                        skin_count += 1;
                    }

                    if bx > 0 && bx < bw - 1 {
                        let idx_r = row_off + (px + 1) * 4;
                        let idx_l = row_off + (px - 1) * 4;
                        let luma_r = 0.299 * rgba[idx_r] as f64
                            + 0.587 * rgba[idx_r + 1] as f64
                            + 0.114 * rgba[idx_r + 2] as f64;
                        let luma_l = 0.299 * rgba[idx_l] as f64
                            + 0.587 * rgba[idx_l + 1] as f64
                            + 0.114 * rgba[idx_l + 2] as f64;
                        sum_grad += (luma_r - luma_l).abs();
                    }

                    if let Some(prev_rgba) = prev {
                        let pr = prev_rgba[idx] as f64;
                        let pg = prev_rgba[idx + 1] as f64;
                        let pb = prev_rgba[idx + 2] as f64;
                        let diff = ((r as f64 - pr).powi(2)
                            + (g as f64 - pg).powi(2)
                            + (b as f64 - pb).powi(2))
                            .sqrt();
                        motion_sum += diff;
                    }
                }
            }

            let mean = sum_luma / block_pixels;
            // Clamp at 0: floating-point rounding can push this a hair below
            // zero for near-uniform blocks, and sqrt() of a negative number
            // is NaN — which then poisons the whole weighted sum below.
            let variance = ((sum_luma_sq / block_pixels) - mean * mean).max(0.0);
            let contrast = sum_grad / block_pixels;
            let skin_ratio = skin_count as f64 / block_pixels;
            let motion = motion_sum / block_pixels;

            let texture_score = variance.sqrt() * (1.0 + contrast);
            let skin_score = SKIN_BOOST * skin_ratio;
            let motion_score = if prev.is_some() {
                MOTION_BOOST * (motion / 255.0).min(1.0)
            } else {
                0.0
            };

            let raw_score = texture_score + skin_score + motion_score;

            let dx = gx as f64 - cx;
            let h_bias = 0.6 + 0.4 * (-dx * dx / (2.0 * sigma_x * sigma_x)).exp();

            col_score[gx] += raw_score * h_bias * vert_weight;
        }
    }

    let total: f64 = col_score.iter().sum();
    if total == 0.0 {
        return (width / 2) as f64;
    }
    let weighted: f64 = col_score
        .iter()
        .enumerate()
        .map(|(gx, &s)| ((gx as f64 + 0.5) * bw as f64) * s)
        .sum();

    weighted / total
}

/// Smooths a noisy target position into a slow, steady motion.
struct PidController {
    kp: f64,
    ki: f64,
    kd: f64,
    integral: f64,
    prev_error: f64,
}

impl PidController {
    fn new(kp: f64, ki: f64, kd: f64) -> Self {
        Self { kp, ki, kd, integral: 0.0, prev_error: 0.0 }
    }

    fn update(&mut self, error: f64) -> f64 {
        self.integral = (self.integral + error).clamp(-PID_I_MAX, PID_I_MAX);
        let derivative = error - self.prev_error;
        self.prev_error = error;
        self.kp * error + self.ki * self.integral + self.kd * derivative
    }

    fn reset(&mut self) {
        self.integral = 0.0;
        self.prev_error = 0.0;
    }
}

/// Tracks where the 9:16 crop window should sit inside a 16:9 frame, and
/// slides it there smoothly instead of jumping straight to the target.
#[wasm_bindgen]
pub struct ReframeEngine {
    src_width: u32,
    src_height: u32,
    crop_width: u32,
    smooth_x: f64,
    pid: PidController,
    initialized: bool,
    /// Previous frame, kept only to detect motion between frames.
    prev_frame: Vec<u8>,
    prev_frame_valid: bool,
    face_tracker: FaceTracker,
    /// Last known speaker position (analysis-space pixels), while trusted.
    face_target: Option<f64>,
    face_target_ttl: u32,
}

#[wasm_bindgen]
impl ReframeEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(src_width: u32, src_height: u32) -> ReframeEngine {
        let crop_width = ((src_height as f64) * 9.0 / 16.0).round() as u32;
        let crop_width = crop_width.min(src_width);

        ReframeEngine {
            src_width,
            src_height,
            crop_width,
            smooth_x: (src_width as f64 - crop_width as f64) / 2.0,
            pid: PidController::new(PID_KP, PID_KI, PID_KD),
            initialized: false,
            prev_frame: Vec::new(),
            prev_frame_valid: false,
            face_tracker: FaceTracker::new(),
            face_target: None,
            face_target_ttl: 0,
        }
    }

    /// Runs face detection on a separate 320x240 letterboxed frame (see
    /// `face.rs`) and returns every detected face, flattened as
    /// `[cx, cy, w, h, motion, score, ...]` (fractions 0..1 of the source
    /// frame), for the multi-speaker layout. Also feeds the single-person
    /// PID crop target (`process_frame`), unchanged from before. Meant to
    /// be called less often than every frame — it's much more expensive
    /// than the generic saliency scan.
    pub fn update_faces(&mut self, face_frame_rgba: &[u8]) -> Vec<f64> {
        let (faces, best_cx) = self.face_tracker.observe_all(face_frame_rgba);

        if let Some(cx) = best_cx {
            let smoothed = match self.face_target {
                Some(prev) => prev + FACE_TARGET_SMOOTHING * (cx - prev),
                None => cx,
            };
            self.face_target = Some(smoothed);
            self.face_target_ttl = FACE_TARGET_TTL_FRAMES;
        }

        let mut flat = Vec::with_capacity(faces.len() * 6);
        for f in &faces {
            flat.push(f.cx as f64);
            flat.push(f.cy as f64);
            flat.push(f.w as f64);
            flat.push(f.h as f64);
            flat.push(f.motion);
            flat.push(f.score as f64);
        }
        flat
    }

    /// Analyzes one RGBA frame and returns the smoothed crop-window X offset.
    pub fn process_frame(&mut self, rgba_data: &[u8]) -> u32 {
        let prev = if self.prev_frame_valid {
            Some(self.prev_frame.as_slice())
        } else {
            None
        };

        let target_x = if self.face_target_ttl > 0 {
            self.face_target_ttl -= 1;
            self.face_target
                .unwrap_or_else(|| saliency_center_x(rgba_data, prev, self.src_width, self.src_height))
        } else {
            saliency_center_x(rgba_data, prev, self.src_width, self.src_height)
        };

        if self.prev_frame.len() != rgba_data.len() {
            self.prev_frame = rgba_data.to_vec();
        } else {
            self.prev_frame.copy_from_slice(rgba_data);
        }
        self.prev_frame_valid = true;

        let max_left = (self.src_width - self.crop_width) as f64;
        let desired_left = (target_x - self.crop_width as f64 / 2.0).clamp(0.0, max_left);

        if !self.initialized {
            self.smooth_x = desired_left;
            self.initialized = true;
            return self.smooth_x.round() as u32;
        }

        let error = desired_left - self.smooth_x;
        if error.abs() < DEAD_ZONE_PX {
            return self.smooth_x.round() as u32;
        }

        let correction = self.pid.update(error);
        let clamped = correction.clamp(-MAX_PAN_SPEED, MAX_PAN_SPEED);
        self.smooth_x = (self.smooth_x + clamped).clamp(0.0, max_left);

        self.smooth_x.round() as u32
    }

    pub fn crop_width(&self) -> u32 {
        self.crop_width
    }

    pub fn crop_height(&self) -> u32 {
        self.src_height
    }

    pub fn reset(&mut self) {
        self.initialized = false;
        self.pid.reset();
        self.prev_frame_valid = false;
        self.face_tracker.reset();
        self.face_target = None;
        self.face_target_ttl = 0;
        let max_left = (self.src_width - self.crop_width) as f64;
        self.smooth_x = max_left / 2.0;
    }
}
