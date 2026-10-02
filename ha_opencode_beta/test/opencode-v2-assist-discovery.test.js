import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistBootstrap, createAssistDiscovery, runAssistDiscovery } from "../rootfs/opt/opencode-v2-homeassistant/assist-discovery.js";
import { openAssistPairing } from "../rootfs/opt/opencode-v2-homeassistant/assist-pairing.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "assist-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pairing = openAssistPairing(directory);
  let now = 1000000;
  let changed = 0;
  const bootstrap = createAssistBootstrap(pairing, { now: () => now, onChange: () => changed++ });
  const calls = [];
  const settings = { directory, token: "fixture-supervisor-token", hostname: "fixture-addon", bootstrap,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return Response.json({ result: "ok", data: { uuid: "fixture-uuid" } });
    } };
  return { directory, pairing, bootstrap, calls, settings, discovery: createAssistDiscovery(settings),
    advance: (ms) => { now += ms; }, changed: () => changed };
}

test("bootstrap expires, permits only identical lost-response retries and never revives revoked access", async (t) => {
  const f = await fixture(t);
  const key = "a".repeat(43), nextKey = "b".repeat(43);
  const first = f.bootstrap.current();
  assert.deepEqual(f.bootstrap.current(), first);
  assert.equal(f.pairing.owner, undefined);
  f.advance(481000);
  const rotated = f.bootstrap.current();
  assert.notEqual(rotated.bootstrap, first.bootstrap);
  f.bootstrap.pair(`Bearer ${first.bootstrap}`, key); // Old card's brief overlap.
  const owner = f.pairing.owner;
  f.bootstrap.pair(`Bearer ${first.bootstrap}`, key);
  assert.equal(f.pairing.owner, owner);
  assert.equal(f.changed(), 1);
  assert.throws(() => f.bootstrap.pair(`Bearer ${first.bootstrap}`, nextKey), /consumed/);
  assert.throws(() => f.bootstrap.pair(`Bearer ${rotated.bootstrap}`, nextKey), /expired/);
  const replacement = f.bootstrap.current();
  f.bootstrap.pair(`Bearer ${replacement.bootstrap}`, nextKey);
  assert.equal(f.pairing.authenticate(`Bearer ${key}`), null);
  assert.throws(() => f.bootstrap.pair(`Bearer ${first.bootstrap}`, key), /expired/);
  f.pairing.revoke();
  assert.throws(() => f.bootstrap.pair(`Bearer ${replacement.bootstrap}`, nextKey), /consumed/);
  f.advance(600001);
  assert.throws(() => f.bootstrap.authorize(`Bearer ${replacement.bootstrap}`), /expired/);
  const restarted = createAssistBootstrap(openAssistPairing(f.directory));
  assert.throws(() => restarted.authorize(`Bearer ${f.bootstrap.current().bootstrap}`), /expired/);
  assert.throws(() => f.pairing.provision(), /Invalid/);
});

test("Supervisor publication contains only expiring bootstrap; restart/republication preserves pairing", async (t) => {
  const f = await fixture(t);
  const key = f.pairing.provision("a".repeat(43));
  await f.discovery.tick();
  assert.equal(f.discovery.published, true);
  const first = f.calls[0];
  assert.equal(first.url, "http://supervisor/discovery");
  assert.equal(first.method, "POST");
  assert.equal(first.headers.Authorization, "Bearer fixture-supervisor-token");
  assert.equal(first.redirect, "error");
  assert.deepEqual(JSON.parse(first.body), { service: "opencode_assist", config: {
    version: 1, url: "http://fixture-addon:8768", ...f.bootstrap.current(),
  } });
  assert.ok(!first.body.includes(key));
  const saved = await readFile(join(f.directory, "discovery.json"), "utf8");
  assert.deepEqual(JSON.parse(saved), { uuid: "fixture-uuid" });
  assert.ok(!saved.includes(f.bootstrap.current().bootstrap));
  await f.discovery.tick();
  const restarted = createAssistDiscovery({ ...f.settings, bootstrap: createAssistBootstrap(openAssistPairing(f.directory)) });
  await restarted.tick();
  assert.notEqual(f.calls[2].body, first.body);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((call) => call.method === "POST"));
  assert.ok(f.pairing.authenticate(`Bearer ${key}`));
});

