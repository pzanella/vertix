// Licensed clips for local measurements only, listed in .env.local
// (gitignored) as VERTIX_E2E_HLS_URLS: comma-separated entries, each
// `url`, `label|url` or `label|url|maxSeconds`. A url is either a stream
// (http or https) or a file on this machine. Never commit these, and never
// print them: callers get them only to load the clips.
//
// A file is served by the dev server and by `vite preview` under
// /local-clips/<name>, by name only: the path stays on the server and never
// reaches the page or the build.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const LOCAL_CLIPS_VARIABLE = "VERTIX_E2E_HLS_URLS";
// Present in a built bundle exactly when it contains a local clip list.
export const LOCAL_CLIPS_MARKER = "vertix-local-clips-included";
export const LOCAL_CLIP_ROUTE = "/local-clips/";
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

function localClipEntries(root) {
  return readLocalEnv(root, LOCAL_CLIPS_VARIABLE)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const parts = entry.split("|").map((part) => part.trim());
      const [label, source, maxSeconds] = parts.length === 1 ? ["", parts[0], ""] : parts;
      const name = label ? `local-${index + 1}-${label.replace(/[^A-Za-z0-9_-]+/g, "-")}` : `local-${index + 1}`;
      return { name, source, maxSeconds: Number(maxSeconds) > 0 ? Number(maxSeconds) : DEFAULT_MAX_SECONDS };
    });
}

const isFileSource = (source) => !/^https?:\/\//i.test(source);

/** The local clips as `{ label, url, maxSeconds }`: streams as they are, files as their /local-clips/ route. */
export function readLocalClips(root) {
  return localClipEntries(root).map(({ name, source, maxSeconds }) => ({
    label: name,
    url: isFileSource(source) ? `${LOCAL_CLIP_ROUTE}${name}` : source,
    maxSeconds,
  }));
}

/** The clips that are files on this machine, as `{ name, file }` with the file's absolute path (server side only). */
export function readLocalClipFiles(root) {
  return localClipEntries(root)
    .filter(({ source }) => isFileSource(source))
    .map(({ name, source }) => ({ name, file: isAbsolute(source) ? source : resolve(root, source) }));
}

/** Serves a local clip file by name, with HTTP Range (206) for seeking; any other request goes on to `next`. */
export function localClipMiddleware(root) {
  return (req, res, next) => {
    if (!req.url?.startsWith(LOCAL_CLIP_ROUTE)) return next();
    const name = decodeURIComponent(req.url.slice(LOCAL_CLIP_ROUTE.length).split("?")[0]);
    const clip = readLocalClipFiles(root).find((candidate) => candidate.name === name);
    if (!clip || !existsSync(clip.file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    sendFile(req, res, clip.file);
  };
}

function sendFile(req, res, file) {
  const size = statSync(file).size;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "video/mp4");
  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }
  if (range) {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader("Content-Length", range.end - range.start + 1);
    createReadStream(file, range).pipe(res);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", size);
  createReadStream(file).pipe(res);
}

/** The byte range of a `bytes=` Range header (single range), null without one, "unsatisfiable" when it is outside the file. */
function parseRange(header, size) {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start;
  let end;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? "unsatisfiable" : { start, end };
}
