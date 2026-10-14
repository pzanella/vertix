import { describe, expect, it } from "vitest";
import { buildSuitePlan, type SuiteStep } from "./suitePlan";

function describeStep(step: SuiteStep): string {
  if (step.kind === "warmup") return `warmup:${step.build.variant}`;
  if (step.kind === "baseline") return "baseline";
  return `${step.clipIndex}:${step.build.variant}:${step.lookahead ? "on" : "off"}`;
}

describe("buildSuitePlan", () => {
  it("runs each clip with lookahead off on the loaded build, then on per build, without extra warm-ups", () => {
    expect(buildSuitePlan(2, true, true).map(describeStep)).toEqual([
      "warmup:simd",
      "0:simd:off",
      "0:simd:on",
      "warmup:scalar",
      "0:scalar:on",
      "1:scalar:off",
      "1:scalar:on",
      "warmup:simd",
      "1:simd:on",
      "baseline",
    ]);
  });

  it("runs off then on with the scalar build without SIMD", () => {
    expect(buildSuitePlan(1, false, false).map(describeStep)).toEqual(["warmup:scalar", "0:scalar:off", "0:scalar:on"]);
  });
});
