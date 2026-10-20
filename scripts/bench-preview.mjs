// Runs the in-app benchmark suite on a production build in a visible
// Chrome window on this machine: serves root/dist with `vite preview`,
// opens the app, loads the first sample so the dashboard shows, optionally
// turns "Face mesh" on, clicks "Run suite" and saves the finished report
// (window.vertixBenchmarkReport).
// Keep the window visible until it ends: a hidden page invalidates runs.
//
// Usage (after a production build, e.g. `VERTIX_LOCAL_CLIPS=1 npm run build`):
//   node scripts/bench-preview.mjs [--mesh=on|off] [--root=<checkout>] [--label=<name>]
// --root runs another checkout's build (e.g. a worktree of main); --mesh=on
// needs a build with the switch.
// The report goes to .eval/bench-<label>.json (gitignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHROME, runInHeadlessChrome } from "./lib/headless-chrome.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(option("root") ?? here);
const mesh = option("mesh") ?? "off";
const label = option("label") ?? `mesh-${mesh}`;

/** Runs in the app page: drives the UI like a person would. */
async function runInPage(mesh) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (find, what, timeoutMs = 60000) => {
    const until = performance.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found) return found;
      if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
      await sleep(200);
    }
  };
  const buttonWithText = (text) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes(text));
  const switchNamed = (name) => document.querySelector(`button[role="switch"][aria-label="${name}"]`);

  (await waitFor(() => buttonWithText("Sample"), "the Sample tab")).click();
  const sample = await waitFor(() => document.querySelector("button img[alt]")?.closest("button"), "the sample picker");
  sample.click();
  if (mesh === "on") {
    (await waitFor(() => switchNamed("Face mesh"), "the Face mesh switch")).click();
    const state = () => {
      const label = [...document.querySelectorAll("span")].find((s) => s.textContent.trim() === "State");
      return label?.nextElementSibling?.textContent.trim() ?? "";
    };
    await waitFor(() => /^(ready|failed)/.test(state()), "the face mesh to load");
    if (state().startsWith("failed")) throw new Error(`face mesh ${state()}`);
    console.log("[check] face mesh ready");
  }
  window.vertixBenchmarkReport = undefined;
  (await waitFor(() => document.querySelector("button[aria-expanded]"), "the benchmark button")).click();
  (await waitFor(() => buttonWithText("Run suite"), "Run suite")).click();
  console.log("[check] suite started");
  const report = await waitFor(() => window.vertixBenchmarkReport, "the suite to finish", 90 * 60 * 1000);
  return report;
}

try {
  const report = await runInHeadlessChrome({
    root,
    pageFunction: runInPage,
    args: [mesh],
    chromePath: option("chrome") ?? DEFAULT_CHROME,
    headed: true,
    productionPreview: true,
    timeoutMs: 100 * 60 * 1000,
  });
  mkdirSync(join(here, ".eval"), { recursive: true });
  writeFileSync(join(here, `.eval/bench-${label}.json`), JSON.stringify(report));
  console.log(
    `[check] ${report.results.length} runs, ${report.failures.length} failures, hidden: ${report.results.filter((r) => r.pageHiddenDuringRun).length}`
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.exit();
}
