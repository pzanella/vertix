export type MeshStyleId = "cyan" | "hairline" | "contours";

export interface MeshStroke {
  color: string;
  /** Line width in overlay pixels at a 1080-pixel-high output; scaled with the output height. */
  widthAt1080: number;
  opacity: number;
}

export interface MeshStyle {
  id: MeshStyleId;
  label: string;
  /** Null: no tessellation, contours only. */
  tessellation: MeshStroke | null;
  contours: MeshStroke;
  /** Soft shadow behind the contours, in pixels at 1080 high; 0 for none. */
  shadowBlurAt1080: number;
}

export const MESH_STYLES: Record<MeshStyleId, MeshStyle> = {
  cyan: {
    id: "cyan",
    label: "Cyan tech",
    tessellation: { color: "#22d3ee", widthAt1080: 0.9, opacity: 0.3 },
    contours: { color: "#22d3ee", widthAt1080: 1.8, opacity: 0.85 },
    shadowBlurAt1080: 0,
  },
  hairline: {
    id: "hairline",
    label: "Hairline",
    tessellation: { color: "#ffffff", widthAt1080: 0.75, opacity: 0.22 },
    contours: { color: "#ffffff", widthAt1080: 1.5, opacity: 0.7 },
    shadowBlurAt1080: 0,
  },
  contours: {
    id: "contours",
    label: "Contours",
    tessellation: null,
    contours: { color: "#ffffff", widthAt1080: 2.25, opacity: 0.85 },
    shadowBlurAt1080: 3,
  },
};

export const DEFAULT_MESH_STYLE: MeshStyleId = "cyan";
