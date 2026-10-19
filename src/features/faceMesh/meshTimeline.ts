/** How long the last mesh of a track stays on screen after its last mesh result (a turned head has none), in seconds. */
export const MESH_HOLD_SEC = 0.5;
/** Fade out after the hold, and fade in when a mesh appears, in seconds. */
export const MESH_FADE_OUT_SEC = 0.25;
export const MESH_FADE_IN_SEC = 0.15;
// Mesh checks kept: longer than any lookahead plus hold and fade.
const HISTORY_SEC = 3;

/**
 * "interpolated": between the checks before and after the frame.
 * "stepped": the latest check's mesh (the next one is not in yet, or has no mesh).
 * "held": the last mesh after a check without one, during hold and fade-out.
 */
export type ShownMeshKind = "interpolated" | "stepped" | "held";

export interface ShownMesh {
  trackId: number;
  /** Flat [x, y] normalised to the source frame. Only valid until the next meshesAt() call. */
  points: Float32Array;
  alpha: number;
  kind: ShownMeshKind;
}

/** The face mesh results of one detection tick: per checked track, its mesh (source-normalised) or null. */
export interface MeshCheck {
  mediaTimeSec: number;
  meshes: ReadonlyMap<number, Float32Array | null>;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Face mesh results by media time, and what to draw for the frame on
 * screen. Never interpolates or holds across a scene cut: a mesh belongs
 * to the shot it was found in and disappears on the cut frame.
 */
export class MeshTimeline {
  private checks: MeshCheck[] = [];
  private cuts: number[] = [];
  private readonly scratch = new Map<number, Float32Array>();

  /** Checks must come in media-time order; one from before the latest means a seek or a reset, and starts over. */
  addCheck(check: MeshCheck): void {
    const last = this.checks.at(-1);
    if (last && check.mediaTimeSec < last.mediaTimeSec) this.clear();
    this.checks.push(check);
    this.prune(check.mediaTimeSec);
  }

  /** A hard cut shown from `mediaTimeSec`. */
  addCut(mediaTimeSec: number): void {
    if (!this.cuts.includes(mediaTimeSec)) this.cuts.push(mediaTimeSec);
    this.cuts.sort((a, b) => a - b);
  }

  clear(): void {
    this.checks = [];
    this.cuts = [];
  }

  /** Whether a cut is shown in (fromSec, toSec]. */
  cutBetween(fromSec: number, toSec: number): boolean {
    return this.cuts.some((c) => c > fromSec && c <= toSec);
  }

  get latestCheckSec(): number | null {
    return this.checks.at(-1)?.mediaTimeSec ?? null;
  }

  meshesAt(shownSec: number): ShownMesh[] {
    const shotStart = this.cuts.filter((c) => c <= shownSec).at(-1) ?? -Infinity;
    const shotEnd = this.cuts.find((c) => c > shownSec) ?? Infinity;
    const shot = this.checks.filter((c) => c.mediaTimeSec >= shotStart && c.mediaTimeSec < shotEnd);
    let current = -1;
    for (let i = 0; i < shot.length && shot[i].mediaTimeSec <= shownSec; i++) current = i;
    if (current < 0) return [];
    const next = shot[current + 1] ?? null;

    // Hold and fade run on check time: a result that comes late (a slow
    // phone, no lookahead) does not age the mesh. Between checks the clock
    // advances with the frame on screen, for at most one check interval.
    const currentSec = shot[current].mediaTimeSec;
    const checkInterval = current > 0 ? currentSec - shot[current - 1].mediaTimeSec : 0;
    const clockSec = currentSec + Math.min(shownSec - currentSec, checkInterval);

    const trackIds = new Set<number>();
    for (let i = current; i >= 0 && clockSec - shot[i].mediaTimeSec <= MESH_HOLD_SEC + MESH_FADE_OUT_SEC; i--) {
      for (const [id, mesh] of shot[i].meshes) if (mesh) trackIds.add(id);
    }
    for (const [id, mesh] of shot[current].meshes) if (mesh) trackIds.add(id);

    const shown: ShownMesh[] = [];
    for (const trackId of trackIds) {
      const mesh = shot[current].meshes.get(trackId) ?? null;
      if (mesh) {
        const fadeIn = clamp01((shownSec - this.runStartSec(shot, current, trackId)) / MESH_FADE_IN_SEC);
        const nextMesh = next?.meshes.get(trackId) ?? null;
        if (next && nextMesh) {
          const t = (shownSec - shot[current].mediaTimeSec) / (next.mediaTimeSec - shot[current].mediaTimeSec);
          shown.push({
            trackId,
            points: this.lerp(trackId, mesh, nextMesh, t),
            alpha: fadeIn,
            kind: "interpolated",
          });
        } else {
          shown.push({ trackId, points: mesh, alpha: fadeIn, kind: "stepped" });
        }
        continue;
      }
      const last = this.lastMesh(shot, current, trackId);
      if (!last) continue;
      const age = clockSec - last.mediaTimeSec;
      const alpha = age <= MESH_HOLD_SEC ? 1 : 1 - (age - MESH_HOLD_SEC) / MESH_FADE_OUT_SEC;
      if (alpha > 0) shown.push({ trackId, points: last.mesh, alpha, kind: "held" });
    }
    return shown;
  }

  /** Media time of the first check of the unbroken run of meshes for `trackId` that ends at shot[index]. */
  private runStartSec(shot: MeshCheck[], index: number, trackId: number): number {
    let start = index;
    while (start > 0 && shot[start - 1].meshes.get(trackId)) start--;
    return shot[start].mediaTimeSec;
  }

  private lastMesh(shot: MeshCheck[], before: number, trackId: number) {
    for (let i = before - 1; i >= 0; i--) {
      const mesh = shot[i].meshes.get(trackId);
      if (mesh) return { mesh, mediaTimeSec: shot[i].mediaTimeSec };
    }
    return null;
  }

  private lerp(trackId: number, from: Float32Array, to: Float32Array, t: number): Float32Array {
    let out = this.scratch.get(trackId);
    if (!out || out.length !== from.length) {
      out = new Float32Array(from.length);
      this.scratch.set(trackId, out);
    }
    const n = Math.min(from.length, to.length);
    for (let i = 0; i < n; i++) out[i] = from[i] + (to[i] - from[i]) * t;
    return out;
  }

  private prune(latestSec: number): void {
    const keepFrom = latestSec - HISTORY_SEC;
    const firstKept = this.checks.findIndex((c) => c.mediaTimeSec >= keepFrom);
    if (firstKept > 0) this.checks.splice(0, firstKept);
    this.cuts = this.cuts.filter((c) => c >= keepFrom);
    const live = new Set(this.checks.flatMap((c) => [...c.meshes.keys()]));
    for (const id of this.scratch.keys()) if (!live.has(id)) this.scratch.delete(id);
  }
}
