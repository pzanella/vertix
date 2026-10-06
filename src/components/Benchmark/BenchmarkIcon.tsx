const PATHS = {
  play: "M8 5.5v13a1 1 0 0 0 1.5.9l10.2-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5Z",
  stop: "M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z",
  replay: "M12 5V2L7.5 6.5 12 11V8a5 5 0 1 1-5 5H5a7 7 0 1 0 7-8Z",
  download: "M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V4ZM5 18h14v2H5v-2Z",
  close: "m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z",
  back: "M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12l6.6-6.6Z",
  table:
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 4v3h5V9H5Zm7 0v3h7V9h-7Zm-7 5v3h5v-3H5Zm7 0v3h7v-3h-7Z",
  warning: "M12 3 2 20h20L12 3Zm-1 6h2v5h-2V9Zm0 7h2v2h-2v-2Z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z",
  minus: "M5 11h14v2H5v-2Z",
  eye: "M12 5c5 0 8.5 4.5 9.6 7-1.1 2.5-4.6 7-9.6 7s-8.5-4.5-9.6-7C3.5 9.5 7 5 12 5Zm0 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
} as const;

export type BenchmarkIconName = keyof typeof PATHS;

export function BenchmarkIcon({ name, className = "w-3.5 h-3.5" }: { name: BenchmarkIconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="currentColor" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
