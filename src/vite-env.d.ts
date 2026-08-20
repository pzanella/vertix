/// <reference types="vite/client" />

interface HTMLVideoElement {
  /** Missing from TS's DOM lib — supported in all evergreen browsers. */
  captureStream(frameRate?: number): MediaStream;
}
