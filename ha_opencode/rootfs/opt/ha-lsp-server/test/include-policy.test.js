import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectInclude, inspectAnchoredTarget, resolveIncludeTarget } from "../lib/include-policy.js";

const document = "file:///homeassistant/packages/lights.yaml";

describe("LSP include policy before filesystem access", () => {
  it.each([
    "/etc/passwd", "../../etc/passwd", "/homeassistant-other/config.yaml",
    "../secrets.yaml", "../secrets.yml", "../Secrets.YAML", "../.storage/state",
    "../.cloud/state", "../.git/config", "../ssl/server.yaml", "../SSL/server.yaml",
    "../private.key", "../cert.pem", "../home-assistant_v2.db", "../home-assistant.log.1",
    "..\\secrets.yaml", "bad\0.yaml", "bad\n.yaml", "",
  ])("does not probe blocked target %j", (target) => {
    const inspect = vi.fn(() => { throw new Error("Must not touch filesystem"); });
    expect(inspectInclude(document, target, { inspect })).toEqual({ status: "blocked" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/homeassistant/config.yaml", "file://remote/homeassistant/config.yaml",
    "file:///etc/config.yaml", "file:///homeassistant/secrets.yaml", "file:///homeassistant/.storage/a.yaml",
    "file:///homeassistant/config.yaml?x=1", "file:///homeassistant/config.yaml#fragment",
    "file:///homeassistant/a%00.yaml", "not a URI",
  ])("does not probe any include from rejected document %j", (uri) => {
    const inspect = vi.fn();
    expect(inspectInclude(uri, "include.yaml", { inspect })).toEqual({ status: "blocked" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("resolves sibling, parent and directory includes inside the workspace", () => {
    expect(resolveIncludeTarget(document, "lights/common.yaml")).toBe("/homeassistant/packages/lights/common.yaml");
    expect(resolveIncludeTarget(document, "../automations.yaml")).toBe("/homeassistant/automations.yaml");
    expect(resolveIncludeTarget(document, "/homeassistant/scripts")).toBe("/homeassistant/scripts");
    expect(resolveIncludeTarget("file:///homeassistant/my%20files/config.yaml", "include.yaml"))
      .toBe("/homeassistant/my files/include.yaml");
  });

  it.each(["exists", "missing", "blocked"])("preserves the bounded metadata outcome %s", (status) => {
    const inspect = vi.fn(() => status);
    const result = inspectInclude(document, "common.yaml", { inspect });
    expect(inspect).toHaveBeenCalledWith("/homeassistant/packages/common.yaml", "/homeassistant");
    expect(result).toEqual(status === "exists"
      ? { status, path: "/homeassistant/packages/common.yaml" } : { status });
  });

  it("does not report unavailable inspection as a missing include", () => {
    expect(() => inspectInclude(document, "normal.yaml", { inspect: () => { throw new Error("Unavailable"); } }))
      .toThrow("Unavailable");
  });
});

describe.skipIf(process.platform !== "linux")("Linux anchored include metadata", () => {
  it("allows files/directories, rejects live and dangling symlinks without reading them", () => {
    const root = mkdtempSync(join(tmpdir(), "ha-lsp-include-"));
    const outside = mkdtempSync(join(tmpdir(), "ha-lsp-outside-"));
    try {
      mkdirSync(join(root, "packages"));
      writeFileSync(join(root, "packages", "normal.yaml"), "safe: true\n");
      writeFileSync(join(outside, "outside.yaml"), "not to be read\n");
      symlinkSync(join(outside, "outside.yaml"), join(root, "linked.yaml"));
      symlinkSync(join(outside, "absent.yaml"), join(root, "dangling.yaml"));
      symlinkSync(outside, join(root, "linked-dir"));
      const uri = pathToFileURL(join(root, "configuration.yaml")).href;
      const check = (target) => inspectInclude(uri, target, { root });
      expect(check("packages/normal.yaml").status).toBe("exists");
      expect(check("packages").status).toBe("exists");
      expect(check("absent.yaml").status).toBe("missing");
      expect(check("linked.yaml")).toEqual({ status: "blocked" });
      expect(check("dangling.yaml")).toEqual({ status: "blocked" });
      expect(check("linked-dir/outside.yaml")).toEqual({ status: "blocked" });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("anchored metadata failure classification", () => {
  const failure = (code) => Object.assign(new Error("synthetic failure"), { code });
  const info = { dev: 1, ino: 2, isFile: () => true, isDirectory: () => true };
  const fake = () => ({ openSync: vi.fn(() => 10), closeSync: vi.fn(), fstatSync: vi.fn(() => info), statSync: vi.fn(() => info) });
  const check = (io) => inspectAnchoredTarget("/homeassistant/normal.yaml", "/homeassistant", { io, platform: "linux" });

  it("reports a missing workspace anchor as unavailable, not a missing include", () => {
    const io = fake();
    io.openSync.mockImplementation(() => { throw failure("ENOENT"); });
    expect(() => check(io)).toThrow("workspace anchor is unavailable");
    expect(io.closeSync).not.toHaveBeenCalled();
  });
  it("reports unavailable procfs as unavailable, not a missing include", () => {
    const io = fake();
    io.openSync.mockReturnValueOnce(10).mockImplementation(() => { throw failure("ENOENT"); });
    io.statSync.mockImplementation(() => { throw failure("ENOENT"); });
    expect(() => check(io)).toThrow("metadata anchor is unavailable");
    expect(io.closeSync).toHaveBeenCalledWith(10);
  });
  it("reports only target absence as missing when its anchor is still valid", () => {
    const io = fake();
    io.openSync.mockReturnValueOnce(10).mockImplementation(() => { throw failure("ENOENT"); });
    expect(check(io)).toBe("missing");
    expect(io.statSync).toHaveBeenCalledWith("/proc/self/fd/10");
  });
  it("uses O_PATH on every handle before rejecting special files", () => {
    const io = fake();
    io.openSync.mockReturnValueOnce(10).mockReturnValueOnce(11);
    io.fstatSync.mockReturnValue({ isFile: () => false, isDirectory: () => false });
    expect(check(io)).toBe("blocked");
    for (const [, flags] of io.openSync.mock.calls) expect(flags & 0o10000000).toBe(0o10000000);
    expect(io.closeSync.mock.calls).toEqual([[11], [10]]);
  });
});
