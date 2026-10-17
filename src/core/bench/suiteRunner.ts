import type { BenchmarkClipResult } from "./BenchmarkRecorder";
import { BenchmarkRunError } from "./runClip";
import { describeError, type BenchmarkFailure } from "./resourceStats";
import type { SuiteStep } from "./suitePlan";

/** Where a step sits in the suite, and what it plays: for progress and for a failure's context. */
export interface StepContext {
  step: NonNullable<BenchmarkFailure["step"]>;
  clip: string;
  build: string;
  lookahead: boolean | null;
  mode: "9:16" | "16:9";
}

export interface SuiteStepRunner {
  /** Describes step `index` (label, clip, build, mode), before it runs. */
  describe(step: SuiteStep, index: number, total: number): StepContext;
  /** Switches the WASM build and plays the unrecorded warm-up. */
  warmup(step: Extract<SuiteStep, { kind: "warmup" }>, context: StepContext): Promise<void>;
  /** Plays and records one clip or baseline run. */
  record(step: Exclude<SuiteStep, { kind: "warmup" }>, context: StepContext): Promise<BenchmarkClipResult>;
  /** Fills in what the failure of a step that threw something other than a BenchmarkRunError lacks (resources, video state). */
  failureDetails(): Promise<Pick<BenchmarkFailure, "resources" | "video">>;
  onStep?(context: StepContext): void;
}

export interface SuiteOutcome {
  results: BenchmarkClipResult[];
  failures: BenchmarkFailure[];
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Runs every step. A step that fails is recorded (its failure, and what the
 * run recorded until then) and the suite moves on to the next step; only a
 * cancel stops it. `outcome` is filled as steps finish, so a caller still
 * has the partial outcome if this rejects on a cancel.
 */
export async function runSuiteSteps(
  steps: readonly SuiteStep[],
  runner: SuiteStepRunner,
  outcome: SuiteOutcome = { results: [], failures: [] }
): Promise<SuiteOutcome> {
  for (const [index, step] of steps.entries()) {
    const context = runner.describe(step, index, steps.length);
    runner.onStep?.(context);
    try {
      if (step.kind === "warmup") await runner.warmup(step, context);
      else outcome.results.push(await runner.record(step, context));
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof BenchmarkRunError) {
        const failure: BenchmarkFailure = { ...error.failure, step: context.step };
        outcome.failures.push(failure);
        if (error.partial) outcome.results.push({ ...error.partial, failure });
      } else {
        outcome.failures.push({
          ...describeError(error),
          ...context,
          failedAt: new Date().toISOString(),
          ...(await runner.failureDetails()),
        });
      }
    }
  }
  return outcome;
}
