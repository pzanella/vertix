// Runs a function in a page of the app (served by Vite from `root`) in
// headless Chrome over the DevTools protocol, and returns its result. Used
// by the browser checks; timings in headless Chrome are not representative
// of a real device.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, preview } from "vite";
import { LOCAL_CLIPS_HOST } from "../local-clips.mjs";

const DEBUG_PORT = 9333;
export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const listener of this.listeners) listener(msg);
      }
    };
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function pageTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome did not open a debugging port");
}

/**
 * Records every request and every browser log entry (CSP violations are
 * logged there) of the page and of all its workers and frames, by
 * auto-attaching to each new target before it runs.
 */
async function captureTraffic(cdp) {
  const capture = { requests: [], failed: [], log: [], targets: [] };
  const sessionUrls = new Map([[undefined, "page"]]);
  const watch = async (sessionId) => {
    await cdp.send("Network.enable", {}, sessionId).catch(() => {});
    await cdp.send("Log.enable", {}, sessionId).catch(() => {});
    await cdp
      .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
      .catch(() => {});
  };
  cdp.listeners.push((msg) => {
    const where = sessionUrls.get(msg.sessionId) ?? msg.sessionId;
    if (msg.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = msg.params;
      sessionUrls.set(sessionId, `${targetInfo.type} ${targetInfo.url}`);
      capture.targets.push({ type: targetInfo.type, url: targetInfo.url });
      void watch(sessionId).then(() => cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {}));
    } else if (msg.method === "Network.requestWillBeSent") {
      capture.requests.push({ url: msg.params.request.url, type: msg.params.type ?? null, target: where });
    } else if (msg.method === "Network.loadingFailed") {
      capture.failed.push({
        requestId: msg.params.requestId,
        blockedReason: msg.params.blockedReason ?? null,
        errorText: msg.params.errorText,
        target: where,
      });
    } else if (msg.method === "Log.entryAdded") {
      const { source, level, text, url } = msg.params.entry;
      capture.log.push({ source, level, text, url: url ?? null, target: where });
    }
  });
  await watch(undefined);
  return capture;
}

/**
 * Evaluates `pageFunction(...args)` in the app page and returns its value.
 * Page console lines starting with "[check]" are echoed with a timestamp,
 * page errors always. With `productionPreview`, serves root/dist (vite
 * preview) instead of the dev server. With `captureNetwork`, returns
 * { value, capture } (see captureTraffic).
 */
export async function runInHeadlessChrome({
  root,
  pageFunction,
  args = [],
  chromePath = DEFAULT_CHROME,
  headed = false,
  cpuThrottle = 1,
  timeoutMs = 10 * 60 * 1000,
  productionPreview = false,
  captureNetwork = false,
}) {
  const server = productionPreview
    ? await preview({ root, logLevel: "error", preview: { host: LOCAL_CLIPS_HOST, port: 0 } })
    : await createServer({ root, logLevel: "error", server: { host: LOCAL_CLIPS_HOST, port: 0 } });
  if (!productionPreview) await server.listen();
  const appUrl = server.resolvedUrls.local[0];
  const profileDir = mkdtempSync(join(tmpdir(), "vertix-check-"));
  const chrome = spawn(
    chromePath,
    [
      ...(headed ? [] : ["--headless=new"]),
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--autoplay-policy=no-user-gesture-required",
      // A visible window covered by other windows must not count as hidden (macOS occlusion) or be throttled.
      ...(headed
        ? [
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
          ]
        : []),
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  try {
    const cdp = new Cdp(await pageTarget());
    await cdp.open();
    cdp.listeners.push((msg) => {
      if (msg.method === "Runtime.exceptionThrown") console.error("[page]", msg.params.exceptionDetails.text);
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = msg.params.args.map((a) => a.value ?? a.description).join(" ");
        if (msg.params.type === "error") console.error("[page]", text);
        else if (text.startsWith("[check]")) console.log(new Date().toISOString().slice(11, 19), text);
      }
    });
    const capture = captureNetwork ? await captureTraffic(cdp) : null;
    await cdp.send("Runtime.enable");
    if (cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
    await cdp.send("Page.enable");
    const loaded = new Promise((resolve) =>
      cdp.listeners.push((msg) => msg.method === "Page.loadEventFired" && resolve())
    );
    await cdp.send("Page.navigate", { url: appUrl });
    await loaded;

    const evaluation = cdp.send("Runtime.evaluate", {
      expression: `(${pageFunction.toString()})(${args.map((arg) => JSON.stringify(arg)).join(", ")})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("check timed out")), timeoutMs));
    const result = await Promise.race([evaluation, timeout]);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "page error");
    return capture ? { value: result.result.value, capture } : result.result.value;
  } finally {
    chrome.kill();
    // Vite's close() waits for the page's HMR socket, which a killed Chrome
    // may never close: don't wait for it.
    const closed = productionPreview ? new Promise((resolve) => server.httpServer.close(resolve)) : server.close();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    // Chrome may still be writing its profile for a moment after the kill.
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
