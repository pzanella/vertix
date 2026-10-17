import { describe, expect, it } from "vitest";
import { displayedSourceSize, fittedOutputSize, isShownAsIs } from "./sourceAspect";

describe("isShownAsIs", () => {
  it("shows portrait and square sources whole, and crops 4:3 and wider", () => {
    expect(isShownAsIs(1080, 1920)).toBe(true);
    expect(isShownAsIs(1080, 1080)).toBe(true);
    expect(isShownAsIs(1100, 1000)).toBe(true);
    expect(isShownAsIs(1440, 1080)).toBe(false);
    expect(isShownAsIs(1920, 1080)).toBe(false);
  });

  it("decides nothing before the size is known", () => {
    expect(isShownAsIs(0, 0)).toBe(false);
  });
});

describe("displayedSourceSize", () => {
  it("uses the frame metadata when it agrees with the element", () => {
    expect(displayedSourceSize(1280, 720, 1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it("uses the element's size when the metadata is the unrotated coded size of a rotated phone video", () => {
    expect(displayedSourceSize(1920, 1080, 1080, 1920)).toEqual({ width: 1080, height: 1920 });
  });

  it("falls back to the element's size without metadata", () => {
    expect(displayedSourceSize(undefined, undefined, 720, 1280)).toEqual({ width: 720, height: 1280 });
  });
});

describe("fittedOutputSize", () => {
  it("pillarboxes a portrait source in 16:9 and letterboxes a square one in 9:16", () => {
    expect(fittedOutputSize(1080, 1920, 16 / 9)).toEqual({ width: 3413, height: 1920 });
    expect(fittedOutputSize(1080, 1080, 9 / 16)).toEqual({ width: 1080, height: 1920 });
    expect(fittedOutputSize(1080, 1920, 9 / 16)).toEqual({ width: 1080, height: 1920 });
  });
});
