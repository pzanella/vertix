import { BenchmarkIcon } from "./BenchmarkIcon";

interface BenchmarkPanelHeaderProps {
  titleId: string;
  title: string;
  accessory?: React.ReactNode;
  leading?: React.ReactNode;
  onClose: () => void;
}

export function BenchmarkPanelHeader({ titleId, title, accessory, leading, onClose }: BenchmarkPanelHeaderProps) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
      {leading}
      <h2 id={titleId} className="text-sm font-display font-semibold tracking-tight text-neutral-100">
        {title}
      </h2>
      {accessory}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close benchmark panel"
        className="ml-auto grid place-items-center w-8 h-8 -mr-1.5 rounded-full text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800 active:scale-95 transition"
      >
        <BenchmarkIcon name="close" className="w-4 h-4" />
      </button>
    </div>
  );
}
