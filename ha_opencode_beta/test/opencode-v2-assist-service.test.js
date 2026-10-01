import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistService } from "../rootfs/opt/opencode-v2-homeassistant/assist-service.js";
import { openAssistPairing } from "../rootfs/opt/opencode-v2-homeassistant/assist-pairing.js";
import { startAssistHttp } from "../rootfs/opt/opencode-v2-homeassistant/assist-http.js";
import { startAssistFixture } from "./helpers/assist-fixture.mjs";

test("scoped HTTP facade authenticates, streams and removes disposable sessions", { timeout: 45000 }, async () => {
  const fixture = await startAssistFixture(async (body, emit) => {
    assert.equal(body.tools?.length ?? 0, 0);
    emit({ role: "assistant", content: "A scoped answer" }); emit({}, "stop");
  });
  const service = createAssistService({ client: fixture.client, directory: fixture.directory, authenticate: (header) => header === "Bearer fixture" ? "owner" : null });
  const server = createServer((req, res) => { void service.handle(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: "Bearer fixture", "content-type": "application/json" };
  try {
    await fixture.client.agent.list();
    assert.equal((await fetch(base + "/v1/info")).status, 401);
    assert.equal((await fetch(base + "/v1/info", { headers: { ...headers, origin: "http://attacker" } })).status, 403);
    assert.equal((await fetch(base + "/api/session", { headers })).status, 404);
    const info = await (await fetch(base + "/v1/info", { headers })).json();
    const model = info.models.find((model) => model.providerID === "fixture");
    assert.ok(model, JSON.stringify(info));
    const payload = { model: { providerID: model.providerID, id: model.id }, system: "HA system", messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }], tools: [] };
    assert.equal((await fetch(base + "/v1/requests", { method: "POST", headers, body: JSON.stringify({ ...payload, agent: "build" }) })).status, 400);
    const before = fixture.requests.length;
    const rejected = await fetch(base + "/v1/requests", { method: "POST", headers, body: JSON.stringify({ ...payload,
      messages: [{ role: "tool", content: [{ type: "tool-result", id: "evil", name: "FixtureRead", result: { type: "content", value: [{ type: "file", uri: "file:///private-file", mime: "text/plain" }] } }] }],
    }) });
    assert.notEqual(rejected.status, 200);
    assert.equal(fixture.requests.length, before);
    const response = await fetch(base + "/v1/requests", { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, await response.clone().text());
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "request");
    assert.ok(events.some((event) => event.text === "A scoped answer"), JSON.stringify(events));
    assert.equal(events.at(-1).type, "done", JSON.stringify(events));
    await service.close();
    const sessions = await fixture.client.session.list();
    assert.equal(sessions.data.length, 0, JSON.stringify(sessions));
  } finally {
    await service.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fixture.close();
  }
});

test("pairing persists only a digest and replacing/revoking invalidates old access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assist-pairing-"));
  try {
    const pairing = openAssistPairing(directory);
    const first = pairing.provision();
    assert.ok(pairing.authenticate(`Bearer ${first}`));
    const saved = await readFile(join(directory, "pairing.json"), "utf8");
    assert.ok(!saved.includes(first));
    const restarted = openAssistPairing(directory);
    assert.ok(restarted.authenticate(`Bearer ${first}`));
    const next = restarted.provision();
    assert.equal(restarted.authenticate(`Bearer ${first}`), null);
    assert.ok(restarted.authenticate(`Bearer ${next}`));
    restarted.revoke();
    assert.equal(restarted.authenticate(`Bearer ${next}`), null);
    assert.equal(openAssistPairing(directory).owner, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("administrator pairing checks CSRF and revocation cancels a pending HA call", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "assist-pairing-http-"));
  const fixture = await startAssistFixture(async (body, emit) => {
    emit({ role: "assistant" });
    emit({ tool_calls: [{ index: 0, id: "pending", type: "function", function: { name: body.tools[0].function.name, arguments: "{}" } }] });
    emit({}, "tool_calls");
  });
  let http;
  try {
    http = await startAssistHttp({ client: fixture.client, directory: fixture.directory, pairing: openAssistPairing(directory),
      ingressSecret: "fixture-ipc", hostname: "fixture", coreHost: "127.0.0.1", corePort: 0, ipcPort: 0, verifyAdmin: async (user) => user === "admin" });
    const ipc = `http://127.0.0.1:${http.ipc.address().port}/ha-assist/`;
    const base = `http://127.0.0.1:${http.core.address().port}`;
    const headers = { "x-ha-mcp-ingress-secret": "fixture-ipc", "x-ha-mcp-user-id": "admin", "x-ha-mcp-external-origin": "https://ha.example",
      "x-ha-mcp-external-path": "/api/hassio_ingress/fixture/ha-assist/" };
    assert.equal((await fetch(ipc)).status, 403);
    assert.equal((await fetch(ipc, { headers: { ...headers, "x-ha-mcp-user-id": "ordinary" } })).status, 403);
    const form = await (await fetch(ipc, { headers })).text();
    const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(form)[1];
    const post = { ...headers, "content-type": "application/x-www-form-urlencoded", origin: "https://ha.example" };
    assert.equal((await fetch(ipc, { method: "POST", headers: { ...post, origin: "https://wrong.example" }, body: new URLSearchParams({ csrf, action: "provision" }) })).status, 403);
    const page = await (await fetch(ipc, { method: "POST", headers: post, body: new URLSearchParams({ csrf, action: "provision" }) })).text();
    const key = /Pairing key: <code>([A-Za-z0-9_-]{43})<\/code>/.exec(page)[1];
    assert.equal((await fetch(ipc, { method: "POST", headers: post, body: new URLSearchParams({ csrf, action: "provision" }) })).status, 403);
    const auth = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
    const response = await fetch(base + "/v1/requests", { method: "POST", headers: auth, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ model: { providerID: "fixture", id: "coding" }, system: "HA", messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        tools: [{ name: "FixtureRead", description: "fixture", parameters: { type: "object", properties: {} } }] }) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let received = "";
    while (!received.includes('"tool_call"')) {
      const { value, done } = await reader.read(); assert.equal(done, false); received += Buffer.from(value).toString();
    }
    const revokePage = await (await fetch(ipc, { headers })).text();
    const revokeCsrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(revokePage)[1];
    assert.equal((await fetch(ipc, { method: "POST", headers: post, body: new URLSearchParams({ csrf: revokeCsrf, action: "revoke" }) })).status, 200);
    while (!(await reader.read()).done) { /* drain cancellation event */ }
    assert.equal((await fetch(base + "/v1/info", { headers: auth })).status, 401);
    assert.equal((await fixture.client.session.list()).data.length, 0);
    const newForm = await (await fetch(ipc, { headers })).text();
    const nextCsrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(newForm)[1];
    const nextPage = await (await fetch(ipc, { method: "POST", headers: post, body: new URLSearchParams({ csrf: nextCsrf, action: "provision" }) })).text();
    const nextKey = /Pairing key: <code>([A-Za-z0-9_-]{43})<\/code>/.exec(nextPage)[1];
    const nextAuth = { Authorization: `Bearer ${nextKey}` };
    assert.equal((await fetch(base + "/v1/pairing", { method: "DELETE", headers: nextAuth })).status, 200);
    assert.equal((await fetch(base + "/v1/info", { headers: nextAuth })).status, 401);
  } finally { await http?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
