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
export { LAYOUT_RULES } from "./tracking/layoutPlanner";
export type { LayoutRule, TrackSnapshot } from "./tracking/layoutPlanner";
export { PANEL_VARIANT } from "./tracking/panelDetector";
export type { PanelVariant } from "./tracking/panelDetector";
export { LOOKAHEAD_ON_BY_DEFAULT, getActiveWasmBuild, switchWasmBuild } from "./VertixEngine";
export { defaultWasmBuild, isWasmSimdSupported, WASM_BINARY_SIZES } from "./wasmBuild";
export { detectDeviceClass, MAX_LOOKAHEAD_MS } from "./lookahead/lookaheadSizing";
export type { DeviceClass } from "./lookahead/lookaheadSizing";
export type {
  DetectionObserver,
  DetectionTick,
  DetectionTickTrack,
  LookaheadLengths,
  OverlayFrame,
  OverlayRenderer,
  OverlayView,
} from "./hostHooks";
export type { WasmBuildReason, WasmBuildSelection, WasmBuildVariant } from "./wasmBuild";
