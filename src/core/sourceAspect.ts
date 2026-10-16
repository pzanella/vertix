// At or below this width/height ratio a source is not landscape (portrait
// phone video, square): cropping it to 9:16 makes no sense, so it is shown
// whole. 4:3 (1.33) stays landscape.
export const MAX_SHOWN_AS_IS_ASPECT = 1.1;

/** Whether a `width` x `height` source (as displayed, rotation applied) is shown whole instead of reframed. */
export function isShownAsIs(width: number, height: number): boolean {
  return width > 0 && height > 0 && width / height <= MAX_SHOWN_AS_IS_ASPECT;
}

export interface SourceSize {
  width: number;
  height: number;
}

/**
 * The displayed size of a video frame. `videoWidth`/`videoHeight` have
 * the rotation metadata applied (a phone video recorded upright reports a
 * portrait size); rVFC metadata may give the coded, unrotated size. When
 * the two disagree on orientation, the element's size wins.
 */
export function displayedSourceSize(
  metadataWidth: number | undefined,
  metadataHeight: number | undefined,
  videoWidth: number,
  videoHeight: number
): SourceSize {
  const width = metadataWidth ?? videoWidth;
  const height = metadataHeight ?? videoHeight;
  if (videoWidth > 0 && videoHeight > 0 && width > height !== videoWidth > videoHeight) {
    return { width: videoWidth, height: videoHeight };
  }
  return { width, height };
}

/** The `aspect` (width / height) output size that holds a whole `width` x `height` source: as wide or as tall as the source. */
export function fittedOutputSize(width: number, height: number, aspect: number): SourceSize {
  return width / height > aspect
    ? { width, height: Math.round(width / aspect) }
    : { width: Math.round(height * aspect), height };
}
