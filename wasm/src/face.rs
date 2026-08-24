//! Finds faces in a small letterboxed frame using a pretrained model
//! (UltraFace slim-320, see `models/ATTRIBUTION.md`).

use std::sync::OnceLock;
use tract_onnx::prelude::*;

use crate::is_skin_tone;

const MODEL_W: usize = 320;
const MODEL_H: usize = 240;
const NUM_ANCHORS: usize = 4420;
const CONF_THRESHOLD: f32 = 0.8;
const IOU_THRESHOLD: f32 = 0.4;
/// Reject detections whose box doesn't look like skin — this is what
/// filters out false positives on things like teapots or bottles.
const MIN_SKIN_RATIO: f64 = 0.15;

static MODEL_BYTES: &[u8] = include_bytes!("models/ultraface-slim-320.onnx");
type Model = TypedRunnableModel<TypedModel>;
static MODEL: OnceLock<Model> = OnceLock::new();

fn model() -> &'static Model {
    MODEL.get_or_init(|| {
        tract_onnx::onnx()
            .model_for_read(&mut std::io::Cursor::new(MODEL_BYTES))
            .expect("embedded face model is valid onnx")
            .with_input_fact(0, f32::fact([1, 3, MODEL_H, MODEL_W]).into())
            .expect("valid input fact")
            .into_optimized()
            .expect("model optimizes")
            .into_runnable()
            .expect("model is runnable")
    })
}

#[derive(Clone, Copy)]
struct Candidate {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    score: f32,
}

fn iou(a: &Candidate, b: &Candidate) -> f32 {
    let ix1 = a.x1.max(b.x1);
    let iy1 = a.y1.max(b.y1);
    let ix2 = a.x2.min(b.x2);
    let iy2 = a.y2.min(b.y2);
    let inter = (ix2 - ix1).max(0.0) * (iy2 - iy1).max(0.0);
    let area_a = (a.x2 - a.x1).max(0.0) * (a.y2 - a.y1).max(0.0);
    let area_b = (b.x2 - b.x1).max(0.0) * (b.y2 - b.y1).max(0.0);
    let union = area_a + area_b - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

/// Runs the model on a 320x240 RGBA frame and returns faces above the
/// confidence threshold, after greedy non-max suppression.
fn detect(rgba: &[u8]) -> Vec<Candidate> {
    let Ok(mut input) = Tensor::zero::<f32>(&[1, 3, MODEL_H, MODEL_W]) else {
        return Vec::new();
    };
    {
        let Ok(mut view) = input.to_array_view_mut::<f32>() else {
            return Vec::new();
        };
        for y in 0..MODEL_H {
            for x in 0..MODEL_W {
                let idx = (y * MODEL_W + x) * 4;
                view[[0, 0, y, x]] = (rgba[idx] as f32 - 127.0) / 128.0;
                view[[0, 1, y, x]] = (rgba[idx + 1] as f32 - 127.0) / 128.0;
                view[[0, 2, y, x]] = (rgba[idx + 2] as f32 - 127.0) / 128.0;
            }
        }
    }

    let Ok(result) = model().run(tvec!(input.into())) else {
        return Vec::new();
    };
    let (Ok(scores), Ok(boxes)) = (
        result[0].to_array_view::<f32>(),
        result[1].to_array_view::<f32>(),
    ) else {
        return Vec::new();
    };

    let mut candidates: Vec<Candidate> = Vec::new();
    for i in 0..NUM_ANCHORS {
        let score = scores[[0, i, 1]];
        if score < CONF_THRESHOLD {
            continue;
        }
        candidates.push(Candidate {
            x1: boxes[[0, i, 0]],
            y1: boxes[[0, i, 1]],
            x2: boxes[[0, i, 2]],
            y2: boxes[[0, i, 3]],
            score,
        });
    }
    candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

    let mut kept: Vec<Candidate> = Vec::new();
    'candidates: for c in candidates {
        for k in &kept {
            if iou(&c, k) > IOU_THRESHOLD {
                continue 'candidates;
            }
        }
        kept.push(c);
    }
    kept
}

