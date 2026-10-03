import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { routeHaMcp } = require("../rootfs/usr/local/bin/ha-mcp-ingress.js");
const base = "/api/hassio_ingress/fixture";
function unavailable(remote = "172.30.32.2") {
  const headers = { "x-remote-user-id": "a".repeat(32), "x-forwarded-host": "ha.example",
    "x-forwarded-proto": "https", "x-ingress-path": base };
  const req = { method: "GET", headers, rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress: remote } };
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  assert.equal(routeHaMcp(req, res, { ingressPath: base, upstreamPath: "/ha-assist/" }), true);
  return res;
}

test("unavailable Assist shows bounded installer status only behind trusted Ingress", (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "assist-ingress-status-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "status.json");
  const open = fs.openSync, stat = fs.fstatSync, lstat = fs.lstatSync;
  let statusReads = 0;
  let uid = 0;
  t.mock.method(fs, "lstatSync", (name, ...args) => {
    if (name === "/run/ha-assist") throw Object.assign(new Error("worker absent"), { code: "ENOENT" });
    return lstat(name, ...args);
  });
  t.mock.method(fs, "openSync", (name, ...args) => {
    if (name !== "/run/ha-assist-install.json") return open(name, ...args);
    statusReads++;
    return open(path, ...args);
  });
  // Exercise real no-follow/size/mode checks in a temporary tree; simulate only
  // the container's root owner so this contract also runs on non-root CI.
  t.mock.method(fs, "fstatSync", (fd) => Object.assign(stat(fd), { uid }));
  fs.writeFileSync(path, JSON.stringify({ action: "blocked", reason: "unmanaged" }), { mode: 0o600 });
  assert.equal(unavailable("127.0.0.1").status, 403);
  assert.equal(statusReads, 0);
  const conflict = unavailable();
  assert.equal(conflict.status, 503);
  assert.equal(conflict.headers["cache-control"], "no-store");
  assert.match(conflict.headers["content-security-policy"], /default-src 'none'/);
  assert.match(conflict.body, /OpenCode Assist installation conflict/);
  assert.match(conflict.body, /manually installed b0 ZIP/);
  assert.match(conflict.body, /outside custom_components/);
  assert.match(conflict.body, /Remove any old manually paired OpenCode Assist integration entry/);
  assert.match(conflict.body, /Home Assistant Core/);
  assert.match(conflict.body, new RegExp(`target="_self" href="${base}/"`));
  for (const [reason, message] of [["modified", /local edits or extra files/], ["installation_failed", /could not be installed/]]) {
    fs.writeFileSync(path, JSON.stringify({ action: "blocked", reason }));
    assert.match(unavailable().body, message);
  }
  fs.writeFileSync(path, JSON.stringify({ action: "blocked", reason: '<script>alert("fixture")</script>', error: "private-detail" }));
  assert.doesNotMatch(unavailable().body, /<script>|private-detail/);
  fs.writeFileSync(path, JSON.stringify({ action: "blocked", reason: "unmanaged" }));
  uid = 1234;
  assert.doesNotMatch(unavailable().body, /<h1>OpenCode Assist installation conflict/);
  uid = 0;
  fs.chmodSync(path, 0o644);
  assert.doesNotMatch(unavailable().body, /<h1>OpenCode Assist installation conflict/);
  fs.chmodSync(path, 0o600);
  for (const contents of ["invalid JSON", " ".repeat(1025), "null"]) {
    fs.writeFileSync(path, contents);
    assert.match(unavailable().body, /OpenCode Assist is not running/);
  }
  const target = join(directory, "linked.json");
  fs.renameSync(path, target);
  fs.writeFileSync(target, JSON.stringify({ action: "blocked", reason: "unmanaged" }));
  fs.symlinkSync(target, path);
  assert.doesNotMatch(unavailable().body, /<h1>OpenCode Assist installation conflict/);
  fs.unlinkSync(path);
  assert.match(unavailable().body, /OpenCode Assist is not running/);
});
