import type { OverlayFrame } from "../../core";
import { sourceToView } from "./meshGeometry";
import type { ShownMesh } from "./meshTimeline";
import type { MeshStroke, MeshStyle } from "./meshStyles";

export interface MeshEdges {
  tessellation: Uint16Array;
  contours: Uint16Array;
}

function edgesPath(points: Float32Array, edges: Uint16Array): Path2D {
  const path = new Path2D();
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] * 2;
    const b = edges[i + 1] * 2;
    if (b + 1 >= points.length || a + 1 >= points.length) continue;
    path.moveTo(points[a], points[a + 1]);
    path.lineTo(points[b], points[b + 1]);
  }
  return path;
}

function stroke(ctx: CanvasRenderingContext2D, path: Path2D, line: MeshStroke, alpha: number, scale: number): void {
  ctx.strokeStyle = line.color;
  ctx.globalAlpha = line.opacity * alpha;
  ctx.lineWidth = line.widthAt1080 * scale;
  ctx.stroke(path);
}

/** Draws each mesh through every view of the frame (each 9:16 pane, or the whole 16:9 frame), clipped to the view. */
export function drawMeshes(
  frame: OverlayFrame,
  meshes: readonly ShownMesh[],
  edges: MeshEdges,
  style: MeshStyle,
  scratch: { points: Float32Array }
): void {
  const { ctx } = frame;
  const scale = frame.height / 1080;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const view of frame.views) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.dest.x, view.dest.y, view.dest.w, view.dest.h);
    ctx.clip();
    for (const mesh of meshes) {
      if (mesh.alpha <= 0) continue;
      if (scratch.points.length !== mesh.points.length) scratch.points = new Float32Array(mesh.points.length);
      const points = sourceToView(mesh.points, view, frame.srcW, frame.srcH, scratch.points);
      if (style.tessellation) stroke(ctx, edgesPath(points, edges.tessellation), style.tessellation, mesh.alpha, scale);
      ctx.shadowColor = style.shadowBlurAt1080 > 0 ? "rgba(0, 0, 0, 0.6)" : "transparent";
      ctx.shadowBlur = style.shadowBlurAt1080 * scale;
      stroke(ctx, edgesPath(points, edges.contours), style.contours, mesh.alpha, scale);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
  ctx.restore();
}
