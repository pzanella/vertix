// Fails when a built bundle contains the local (licensed) clip list, so a
// deployed build never ships it. Run after `npm run build`; the deploy
// workflow does.
//
// Usage: node scripts/check-no-local-clips.mjs [dist]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_CLIPS_MARKER } from "./local-clips.mjs";

const dist = process.argv[2] ?? "dist";

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|mjs|html|json|map)$/.test(name)) yield path;
  }
}

const offending = [...files(dist)].filter((path) => readFileSync(path, "utf8").includes(LOCAL_CLIPS_MARKER));
if (process.env.VERTIX_LOCAL_CLIPS || offending.length > 0) {
  console.error(
    `Local clip list found in the build (${offending.length} file(s)${
      process.env.VERTIX_LOCAL_CLIPS ? ", VERTIX_LOCAL_CLIPS is set" : ""
    }): never deploy it.`
  );
  process.exit(1);
}
console.log("No local clip list in the build.");
