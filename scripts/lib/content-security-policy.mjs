// The page's Content Security Policy, injected as a <meta> tag into the
// production build only (the dev server needs inline scripts and a
// WebSocket for HMR). GitHub Pages cannot send headers, so the meta tag is
// the whole policy.
//
// Scripts, styles, fonts, images and workers come from this origin only.
// Media and connections also allow https: so a user-entered stream URL
// (Shaka: manifests and segments by fetch, MSE through blob:) keeps
// working. The face mesh worker gets a stricter policy of its own, from
// public/face-mesh/host.html (connect-src 'self').
export const PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https: blob: data:",
  "media-src 'self' https: blob: data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