test("disable withdraws only its saved advertisement and preserves persistent credentials", async (t) => {
  const f = await fixture(t);
  const key = f.pairing.provision("a".repeat(43));
  await f.discovery.tick();
  const disabled = createAssistDiscovery({ ...f.settings, hostname: undefined, bootstrap: undefined });
  await disabled.withdraw();
  assert.equal(f.calls.at(-1).url, "http://supervisor/discovery/fixture-uuid");
  assert.equal(f.calls.at(-1).method, "DELETE");
  assert.ok(openAssistPairing(f.directory).authenticate(`Bearer ${key}`));
  await disabled.withdraw();
  assert.equal(f.calls.length, 2);
  await assert.rejects(readFile(join(f.directory, "discovery.json")), { code: "ENOENT" });
});

test("failed withdrawal retains UUID for retry and already-removed advertisements are accepted", async (t) => {
  const f = await fixture(t);
  await f.discovery.tick();
  const unavailable = createAssistDiscovery({ ...f.settings, fetchImpl: async () => Response.json({}, { status: 503 }) });
  await assert.rejects(unavailable.withdraw(), /unavailable/);
  assert.equal(JSON.parse(await readFile(join(f.directory, "discovery.json"))).uuid, "fixture-uuid");
  const missing = createAssistDiscovery({ ...f.settings, fetchImpl: async () => new Response(null, { status: 404 }) });
  await missing.withdraw();
  await assert.rejects(readFile(join(f.directory, "discovery.json")), { code: "ENOENT" });
});

test("unsafe state, invalid app identity and malformed Supervisor response fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createAssistDiscovery({ ...f.settings, hostname: undefined }).tick(), /invalid_app_identity/);
  assert.equal(f.calls.length, 0);
  const path = join(f.directory, "discovery.json");
  await writeFile(path, "{}", { mode: 0o600 });
  await assert.rejects(f.discovery.withdraw(), /invalid_discovery_state/);
  await writeFile(path, JSON.stringify({ uuid: "fixture-uuid" }));
  await chmod(path, 0o644);
  await assert.rejects(f.discovery.tick(), /unsafe_discovery_state/);
  await rm(path);
  await symlink(join(f.directory, "pairing.json"), path);
  await assert.rejects(f.discovery.tick());
  await rm(path);
  for (const response of [{ result: "error" }, { result: "ok", data: {} }]) {
    await assert.rejects(createAssistDiscovery({ ...f.settings, fetchImpl: async () => Response.json(response) }).tick());
  }
  assert.equal(f.calls.length, 0);
});

test("discovery retries with backoff, refresh wakes publication, and abort stops waiting", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const delays = [];
  let attempts = 0;
  const errors = [];
  t.mock.method(console, "error", (value) => errors.push(value));
  const discovery = createAssistDiscovery({ ...f.settings, fetchImpl: async () => {
    if (++attempts <= 2) throw new Error("private fixture token must not be logged");
    return Response.json({ result: "ok", data: { uuid: "fixture-uuid" } });
  } });
  await runAssistDiscovery(discovery, { signal: controller.signal, wait: async (ms) => {
    delays.push(ms);
    if (delays.length === 3) controller.abort();
  } });
  assert.deepEqual(delays, [1000, 2000, 60000]);
  assert.equal(attempts, 3);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => !error.includes("private fixture")));
  let cancelled = false;
  const paused = discovery.pause(60000, undefined, (_ms, _value, { signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true });
  }));
  discovery.refresh();
  await paused;
  assert.equal(cancelled, true);
});
