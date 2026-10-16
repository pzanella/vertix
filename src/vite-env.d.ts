/// <reference types="vite/client" />

interface HTMLVideoElement {
  /** Missing from TS's DOM lib — supported in all evergreen browsers. */
  captureStream(frameRate?: number): MediaStream;
}

/** Licensed clips from .env.local (dev server, or a build with VERTIX_LOCAL_CLIPS=1), else empty. See vite.config.ts. */
declare const __VERTIX_LOCAL_CLIPS__: { label: string; url: string; maxSeconds: number; marker: string }[];
