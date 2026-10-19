// Browser checks for the "Face mesh" demo switch on the production build
// (run `npm run build` first), in Chrome over the DevTools protocol, with
// every request and every browser log entry of the page, its frames and its
// workers recorded:
//
//   --scenario=off      a sample plays with the switch never turned on:
//                       nothing of the face mesh may be requested.
//   --scenario=network  a sample loops for --seconds (default 75, past
//                       MediaPipe's 60 s metrics interval) with the switch
//                       on, through both modes; then two probes check the
//                       worker's own CSP. 0 third-party requests expected.
//   --scenario=suite    the switch on, then the whole benchmark suite
//                       (build without VERTIX_LOCAL_CLIPS, so only the
//                       sample and test clips play). 0 third-party requests
//                       expected.
//   --scenario=players  the switch on, then every kind of source: a sample,
//                       an uploaded file, an MP4 URL, a public HLS stream
//                       and a public DASH stream (Shaka), each in both modes.
//                       Reports every CSP violation.
//
// Usage: node scripts/check-face-mesh.mjs --scenario=<name> [--headed] [--seconds=<n>] [--chrome=<path>]
// Results go to stdout and .eval/face-mesh-<scenario>.json (gitignored).
// Only hosts are reported for third-party requests, never full URLs.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHROME, runInHeadlessChrome } from "./lib/headless-chrome.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const scenario = option("scenario") ?? "network";
const seconds = Number(option("seconds") ?? 75);

// Public test streams for the players scenario (third-party by design: the page allows https: media).
const PUBLIC_HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const PUBLIC_DASH = "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd";
// Probe origin: .invalid never resolves, so a probe that gets past CSP fails on DNS, not on the policy.
const PROBE_URL = "https://vertix-csp-probe.invalid/collect";

