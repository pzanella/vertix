use wasm_bindgen::prelude::*;

mod face;
use face::FaceTracker;

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

/// Runs face detection and hands back every detected face for the
/// multi-speaker layout decided on the TypeScript side.
#[wasm_bindgen]
pub struct ReframeEngine {
    face_tracker: FaceTracker,
}

#[wasm_bindgen]
impl ReframeEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ReframeEngine {
        ReframeEngine { face_tracker: FaceTracker::new() }
    }

    /// Runs face detection on a 320x240 letterboxed frame (see `face.rs`)
    /// and returns every detected face, flattened as
    /// `[cx, cy, w, h, motion, score, ...]` (fractions 0..1 of the source
    /// frame). Meant to be called less often than every frame — it's much
    /// more expensive than the rest of the render loop.
    pub fn update_faces(&mut self, face_frame_rgba: &[u8]) -> Vec<f64> {
        let faces = self.face_tracker.observe(face_frame_rgba);

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

    pub fn reset(&mut self) {
        self.face_tracker.reset();
    }
}
