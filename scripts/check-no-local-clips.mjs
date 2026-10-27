// Fails when a built bundle contains the local (licensed) clip list, so a
// deployed build never ships it. Also fails when the bundle names a local
// clip file's path, or the local clip route, without the list. Run after
// `npm run build`; the deploy workflow does.
//
// Usage: node scripts/check-no-local-clips.mjs [dist]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_CLIPS_MARKER, LOCAL_CLIP_ROUTE, readLocalClipFiles } from "./local-clips.mjs";

const dist = process.argv[2] ?? "dist";

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|mjs|html|json|map)$/.test(name)) yield path;
  }
}

const contents = [...files(dist)].map((path) => ({ path, text: readFileSync(path, "utf8") }));
const withList = contents.filter(({ text }) => text.includes(LOCAL_CLIPS_MARKER));
const localFilePaths = readLocalClipFiles(process.cwd()).map(({ file }) => file);
const withFilePath = contents.filter(({ text }) => localFilePaths.some((file) => text.includes(file)));
const withRoute = contents.filter(({ text }) => text.includes(LOCAL_CLIP_ROUTE));

if (process.env.VERTIX_LOCAL_CLIPS || withList.length > 0) {
  console.error(
    `Local clip list found in the build (${withList.length} file(s)${
      process.env.VERTIX_LOCAL_CLIPS ? ", VERTIX_LOCAL_CLIPS is set" : ""
    }): never deploy it.`
  );
  process.exit(1);
}
if (withFilePath.length > 0 || withRoute.length > 0) {
  console.error("Local clip file path or route found in a build without the local clip list: never deploy it.");
  process.exit(1);
}
console.log("No local clip list in the build.");
