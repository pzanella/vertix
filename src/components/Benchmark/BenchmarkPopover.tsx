import { useEffect, useRef } from "react";

interface BenchmarkPopoverProps {
  id: string;
  labelledBy: string;
  /** Widens the desktop popover (results table) and dims the page behind it. */
  wide: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet below `sm`, popover anchored under the trigger above it.
 * The parent must be `relative` so the desktop variant can anchor to it.
 */
export function BenchmarkPopover({ id, labelledBy, wide, onClose, children }: BenchmarkPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const preferred = panel?.querySelector<HTMLElement>("[data-autofocus]:not([disabled])");
    (preferred ?? panel)?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const panel = panelRef.current;
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/60 ${wide ? "sm:bg-black/40" : "sm:bg-transparent"}`}
      />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`fixed inset-x-0 bottom-0 z-50 flex flex-col max-h-[88dvh] rounded-t-2xl border-t border-neutral-800 bg-neutral-950/95 backdrop-blur-xl shadow-2xl shadow-black/60 pb-[env(safe-area-inset-bottom)] text-xs text-neutral-300 outline-none sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2.5 sm:pb-0 sm:rounded-2xl sm:border sm:max-h-[min(calc(100dvh-6rem),46rem)] ${
          wide ? "sm:w-[min(56rem,calc(100vw-2rem))]" : "sm:w-[22rem]"
        }`}
      >
        <span aria-hidden="true" className="sm:hidden mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-neutral-700" />
        {children}
      </div>
    </>
  );
}
