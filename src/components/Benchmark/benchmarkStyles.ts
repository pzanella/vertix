const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-full text-xs font-medium active:scale-[0.97] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70 disabled:opacity-40 disabled:pointer-events-none";

export const PRIMARY_BUTTON = `${BUTTON_BASE} bg-brand-500 font-semibold text-neutral-950 hover:bg-brand-400 shadow-[0_0_16px_-6px] shadow-brand-400/70`;
export const TONAL_BUTTON = `${BUTTON_BASE} border border-brand-500/30 bg-brand-500/10 text-brand-200 hover:bg-brand-500/20`;
export const GHOST_BUTTON = `${BUTTON_BASE} border border-neutral-800 text-neutral-300 hover:border-neutral-600 hover:text-neutral-100`;
export const DANGER_BUTTON = `${BUTTON_BASE} border border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20`;
