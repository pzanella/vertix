import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { LOCAL_CLIPS_MARKER, readLocalClips } from "./scripts/local-clips.mjs";
import { PAGE_CONTENT_SECURITY_POLICY } from "./scripts/lib/content-security-policy.mjs";

interface LocalClip {
  label: string;
  url: string;
  maxSeconds: number;
  /** LOCAL_CLIPS_MARKER, on every entry so it survives minification. */
  marker: string;
}

/**
 * Licensed clips from .env.local for the in-app benchmark: always in the
 * dev server, in a build only with VERTIX_LOCAL_CLIPS=1 (a local
 * production build for measurements). Never in CI: the deploy workflow
 * also checks the built bundle for LOCAL_CLIPS_MARKER.
 */
function localClips(command: "serve" | "build", mode: string): LocalClip[] {
  const wanted = mode !== "test" && (command === "serve" || process.env.VERTIX_LOCAL_CLIPS === "1");
  if (!wanted) return [];
  if (command === "build" && process.env.CI) {
    throw new Error("VERTIX_LOCAL_CLIPS=1 is for local builds only, never in CI");
  }
  const clips: LocalClip[] = readLocalClips(process.cwd()).map((clip: Omit<LocalClip, "marker">) => ({
    ...clip,
    marker: LOCAL_CLIPS_MARKER,
  }));
  if (command === "build" && clips.length > 0) {
    console.log(`[vertix] local clips included in this build: ${clips.length}`);
  }
  return clips;
}

/** Adds the page's Content Security Policy right after <meta charset>, before any script or stylesheet of the built index.html. */
function contentSecurityPolicy(): Plugin {
  const charset = '<meta charset="UTF-8" />';
  return {
    name: "vertix-content-security-policy",
    apply: "build",
    transformIndexHtml(html) {
      if (!html.includes(charset)) throw new Error(`index.html: ${charset} not found for the CSP meta tag`);
      const policy = PAGE_CONTENT_SECURITY_POLICY.replaceAll("'", "&#39;");
      return html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), contentSecurityPolicy()],
  define: {
    __VERTIX_LOCAL_CLIPS__: JSON.stringify(localClips(command, mode)),
  },
  optimizeDeps: {
    exclude: ["wasm"],
  },
  assetsInclude: ["**/*.wasm"],
}));
