// Native image fixture: real MCP dispatch and pinned Python/zigporter, fake HA.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire("/opt/ha-mcp-server/package.json");
const { WebSocketServer } = require("ws");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const token = "native-zigbee-fixture-token";
const violations = [];
const methods = new Set();
let z2mReads = 0;
const server = createServer((request, response) => {
  if (request.method !== "GET") violations.push("Non-read HTTP method");
  if (request.url === "/core/api/") {
    if (request.headers.authorization !== `Bearer ${token}`) violations.push("HA authentication missing");
    return response.writeHead(200, { "content-type": "application/json" }).end('{"message":"API running"}');
  }
  if (request.url === "/z2m/api/devices") {
    z2mReads++;
    if (request.headers.authorization) violations.push("Unexpected authentication sent to Z2M");
    return response.writeHead(200, { "content-type": "application/json" }).end("[]");
  }
  violations.push("Unexpected HTTP path");
  response.writeHead(404).end();
});
const wsServer = new WebSocketServer({ server, path: "/core/api/websocket" });
wsServer.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.9.3" }));
  let authenticated = false;
  socket.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.type === "auth") {
      authenticated = message.access_token === token;
      if (!authenticated) violations.push("WS authentication missing");
      socket.send(JSON.stringify({ type: authenticated ? "auth_ok" : "auth_invalid" }));
      return;
    }
    methods.add(message.type);
    const fixtures = {
      "zha/devices": [], "config/entity_registry/list": [], "config/area_registry/list": [],
      "config/device_registry/list": [{ id: "fixture-device", name: "Fixture Lamp", identifiers: [], manufacturer: "Fixture", model: "Test" }],
      "config/automation/list": [], "config/script/list": [], "config/scene/list": [],
      "get_panels": {}, "lovelace/config": { views: [] },
    };
    if (!authenticated || !Object.hasOwn(fixtures, message.type)) violations.push("Unexpected WS command");
    socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result: fixtures[message.type] ?? [] }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const home = await mkdtemp(join(tmpdir(), "ha-zigbee-fixture-"));
const client = new Client({ name: "native-zigbee-fixture", version: "1" });
try {
  await client.connect(new StdioClientTransport({ command: "/usr/local/bin/node", args: ["/opt/ha-mcp-server/index.js"],
    cwd: home, stderr: "pipe", env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, SUPERVISOR_TOKEN: token,
      SUPERVISOR_BASE_URL: base, HA_URL: `${base}/core`, Z2M_URL: `${base}/z2m`, OPENCODE_MCP_TOOL_PROFILE: "full",
      LD_PRELOAD: "/usr/local/lib/opencode-v2-non-dumpable.so",
    },
  }));
  const call = async (command) => {
    const result = await client.callTool({ name: "zigporter_run", arguments: { command } }, undefined, { signal: AbortSignal.timeout(15000) });
    assert.ok(!result.isError, `Native Zigbee MCP call failed: ${JSON.stringify(result).replaceAll(token, "[redacted]")}`);
    const text = result.content[0].text;
    assert.ok(!text.includes(token), "Credential leaked in diagnostic output");
    assert.ok(!/starting setup|Run.*zigporter setup/.test(text), "Interactive bootstrap must not run");
    return JSON.parse(text).data;
  };
  const check = await call("check");
  assert.ok(check.output.includes("HA reachable"));
  assert.ok(z2mReads > 0);
  await writeFile(join(home, ".env"), `HA_URL=http://untrusted.invalid\nHA_TOKEN=must-not-be-loaded\nZ2M_URL=${base}/z2m\n`);
  const inspect = await call('inspect "Fixture Lamp" --backend all --json');
  assert.ok(JSON.stringify(inspect).includes("Fixture Lamp"));
  const missing = await call('inspect "Missing Device" --backend all --json');
  assert.ok(missing.output.includes("device not found"));
  const direct = spawnSync("/usr/local/bin/zigporter", ["check"], {
    encoding: "utf8", timeout: 5000, cwd: home,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home },
  });
  assert.equal(direct.status, 1);
  assert.ok(direct.stderr.includes("zigporter_run MCP tool"));
  assert.ok(!/starting setup|must-not-be-loaded/.test(direct.stdout + direct.stderr));
  const zhaOnly = spawnSync("/usr/local/bin/zigporter", ["check"], {
    encoding: "utf8", timeout: 5000, cwd: home,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, HA_URL: `${base}/core`, HA_TOKEN: token },
  });
  assert.equal(zhaOnly.status, 1);
  assert.ok(zhaOnly.stdout.includes("Missing: Z2M_URL"), "Project .env must not fill in absent service settings");
  assert.ok(!zhaOnly.stdout.includes(token));
  assert.ok(methods.has("zha/devices"));
  assert.deepEqual(violations, []);
  console.log("Native Zigbee MCP check/inspect passed without .env setup, mutations or credential disclosure");
} finally {
  await client.close();
  for (const socket of wsServer.clients) socket.terminate();
  await new Promise((resolve) => wsServer.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
