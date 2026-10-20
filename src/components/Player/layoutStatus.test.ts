import { describe, expect, it } from "vitest";
import { classifyLayout } from "./layoutStatus";

describe("classifyLayout", () => {
  it("shows a wide shot as wide, not as b-roll", () => {
    expect(classifyLayout("9:16", "broll", false, false, "wide")).toBe("wide");
  });

  it("keeps b-roll for a no-face shot", () => {
    expect(classifyLayout("9:16", "broll", false, false, "none")).toBe("broll");
  });

  it("keeps the rule for a close shot", () => {
    expect(classifyLayout("9:16", "single", false, false, "close")).toBe("single");
  });

  it("does not show wide during a transition", () => {
    expect(classifyLayout("9:16", "broll", true, false, "wide")).toBe("transition");
  });
});
