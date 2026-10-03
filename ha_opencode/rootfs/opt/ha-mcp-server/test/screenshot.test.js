import { describe, expect, it } from "vitest";
import { buildScreenshotTarget, captureHomeAssistantPage } from "../lib/screenshot.js";

describe("screenshot URL and credential boundary", () => {
  it.each([
    ["https://HA.EXAMPLE:443/", "https://ha.example"],
    ["http://HA.EXAMPLE:80", "http://ha.example"],
    ["http://HA.EXAMPLE:8123", "http://ha.example:8123"],
  ])("canonicalizes %s to the browser's origin", (base, origin) => {
    const target = buildScreenshotTarget(base, "chat-uss-aberdeen/0?theme=dark#card");
    expect(target.origin).toBe(origin);
    expect(target.pathname).toBe("/chat-uss-aberdeen/0");
    expect(target.search).toBe("?theme=dark");
    expect(target.hash).toBe("#card");
  });

  it.each(["//other.example/", "/\\other.example/", "https://other.example/", "\n//other.example/", "", null])(
    "rejects unsafe or invalid paths before creating a browser context: %s", async (urlPath) => {
      await expect(captureHomeAssistantPage({}, { haCoreUrl: "http://ha.example:8123", urlPath, token: "test" }))
        .rejects.toThrow("page path");
    },
  );

  it.each(["file:///tmp/page", "http://user:secret@ha.example", "https://ha.example/ingress", "https://ha.example?token=secret"])(
    "rejects unsupported bases without echoing credentials: %s", (base) => {
      expect(() => buildScreenshotTarget(base, "/lovelace/0")).toThrow("direct Home Assistant HTTP(S) origin");
    },
  );

  it.each(["/auth/authorize?code=private-code", "/onboarding.html", "/onboarding"])(
    "rejects authentication/onboarding destinations: %s", (path) => {
      let message;
      try { buildScreenshotTarget("http://ha.example", path); } catch (error) { message = error.message; }
      expect(message).toMatch(/authentication\/navigation failed/);
      expect(message).not.toContain("private-code");
    },
  );
});
