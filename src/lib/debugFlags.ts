/**
 * Opt-in debug views, enabled from the page URL: `?debug=skin`, or several
 * at once with `?debug=skin&debug=other`. Read once at load; they are not
 * meant for normal viewers, so nothing in the UI links to them.
 */
export type DebugFlag = "skin";

export function isDebugFlagEnabled(search: string, flag: DebugFlag): boolean {
  return new URLSearchParams(search).getAll("debug").includes(flag);
}

/** Shows the skin-filter section in the dashboard and draws skin-rejected detections on the video. */
export const SKIN_FILTER_DEBUG = isDebugFlagEnabled(window.location.search, "skin");
