import { useId } from "react";
import type { BenchmarkConfig } from "../../core";
import { SAMPLE_CLIPS } from "../Player/sampleClips";
import {
  CLIP_WARMUP_RANGE,
  WASM_WARMUP_RANGE,
  clampToRange,
  estimateSuiteSeconds,
  type SecondsRange,
} from "./benchmarkConfig";
import { BenchmarkIcon } from "./BenchmarkIcon";
import { benchmarkStageKinds, TONE_CHIP, VERDICT_LABEL, VERDICT_TONE, type BenchmarkVerdict } from "./benchmarkOutcome";
import { BenchmarkPanelHeader } from "./BenchmarkPanelHeader";
import { BenchmarkStageRail } from "./BenchmarkStageRail";
import { GHOST_BUTTON, PRIMARY_BUTTON } from "./benchmarkStyles";

interface BenchmarkReadyViewProps {
  titleId: string;
  config: BenchmarkConfig;
  onConfigChange: React.Dispatch<React.SetStateAction<BenchmarkConfig>>;
  hasSource: boolean;
  /** Verdict of the last finished run, if any, to offer its results. */
  lastVerdict: BenchmarkVerdict | null;
  onRunSuite: () => void;
  onRunCurrentClip: () => void;
  onShowResults: () => void;
  onClose: () => void;
}

const STEP_BUTTON =
  "grid place-items-center w-7 h-7 rounded-full text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 active:scale-90 transition disabled:opacity-30 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70";

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes > 0 ? `~${minutes}m ${rest.toString().padStart(2, "0")}s` : `~${rest}s`;
}

function formatSeconds(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}s`;
}

interface SecondsStepperProps {
  label: string;
  hint: string;
  value: number;
  range: SecondsRange;
  onChange: (value: number) => void;
}

function SecondsStepper({ label, hint, value, range, onChange }: SecondsStepperProps) {
  const labelId = useId();
  const step = (direction: 1 | -1) => onChange(clampToRange(value + direction * range.step, range));

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex flex-col gap-1 rounded-xl border border-neutral-800 bg-neutral-900/50 p-2"
    >
      <span id={labelId} className="truncate text-[11px] text-neutral-500">
        {label}
      </span>
      <div className="flex items-center justify-between">
        <button
          type="button"
          className={STEP_BUTTON}
          onClick={() => step(-1)}
          disabled={value <= range.min}
          aria-label={`Decrease ${label}`}
        >
          <BenchmarkIcon name="minus" className="w-3 h-3" />
        </button>
        <output aria-live="polite" className="font-display text-sm font-semibold tabular-nums text-neutral-100">
          {formatSeconds(value)}
        </output>
        <button
          type="button"
          className={STEP_BUTTON}
          onClick={() => step(1)}
          disabled={value >= range.max}
          aria-label={`Increase ${label}`}
        >
          <BenchmarkIcon name="plus" className="w-3 h-3" />
        </button>
      </div>
      <span className="truncate text-[11px] text-neutral-500">{hint}</span>
    </div>
  );
}

function BaselineSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex flex-col gap-1 rounded-xl border border-neutral-800 bg-neutral-900/50 p-2 text-left hover:border-neutral-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70"
    >
      <span className="truncate text-[11px] text-neutral-500">16:9 baseline</span>
      <span className="flex h-7 items-center justify-center">
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-brand-500" : "bg-neutral-700"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-neutral-50 shadow motion-safe:transition-transform ${
              checked ? "translate-x-4" : ""
            }`}
          />
        </span>
      </span>
      <span className="truncate text-[11px] text-neutral-500">{checked ? "plain playback" : "skipped"}</span>
    </button>
  );
}

export function BenchmarkReadyView({
  titleId,
  config,
  onConfigChange,
  hasSource,
  lastVerdict,
  onRunSuite,
  onRunCurrentClip,
  onShowResults,
  onClose,
}: BenchmarkReadyViewProps) {
  const stageCount = 1 + SAMPLE_CLIPS.length + (config.baseline ? 1 : 0);
  const update = (patch: Partial<BenchmarkConfig>) => onConfigChange((current) => ({ ...current, ...patch }));

  return (
    <>
      <BenchmarkPanelHeader
        titleId={titleId}
        title="Benchmark"
        accessory={
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-300">
            {formatDuration(estimateSuiteSeconds(config))}
          </span>
        }
        onClose={onClose}
      />

      <div className="min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-3 px-4 pb-4">
        <p className="leading-relaxed text-neutral-400">
          Plays the {SAMPLE_CLIPS.length} sample clips back to back in 9:16
          {config.baseline ? ", then one 16:9 baseline without detection" : ""}, at normal speed. The panel closes so
          you can watch the player; progress shows on the gauge.
        </p>

        <BenchmarkStageRail kinds={benchmarkStageKinds(stageCount, config)} />

        <div className="grid grid-cols-3 gap-1.5">
          <SecondsStepper
            label="WASM warm-up"
            hint="not recorded"
            value={config.wasmWarmupSec}
            range={WASM_WARMUP_RANGE}
            onChange={(wasmWarmupSec) => update({ wasmWarmupSec })}
          />
          <SecondsStepper
            label="Clip warm-up"
            hint="excluded"
            value={config.clipWarmupSec}
            range={CLIP_WARMUP_RANGE}
            onChange={(clipWarmupSec) => update({ clipWarmupSec })}
          />
          <BaselineSwitch checked={config.baseline} onChange={(baseline) => update({ baseline })} />
        </div>

        <p className="flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-2.5 py-2 text-amber-200/90">
          <BenchmarkIcon name="eye" className="mt-px w-3.5 h-3.5 text-amber-300" />
          Keep this tab visible and the screen on until the run ends, or the results are flagged invalid.
        </p>

        <div className="flex flex-col gap-2">
          <button type="button" data-autofocus className={`${PRIMARY_BUTTON} w-full h-10 text-sm`} onClick={onRunSuite}>
            <BenchmarkIcon name="play" />
            Run suite
          </button>
          <p className="text-center text-[11px] text-neutral-500">The suite replaces the video currently loaded.</p>
          <button
            type="button"
            className={`${GHOST_BUTTON} w-full`}
            onClick={onRunCurrentClip}
            disabled={!hasSource}
            title="Rewind and benchmark the loaded clip"
          >
            <BenchmarkIcon name="replay" />
            Run current clip
          </button>
        </div>

        {lastVerdict && (
          <button
            type="button"
            onClick={onShowResults}
            className="group flex items-center gap-2 rounded-xl border border-neutral-800 px-3 py-2 text-left hover:border-neutral-600 transition"
          >
            <BenchmarkIcon name="table" className="w-4 h-4 text-neutral-500" />
            <span className="flex-1 text-neutral-300">Last results</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CHIP[VERDICT_TONE[lastVerdict]]}`}
            >
              {VERDICT_LABEL[lastVerdict]}
            </span>
            <BenchmarkIcon
              name="back"
              className="w-3.5 h-3.5 rotate-180 text-neutral-500 group-hover:text-neutral-200"
            />
          </button>
        )}
      </div>
    </>
  );
}
