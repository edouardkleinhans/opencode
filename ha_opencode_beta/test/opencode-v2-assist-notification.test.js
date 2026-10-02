import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistRestartNotification, runAssistRestartNotification } from "../rootfs/opt/opencode-v2-homeassistant/assist-notification.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "assist-notification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const options = { directory, token: "private-fixture-supervisor", hostname: "fixture-beta",
    installation: { action: "installed", version: "0.1.0b4", installed_at: "2026-10-02T10:00:00+00:00" },
    fetchImpl: async (url, request) => { calls.push({ url, ...request }); return Response.json([]); } };
  return { options, calls, path: join(directory, "restart-notification.json") };
}

test("installation notifies through Supervisor once; unchanged app/worker restarts preserve dismissal", async (t) => {
  const f = await fixture(t);
  await createAssistRestartNotification(f.options).notify();
  const call = f.calls[0];
  assert.equal(call.url, "http://supervisor/core/api/services/persistent_notification/create");
  assert.equal(call.method, "POST");
  assert.equal(call.redirect, "error");
  assert.equal(call.headers.Authorization, "Bearer private-fixture-supervisor");
  const body = JSON.parse(call.body);
  assert.equal(body.notification_id, "opencode_assist_restart_fixture-beta");
  assert.match(body.message, /0\.1\.0b4/);
  assert.match(body.message, /Restart Home Assistant Core/);
  assert.match(body.message, /Restarting only the OpenCode app is not sufficient/);
  assert.match(body.message, /already restarted Core since this installation/);
  const saved = await readFile(f.path, "utf8");
  assert.ok(!saved.includes(f.options.token) && !call.body.includes(f.options.token));
  await createAssistRestartNotification(f.options).notify();
  await createAssistRestartNotification({ ...f.options, installation: { ...f.options.installation, action: "unchanged" } }).notify();
  assert.equal(f.calls.length, 1);
});

test("a new installation replaces the same notification, including same-version file updates", async (t) => {
  const f = await fixture(t);
  await createAssistRestartNotification(f.options).notify();
  await createAssistRestartNotification({ ...f.options, installation: { ...f.options.installation,
    action: "updated", installed_at: "2026-10-03T10:00:00+00:00" } }).notify();
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[0].body).notification_id, JSON.parse(f.calls[1].body).notification_id);
  assert.match(JSON.parse(f.calls[1].body).message, /2026-10-03/);
});

test("Core outage or lost response leaves delivery pending across an unchanged app restart", async (t) => {
  const f = await fixture(t);
  for (const fetchImpl of [async () => Response.json({}, { status: 503 }), async () => { throw new Error("lost response"); }]) {
    await assert.rejects(createAssistRestartNotification({ ...f.options, fetchImpl }).notify());
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
  }
  await createAssistRestartNotification({ ...f.options, installation: { ...f.options.installation, action: "unchanged" } }).notify();
  assert.equal(f.calls.length, 1);
});

test("disabled/blocked installs never notify and invalid metadata or receipt files fail closed", async (t) => {
  const f = await fixture(t);
  assert.equal(createAssistRestartNotification({ ...f.options, installation: undefined }), undefined);
  assert.equal(createAssistRestartNotification({ ...f.options, installation: { action: "blocked" } }), undefined);
  assert.throws(() => createAssistRestartNotification({ ...f.options, hostname: undefined }), /invalid_installation/);
  assert.throws(() => createAssistRestartNotification({ ...f.options, installation: { ...f.options.installation, version: "<script>" } }), /invalid_installation/);
  await writeFile(f.path, "{}", { mode: 0o600 });
  await assert.rejects(createAssistRestartNotification(f.options).notify(), /invalid_notification_state/);
  await chmod(f.path, 0o644);
  await assert.rejects(createAssistRestartNotification(f.options).notify(), /unsafe_notification_state/);
  await rm(f.path);
  await symlink(join(f.options.directory, "absent"), f.path);
  await assert.rejects(createAssistRestartNotification(f.options).notify());
  assert.equal(f.calls.length, 0);
});

test("notification retry backs off without leaking errors and stops after delivery", async (t) => {
  const f = await fixture(t);
  const logs = [], delays = [];
  t.mock.method(console, "error", (message) => logs.push(message));
  let attempts = 0;
  const notification = createAssistRestartNotification({ ...f.options, fetchImpl: async () => {
    if (++attempts < 3) throw new Error(f.options.token);
    return Response.json([]);
  } });
  await runAssistRestartNotification(notification, { wait: async (ms) => { delays.push(ms); } });
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(attempts, 3);
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => !line.includes(f.options.token)));
});

test("shutdown aborts notification delivery without writing a receipt or logging credentials", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const logs = [];
  t.mock.method(console, "error", (message) => logs.push(message));
  const notification = createAssistRestartNotification({ ...f.options, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started();
  }) });
  const pending = runAssistRestartNotification(notification, { signal: controller.signal });
  await ready;
  controller.abort();
  await pending;
  assert.deepEqual(logs, []);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});
