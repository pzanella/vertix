// Lists the hosts of every request in a HAR file (e.g. exported from
// DevTools over chrome://inspect on a phone) other than the app's own, so a
// face mesh run can be checked for third-party requests. Hosts of the
// licensed clips in .env.local are counted under "local clips" and never
// printed.
//
// Usage: node scripts/check-har.mjs <capture.har> [--app=localhost:4174]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalClips } from "./local-clips.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [harPath, ...rest] = process.argv.slice(2);
const appHost = rest.find((a) => a.startsWith("--app="))?.slice(6) ?? null;
const localClipHosts = new Set(readLocalClips(root).map((clip) => new URL(clip.url).host));

const entries = JSON.parse(readFileSync(harPath, "utf8")).log.entries;
const counts = new Map();
let own = 0;
for (const entry of entries) {
  let url;
  try {
    url = new URL(entry.request.url);
  } catch {
    continue;
  }
  if (!url.protocol.startsWith("http")) continue;
  const host = url.host;
  if (host === appHost || (!appHost && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
    own += 1;
    continue;
  }
  const key = localClipHosts.has(host) ? "local clips (licensed, host not shown)" : host;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log(`${entries.length} requests, ${own} to the app's own origin`);
if (counts.size === 0) console.log("No request to another origin.");
for (const [host, count] of counts) console.log(`${host}: ${count}`);
const thirdParty = [...counts.keys()].filter((h) => !h.startsWith("local clips"));
if (thirdParty.length > 0) process.exitCode = 1;
