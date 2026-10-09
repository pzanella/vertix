import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", { location: { search: "" } });
const { isDebugFlagEnabled } = await import("./debugFlags");

describe("isDebugFlagEnabled", () => {
  it("is off without a debug parameter", () => {
    expect(isDebugFlagEnabled("", "skin")).toBe(false);
    expect(isDebugFlagEnabled("?foo=skin", "skin")).toBe(false);
  });

  it("is on for ?debug=skin, alone or next to other flags", () => {
    expect(isDebugFlagEnabled("?debug=skin", "skin")).toBe(true);
    expect(isDebugFlagEnabled("?debug=other&debug=skin", "skin")).toBe(true);
  });
});