/** Runs in the app page and drives the UI like a person would. */
async function runInPage({ scenario, seconds, publicHls, publicDash, probeUrl }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (text) => console.log(`[check] ${text}`);
  const waitFor = async (find, what, timeoutMs = 60000) => {
    const until = performance.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found) return found;
      if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
      await sleep(200);
    }
  };
  const buttons = () => [...document.querySelectorAll("button")];
  const buttonWithText = (text) => buttons().find((b) => b.textContent.trim().includes(text));
  const switchNamed = (name) => document.querySelector(`button[role="switch"][aria-label="${name}"]`);
  const video = () => document.querySelector("video");
  const rowValue = (label) => {
    const row = [...document.querySelectorAll("span")].find((s) => s.textContent.trim() === label);
    return row?.nextElementSibling?.textContent.trim() ?? null;
  };
  const iframe = () => document.querySelector('iframe[title="Face mesh worker host"]');

  const openSourceTab = async (tab) => {
    if (buttonWithText("Change source")) buttonWithText("Change source").click();
    (
      await waitFor(
        () => buttons().find((b) => b.getAttribute("role") === "tab" && b.textContent.includes(tab)),
        `the ${tab} tab`
      )
    ).click();
  };
  const playing = async (what) => {
    await waitFor(() => video() && !video().paused && video().currentTime > 0.5, `${what} to play`, 90000);
    // Long enough for MediaPipe's 60 s metrics interval; never during the suite (its clips must end).
    video().loop = scenario !== "suite";
  };
  const loadSample = async (title) => {
    await openSourceTab("Sample");
    const sample = await waitFor(
      () => buttons().find((b) => b.querySelector("img") && (!title || b.textContent.includes(title))),
      "a sample"
    );
    sample.click();
    await playing("the sample");
  };
  const loadUrl = async (url, what) => {
    await openSourceTab("URL");
    const input = await waitFor(() => document.querySelector('input[type="text"]'), "the URL input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, url);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);
    buttonWithText("Load").click();
    await playing(what);
  };
  const uploadFile = async () => {
    const blob = await (await fetch(new URL("samples/2-speakers-a.mp4", document.baseURI))).blob();
    await openSourceTab("Upload");
    const input = await waitFor(() => document.querySelector('input[type="file"]'), "the file input");
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "upload.mp4", { type: "video/mp4" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await playing("the uploaded file");
  };
  const setMode = async (mode) => {
    const toggle = document.querySelector(`button[aria-label="Switch to ${mode}"]`);
    if (toggle) toggle.click();
    await sleep(300);
  };
  const faceMeshOn = async () => {
    const toggle = await waitFor(() => switchNamed("Face mesh"), "the Face mesh switch");
    if (toggle.getAttribute("aria-checked") !== "true") toggle.click();
    await waitFor(() => /^(ready|failed)/.test(rowValue("State") ?? ""), "the face mesh to load", 60000);
    if (rowValue("State").startsWith("failed")) throw new Error(`face mesh ${rowValue("State")}`);
  };
  const faceMeshOff = async () => {
    const toggle = switchNamed("Face mesh");
    if (toggle?.getAttribute("aria-checked") === "true") toggle.click();
    await sleep(500);
  };
  const readout = () => ({
    state: rowValue("State"),
    mode: rowValue("Mode"),
    behind: rowValue("Landmarks Behind"),
    minDelay: rowValue("Min Delay"),
    blocked: Number(rowValue("Blocked Requests") ?? 0),
    delay: rowValue("Delay"),
  });
  /** A blob: worker made in `realm` tries a request to the probe origin; returns how it failed. */
  const probe = (realm) =>
    new Promise((resolve) => {
      const code = `fetch(${JSON.stringify(probeUrl)}).then(() => postMessage("sent"), (e) => postMessage("failed: " + e.message));`;
      const url = realm.URL.createObjectURL(new realm.Blob([code], { type: "text/javascript" }));
      const worker = new realm.Worker(url);
      const timeout = setTimeout(() => resolve("no answer"), 10000);
      worker.onmessage = (e) => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(e.data);
      };
    });

  const result = { scenario, steps: [] };
  if (scenario === "off") {
    await loadSample("One speaker");
    await sleep(seconds * 1000);
    await setMode("16:9");
    await sleep(3000);
    result.steps.push({ step: "played with the switch off", iframe: Boolean(iframe()), readout: readout() });
    return result;
  }

  if (scenario === "network") {
    await loadSample("One speaker");
    const loadStart = performance.now();
    await faceMeshOn();
    result.steps.push({ step: "ready", afterMs: Math.round(performance.now() - loadStart), readout: readout() });
    log("face mesh ready");
    const quarter = (seconds * 1000) / 4;
    await sleep(quarter);
    result.steps.push({ step: "9:16", readout: readout() });
    await setMode("16:9");
    await sleep(quarter);
    result.steps.push({ step: "16:9", readout: readout() });
    await setMode("9:16");
    await sleep(quarter * 2);
    result.steps.push({ step: "9:16 again", readout: readout() });
    result.workerHostProbe = await probe(iframe().contentWindow);
    result.pageRealmProbe = await probe(window);
    await faceMeshOff();
    result.steps.push({ step: "switched off", iframe: Boolean(iframe()), readout: readout() });
    return result;
  }

  if (scenario === "suite") {
    await loadSample("One speaker");
    await faceMeshOn();
    window.vertixBenchmarkReport = undefined;
    (await waitFor(() => document.querySelector("button[aria-expanded]"), "the benchmark button")).click();
    (await waitFor(() => buttonWithText("Run suite"), "Run suite")).click();
    log("suite started");
    const report = await waitFor(() => window.vertixBenchmarkReport, "the suite to finish", 90 * 60 * 1000);
    const blocked = report.results.map((r) => r.extensions?.faceMesh?.blockedRequests?.count ?? 0);
    result.steps.push({
      step: "suite",
      runs: report.results.length,
      failures: report.failures.length,
      runsWithFaceMesh: report.results.filter((r) => r.extensions?.faceMesh).length,
      blockedInRuns: blocked.reduce((a, b) => a + b, 0),
      failureMessages: [...new Set(report.failures.map((f) => `${f.name}: ${f.message}`))].slice(0, 5),
      readout: readout(),
    });
    return result;
  }

  if (scenario === "players") {
    const sources = [
      ["sample", () => loadSample("2 speakers")],
      ["uploaded file", uploadFile],
      ["MP4 URL", () => loadUrl(new URL("samples/3-speakers.mp4", document.baseURI).href, "the MP4 URL")],
      ["HLS (public)", () => loadUrl(publicHls, "the HLS stream")],
      ["DASH (public)", () => loadUrl(publicDash, "the DASH stream")],
    ];
    let first = true;
    for (const [name, load] of sources) {
      try {
        await load();
        if (first) await faceMeshOn();
        first = false;
        await sleep(seconds * 500);
        const nineSixteen = readout();
        await setMode("16:9");
        await sleep(seconds * 500);
        result.steps.push({ step: name, ok: true, nineSixteen, sixteenNine: readout() });
        await setMode("9:16");
      } catch (error) {
        result.steps.push({ step: name, ok: false, error: String(error) });
      }
      log(`${name} done`);
    }
    // The dashboard and the benchmark panel, opened once.
    (await waitFor(() => document.querySelector("button[aria-expanded]"), "the benchmark button")).click();
    await sleep(1000);
    result.steps.push({ step: "benchmark panel opened", ok: Boolean(buttonWithText("Run suite")) });
    return result;
  }
  throw new Error(`unknown scenario ${scenario}`);
}

