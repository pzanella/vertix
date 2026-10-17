import { describe, expect, it } from "vitest";
import type { BenchmarkClipResult } from "./BenchmarkRecorder";
import { BenchmarkRunError } from "./runClip";
import type { BenchmarkFailure } from "./resourceStats";
import { runSuiteSteps, type StepContext, type SuiteStepRunner } from "./suiteRunner";
import type { SuiteStep } from "./suitePlan";

const build = { variant: "simd" as const, reason: "benchmark-suite" as const, runOrder: null };
const steps: SuiteStep[] = [
  { kind: "clip", clipIndex: 0, build, lookahead: true },
  { kind: "warmup", clipIndex: 1, build },
  { kind: "clip", clipIndex: 1, build, lookahead: true },
];

const loadFailure: BenchmarkFailure = {
  name: "Error",
  message: "Source did not load within 30 s",
  stack: null,
  step: null,
  clip: "clip-0",
  build: "simd",
  lookahead: true,
  mode: "9:16",
  failedAt: "2026-10-17T00:00:00.000Z",
  resources: null,
  video: null,
};

function runner(record: (step: SuiteStep, context: StepContext) => Promise<BenchmarkClipResult>): SuiteStepRunner {
  return {
    describe: (step, index, total) => ({
      step: { index, total, kind: step.kind, label: `step ${index}` },
      clip: `clip-${step.clipIndex}`,
      build: "simd",
      lookahead: true,
      mode: "9:16",
    }),
    warmup: async () => {},
    record,
    failureDetails: async () => ({ resources: null, video: null }),
  };
}

const result = (clip: string) => ({ clip }) as unknown as BenchmarkClipResult;

describe("runSuiteSteps", () => {
  it("records a step whose source never loads and moves on to the next steps", async () => {
    const outcome = await runSuiteSteps(
      steps,
      runner(async (step) => {
        if (step.clipIndex === 0) throw new BenchmarkRunError(loadFailure, null, new Error("timeout"));
        return result(`clip-${step.clipIndex}`);
      })
    );
    expect(outcome.results.map((r) => r.clip)).toEqual(["clip-1"]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      message: "Source did not load within 30 s",
      step: { index: 0, total: 3, kind: "clip" },
    });
  });

  it("keeps what a failed run recorded, with its failure", async () => {
    const outcome = await runSuiteSteps(
      steps,
      runner(async (step) => {
        if (step.clipIndex === 0) {
          throw new BenchmarkRunError(loadFailure, result("clip-0 (partial)"), new Error("stalled"));
        }
        return result(`clip-${step.clipIndex}`);
      })
    );
    expect(outcome.results.map((r) => r.clip)).toEqual(["clip-0 (partial)", "clip-1"]);
    expect(outcome.results[0].failure?.step?.index).toBe(0);
  });

  it("describes an unexpected error with the step it happened in", async () => {
    const outcome = await runSuiteSteps(
      steps,
      runner(async (step) => {
        if (step.clipIndex === 1) throw new TypeError("boom");
        return result("clip-0");
      })
    );
    expect(outcome.failures[0]).toMatchObject({
      name: "TypeError",
      message: "boom",
      clip: "clip-1",
      step: { index: 2 },
    });
  });

  it("stops on a cancel, keeping what finished", async () => {
    const outcome = { results: [], failures: [] };
    const run = runSuiteSteps(
      steps,
      runner(async (step) => {
        if (step.clipIndex === 1) throw new DOMException("Benchmark cancelled", "AbortError");
        return result("clip-0");
      }),
      outcome
    );
    await expect(run).rejects.toThrow("Benchmark cancelled");
    expect(outcome.results).toHaveLength(1);
  });
});
