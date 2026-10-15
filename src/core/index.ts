export { VertixEngine, INITIAL_METRICS } from "./VertixEngine";
export type {
  LookaheadLengthSource,
  LookaheadStatus,
  LookaheadUnavailableReason,
  VertixMode,
  VertixMeta,
  VertixMetrics,
  VertixState,
} from "./VertixEngine";
export {
  computeSpeakerLayout,
  unpackDetections,
  unpackFaces,
  faceVisibleFraction,
  lerpPaneRectInto,
  paneSmoothingAlpha,
} from "./layoutEngine";
export type { FaceBox, PaneRect, SpeakerPane, PaneTarget, UnpackedDetections } from "./layoutEngine";
export * from "./bench";
export type { CutSource } from "./lookahead/decisionTimeline";
export { LOOKAHEAD_ON_BY_DEFAULT, getActiveWasmBuild, switchWasmBuild } from "./VertixEngine";
export { defaultWasmBuild, isWasmSimdSupported, WASM_BINARY_SIZES } from "./wasmBuild";
export type { WasmBuildReason, WasmBuildSelection, WasmBuildVariant } from "./wasmBuild";
