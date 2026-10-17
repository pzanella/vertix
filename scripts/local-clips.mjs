// Licensed clips for local measurements only, listed in .env.local
// (gitignored) as VERTIX_E2E_HLS_URLS: comma-separated entries, each
// `url`, `label|url` or `label|url|maxSeconds`. Never commit these URLs,
// and never print them: callers get them only to load the clips.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LOCAL_CLIPS_VARIABLE = "VERTIX_E2E_HLS_URLS";
// Present in a built bundle exactly when it contains a local clip list.
export const LOCAL_CLIPS_MARKER = "vertix-local-clips-included";
// A long news stream is measured over its first minutes only.
const DEFAULT_MAX_SECONDS = 120;

/** Reads one variable from the environment, else from .env.local. */
export function readLocalEnv(root, name) {
  if (process.env[name]) return process.env[name];
  const envFile = join(root, ".env.local");
  if (!existsSync(envFile)) return "";
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && match[1] === name) return match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return "";
}

/** The local clips as `{ label, url, maxSeconds }`, labelled "local-<n>" plus the given label. */
export function readLocalClips(root) {
  return readLocalEnv(root, LOCAL_CLIPS_VARIABLE)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const parts = entry.split("|").map((part) => part.trim());
      const [label, url, maxSeconds] = parts.length === 1 ? ["", parts[0], ""] : parts;
      const name = label ? `local-${index + 1}-${label.replace(/[^A-Za-z0-9_-]+/g, "-")}` : `local-${index + 1}`;
      return { label: name, url, maxSeconds: Number(maxSeconds) > 0 ? Number(maxSeconds) : DEFAULT_MAX_SECONDS };
    });
}