fn box_pixels(c: &Candidate) -> (usize, usize, usize, usize) {
    let x1 = ((c.x1 * MODEL_W as f32).max(0.0) as usize).min(MODEL_W - 1);
    let x2 = ((c.x2 * MODEL_W as f32).max(0.0) as usize).min(MODEL_W - 1);
    let y1 = ((c.y1 * MODEL_H as f32).max(0.0) as usize).min(MODEL_H - 1);
    let y2 = ((c.y2 * MODEL_H as f32).max(0.0) as usize).min(MODEL_H - 1);
    (x1, y1, x2, y2)
}

fn skin_ratio(rgba: &[u8], c: &Candidate) -> f64 {
    let (x1, y1, x2, y2) = box_pixels(c);
    if x2 <= x1 || y2 <= y1 {
        return 0.0;
    }
    let mut skin = 0u32;
    let mut total = 0u32;
    let mut y = y1;
    while y < y2 {
        let mut x = x1;
        while x < x2 {
            let idx = (y * MODEL_W + x) * 4;
            if is_skin_tone(rgba[idx], rgba[idx + 1], rgba[idx + 2]) {
                skin += 1;
            }
            total += 1;
            x += 2; // sample every other pixel, this only needs to be a ratio
        }
        y += 2;
    }
    if total == 0 { 0.0 } else { skin as f64 / total as f64 }
}

/// How much the lower third of the box (mouth/chin) changed since the last
/// update — a cheap stand-in for "is this person talking right now".
fn mouth_motion(rgba: &[u8], prev: &[u8], c: &Candidate) -> f64 {
    let (x1, _, x2, y2) = box_pixels(c);
    let y1 = (y2 as f32 - (y2 as f32 - box_pixels(c).1 as f32) * 0.34) as usize;
    if x2 <= x1 || y2 <= y1 {
        return 0.0;
    }
    let mut diff_sum = 0.0f64;
    let mut count = 0u32;
    for y in y1..y2 {
        for x in x1..x2 {
            let idx = (y * MODEL_W + x) * 4;
            diff_sum += (rgba[idx] as f64 - prev[idx] as f64).abs()
                + (rgba[idx + 1] as f64 - prev[idx + 1] as f64).abs()
                + (rgba[idx + 2] as f64 - prev[idx + 2] as f64).abs();
            count += 1;
        }
    }
    if count == 0 { 0.0 } else { diff_sum / count as f64 }
}

/// One detected, filtered face — position and size as fractions (0..1) of
/// the letterboxed detection frame, which is a plain stretch-fill of the
/// source video, so these fractions map directly onto source-frame fractions
/// too (see the comment on `FACE_W`/`FACE_H` in `useWasmReframe.ts`).
#[derive(Clone, Copy)]
pub struct FaceObservation {
    pub cx: f32,
    pub cy: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    pub motion: f64,
}

/// Tracks the previous frame across calls so it can score mouth motion.
pub struct FaceTracker {
    prev_frame: Vec<u8>,
    has_prev: bool,
}

impl FaceTracker {
    pub fn new() -> Self {
        Self {
            prev_frame: Vec::new(),
            has_prev: false,
        }
    }

    /// Runs detection on a 320x240 letterboxed RGBA frame and returns every
    /// face that survives the skin-tone/aspect-ratio filters.
    pub fn observe(&mut self, rgba: &[u8]) -> Vec<FaceObservation> {
        let candidates = detect(rgba);

        let mut obs = Vec::new();
        for c in &candidates {
            if skin_ratio(rgba, c) < MIN_SKIN_RATIO {
                continue;
            }
            let w = c.x2 - c.x1;
            let h = c.y2 - c.y1;
            // This model's boxes are often narrower/taller than a real face
            // (observed real detections range roughly 0.38-1.14) — this is
            // only here to reject degenerate slivers, not to judge "faceness"
            // (skin-tone ratio above is what actually filters false positives).
            if h <= 0.0 || w <= 0.0 || !(0.25..=3.0).contains(&(w / h)) {
                continue;
            }

            let motion = if self.has_prev {
                mouth_motion(rgba, &self.prev_frame, c)
            } else {
                0.0
            };

            obs.push(FaceObservation {
                cx: (c.x1 + c.x2) / 2.0,
                cy: (c.y1 + c.y2) / 2.0,
                w,
                h,
                score: c.score,
                motion,
            });
        }

        if self.prev_frame.len() != rgba.len() {
            self.prev_frame = rgba.to_vec();
        } else {
            self.prev_frame.copy_from_slice(rgba);
        }
        self.has_prev = true;

        obs
    }

    pub fn reset(&mut self) {
        self.has_prev = false;
    }
}