const hostOf = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith("http") ? parsed.host : parsed.protocol;
  } catch {
    return "(invalid)";
  }
};

try {
  const { value, capture } = await runInHeadlessChrome({
    root,
    pageFunction: runInPage,
    args: [{ scenario, seconds, publicHls: PUBLIC_HLS, publicDash: PUBLIC_DASH, probeUrl: PROBE_URL }],
    chromePath: option("chrome") ?? DEFAULT_CHROME,
    headed: args.includes("--headed"),
    productionPreview: true,
    captureNetwork: true,
    timeoutMs: 100 * 60 * 1000,
  });
  const appOrigin = capture.requests
    .map((r) => r.url)
    .find((u) => u.startsWith("http://localhost") || u.startsWith("http://127."));
  const ownHost = appOrigin ? new URL(appOrigin).host : null;
  const thirdParty = capture.requests.filter((r) => /^https?:/.test(r.url) && hostOf(r.url) !== ownHost);
  const faceMeshRequests = capture.requests.filter((r) => /face-mesh\/|faceMeshWorker|FaceMeshController/.test(r.url));
  const byHost = (requests) =>
    Object.entries(
      requests.reduce((acc, r) => {
        const key = `${hostOf(r.url)} (${r.target.split(" ")[0]})`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
    ).map(([host, count]) => ({ host, count }));
  const cspLog = capture.log.filter((e) => /Content Security Policy|Refused to/i.test(e.text));
  const summary = {
    scenario,
    result: value,
    requests: capture.requests.length,
    thirdPartyByHost: byHost(thirdParty),
    faceMeshRequests: faceMeshRequests.map((r) => r.url.slice(r.url.indexOf("/", 8))),
    targets: capture.targets.map(
      (t) => `${t.type} ${t.url.startsWith("blob:") ? "blob:" : t.url.replace(/^https?:\/\/[^/]+/, "")}`
    ),
    cspViolations: cspLog.map((e) => ({
      target: e.target.split(" ")[0],
      text: e.text.replace(/https?:\/\/[^\s'"]+/g, (u) => hostOf(u)),
    })),
    blockedByBrowser: capture.failed
      .filter((f) => f.blockedReason)
      .map((f) => ({ reason: f.blockedReason, target: f.target.split(" ")[0] })),
  };
  mkdirSync(join(root, ".eval"), { recursive: true });
  writeFileSync(join(root, `.eval/face-mesh-${scenario}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.exit();
}
