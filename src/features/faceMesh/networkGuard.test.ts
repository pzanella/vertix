import { describe, expect, it, vi } from "vitest";
import { installNetworkGuard, isAllowedUrl, type GuardedScope } from "./networkGuard";

const BASE = "https://pzanella.github.io/vertix/";

function guardedScope() {
  const fetched: string[] = [];
  const imported: string[] = [];
  const beacons: string[] = [];
  class FakeXhr extends EventTarget {
    sent = false;
    open() {}
    send() {
      this.sent = true;
    }
  }
  const scope: GuardedScope = {
    fetch: ((input: RequestInfo | URL) => {
      fetched.push(String(input));
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch,
    XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest,
    navigator: {
      sendBeacon: (url: string | URL) => {
        beacons.push(String(url));
        return true;
      },
    },
    importScripts: (...urls: string[]) => void imported.push(...urls),
  };
  const blocked: [string, string][] = [];
  installNetworkGuard(scope, BASE, (host, api) => blocked.push([host, api]));
  return { scope, fetched, imported, beacons, blocked, FakeXhr };
}

describe("face mesh network guard", () => {
  it("allows this origin and blob:/data:, nothing else", () => {
    const origin = "https://pzanella.github.io";
    expect(isAllowedUrl("face-mesh/face_landmarker.task", origin, BASE)).toBe(true);
    expect(isAllowedUrl("blob:https://pzanella.github.io/1234", origin, BASE)).toBe(true);
    expect(isAllowedUrl("data:text/plain,x", origin, BASE)).toBe(true);
    expect(isAllowedUrl("https://odml.pa.googleapis.com/v1/log", origin, BASE)).toBe(false);
    expect(isAllowedUrl("http://pzanella.github.io/vertix/", origin, BASE)).toBe(false);
  });

  it("rejects a third-party fetch like a network error and reports its host; same-origin fetches go through", async () => {
    const { scope, fetched, blocked } = guardedScope();
    await expect(scope.fetch!("https://odml.pa.googleapis.com/v1/log", { method: "POST" })).rejects.toThrow(TypeError);
    await scope.fetch!(`${BASE}face-mesh/face_landmarker.task`);
    expect(fetched).toEqual([`${BASE}face-mesh/face_landmarker.task`]);
    expect(blocked).toEqual([["odml.pa.googleapis.com", "fetch"]]);
  });

  it("fails a third-party XMLHttpRequest with an error event instead of sending it", async () => {
    const { scope, blocked } = guardedScope();
    const xhr = new scope.XMLHttpRequest!() as unknown as XMLHttpRequest & { sent: boolean };
    const onError = vi.fn();
    xhr.addEventListener("error", onError);
    xhr.open("POST", "https://example.com/collect");
    xhr.send("x");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(xhr.sent).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(blocked).toEqual([["example.com", "XMLHttpRequest"]]);
  });

  it("stops third-party beacons and scripts", () => {
    const { scope, beacons, imported, blocked } = guardedScope();
    expect(scope.navigator!.sendBeacon!("https://example.com/b")).toBe(false);
    expect(() => scope.importScripts!("https://cdn.example.com/x.js")).toThrow();
    scope.importScripts!(`${BASE}face-mesh/vision_wasm_internal.js`);
    expect(beacons).toEqual([]);
    expect(imported).toEqual([`${BASE}face-mesh/vision_wasm_internal.js`]);
    expect(blocked.map(([, api]) => api)).toEqual(["sendBeacon", "importScripts"]);
  });
});
