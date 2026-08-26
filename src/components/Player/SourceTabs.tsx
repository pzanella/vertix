import { useState, type ReactNode } from "react";

export type SourceTabId = "upload" | "sample" | "url";

const TABS: { id: SourceTabId; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "sample", label: "Sample" },
  { id: "url", label: "URL" },
];

interface SourceTabsProps {
  upload: ReactNode;
  sample: ReactNode;
  url: ReactNode;
}

/** 3-segment sliding-pill tab control — same pill/thumb pattern as the 16:9/9:16 switch in `Controls.tsx`, generalized to N segments. */
export function SourceTabs({ upload, sample, url }: SourceTabsProps) {
  const [active, setActive] = useState<SourceTabId>("upload");
  const activeIndex = TABS.findIndex((t) => t.id === active);

  const panels: Record<SourceTabId, ReactNode> = { upload, sample, url };

  return (
    <div className="flex flex-col gap-4 w-full max-w-lg">
      <div className="relative flex items-center h-9 rounded-full bg-neutral-800 border border-neutral-700 p-0.5 w-full">
        <span
          className="absolute top-0.5 bottom-0.5 rounded-full bg-brand-600 transition-transform duration-200 ease-out"
          style={{
            width: `calc(${100 / TABS.length}% - 2px)`,
            transform: `translateX(calc(${activeIndex} * 100% + ${activeIndex * 2}px))`,
          }}
        />
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`relative z-10 flex-1 h-full text-[11px] font-display font-medium rounded-full transition-colors ${
              active === tab.id ? "text-white" : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-[220px] flex flex-col items-center justify-center w-full">{panels[active]}</div>
    </div>
  );
}
