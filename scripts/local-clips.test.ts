import { describe, expect, it } from "vitest";
import { LOCAL_CLIPS_HOST, localClipsHostError } from "./local-clips.mjs";

describe("localClipsHostError", () => {
  it("allows 127.0.0.1 only", () => {
    expect(LOCAL_CLIPS_HOST).toBe("127.0.0.1");
    expect(localClipsHostError("127.0.0.1")).toBeNull();
  });

  it.each([true, "0.0.0.0", "::", "192.168.0.10", "localhost", "::1", undefined])("refuses %s", (host) => {
    expect(localClipsHostError(host)).toMatch(/127\.0\.0\.1 only/);
  });
});
