// Runs a function in a page of the app (served by Vite from `root`) in
// headless Chrome over the DevTools protocol, and returns its result. Used
// by the browser checks; timings in headless Chrome are not representative
// of a real device.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

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

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
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
 * Evaluates `pageFunction(...args)` in the app page and returns its value.
 * Page console lines starting with "[check]" are echoed with a timestamp,
 * page errors always.
 */
export async function runInHeadlessChrome({
  root,
  pageFunction,
  args = [],
  chromePath = DEFAULT_CHROME,
  headed = false,
  cpuThrottle = 1,
  timeoutMs = 10 * 60 * 1000,
}) {
  const server = await createServer({ root, logLevel: "error", server: { port: 0 } });
  await server.listen();
  const appUrl = server.resolvedUrls.local[0];
  const profileDir = mkdtempSync(join(tmpdir(), "vertix-check-"));
  const chrome = spawn(
    chromePath,
    [
      ...(headed ? [] : ["--headless=new"]),
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--autoplay-policy=no-user-gesture-required",
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
    return result.result.value;
  } finally {
    chrome.kill();
    // Vite's close() waits for the page's HMR socket, which a killed Chrome
    // may never close: don't wait for it.
    await Promise.race([server.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
    // Chrome may still be writing its profile for a moment after the kill.
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
