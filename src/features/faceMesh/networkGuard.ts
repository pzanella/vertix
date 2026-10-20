/**
 * Stops every network request from a worker scope to another origin, on
 * top of the worker's Content Security Policy: @mediapipe/tasks-vision
 * posts usage metrics to Google (see README, "Face mesh demo"). A stopped
 * request fails the way a network error does, so the caller's own error
 * handling runs (the metrics logger then stops itself), and is reported
 * through `onBlocked`.
 */
export interface GuardedScope {
  location?: { href: string };
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  WebSocket?: typeof WebSocket;
  EventSource?: typeof EventSource;
  navigator?: { sendBeacon?: (url: string | URL, data?: BodyInit | null) => boolean };
  importScripts?: (...urls: string[]) => void;
}

export type BlockedRequestListener = (host: string, api: string) => void;

const LOCAL_SCHEMES = new Set(["blob:", "data:"]);

/** True for `url` on `allowedOrigin` or a local scheme (blob:, data:); false for anything else, unparsable URLs included. */
export function isAllowedUrl(url: string | URL, allowedOrigin: string, baseUrl: string): boolean {
  try {
    const parsed = new URL(url, baseUrl);
    return LOCAL_SCHEMES.has(parsed.protocol) || parsed.origin === allowedOrigin;
  } catch {
    return false;
  }
}

function hostOf(url: string | URL, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).host || "(none)";
  } catch {
    return "(invalid URL)";
  }
}

function requestUrl(input: RequestInfo | URL): string | URL {
  return typeof input === "string" || input instanceof URL ? input : input.url;
}

export function installNetworkGuard(scope: GuardedScope, baseUrl: string, onBlocked: BlockedRequestListener): void {
  const allowedOrigin = new URL(baseUrl).origin;
  const allowed = (url: string | URL) => isAllowedUrl(url, allowedOrigin, baseUrl);
  const block = (url: string | URL, api: string) => onBlocked(hostOf(url, baseUrl), api);

  const originalFetch = scope.fetch;
  if (originalFetch) {
    scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (allowed(url)) return originalFetch(input, init);
      block(url, "fetch");
      return Promise.reject(new TypeError("Blocked by the face mesh network guard"));
    };
  }

  const Xhr = scope.XMLHttpRequest;
  if (Xhr) {
    const blockedRequests = new WeakSet<XMLHttpRequest>();
    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;
    Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      if (allowed(url)) blockedRequests.delete(this);
      else {
        blockedRequests.add(this);
        block(url, "XMLHttpRequest");
      }
      return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof Xhr.prototype.open;
    Xhr.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      if (!blockedRequests.has(this)) return originalSend.call(this, body);
      setTimeout(() => this.dispatchEvent(new Event("error")), 0);
    };
  }

  const Socket = scope.WebSocket;
  if (Socket) {
    scope.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (!allowed(url)) {
          block(url, "WebSocket");
          throw new DOMException("Blocked by the face mesh network guard", "SecurityError");
        }
        super(url, protocols);
      }
    };
  }

  const Events = scope.EventSource;
  if (Events) {
    scope.EventSource = class extends Events {
      constructor(url: string | URL, init?: EventSourceInit) {
        if (!allowed(url)) {
          block(url, "EventSource");
          throw new DOMException("Blocked by the face mesh network guard", "SecurityError");
        }
        super(url, init);
      }
    };
  }

  const beacon = scope.navigator?.sendBeacon;
  if (scope.navigator && beacon) {
    const navigatorRef = scope.navigator;
    navigatorRef.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      if (allowed(url)) return beacon.call(navigatorRef, url, data);
      block(url, "sendBeacon");
      return false;
    };
  }

  const originalImportScripts = scope.importScripts;
  if (originalImportScripts) {
    scope.importScripts = (...urls: string[]) => {
      const refused = urls.find((url) => !allowed(url));
      if (refused !== undefined) {
        block(refused, "importScripts");
        throw new DOMException("Blocked by the face mesh network guard", "NetworkError");
      }
      originalImportScripts(...urls);
    };
  }
}
