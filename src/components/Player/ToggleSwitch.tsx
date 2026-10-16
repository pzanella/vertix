interface ToggleSwitchProps {
  label: string;
  /** Accessible name, when the visible label is not enough. */
  ariaLabel?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** A small labelled on/off switch row, sized like a MetricRow. */
export function ToggleSwitch({ label, ariaLabel, checked, onChange }: ToggleSwitchProps) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-neutral-500">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? label}
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 shrink-0 self-center rounded-full transition-colors ${
          checked ? "bg-brand-600" : "bg-neutral-700"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
            checked ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
