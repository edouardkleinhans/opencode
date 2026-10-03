// Run inside the beta app in the official HA devcontainer with
// HA_HISTORY_ACCEPTANCE=1. Creates a unique synthetic state via Core's REST API,
// exercises the running MCP sidecar, and removes the state afterwards. Recorder
// history is left to normal Core retention; no internal database is accessed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

assert.equal(process.env.HA_HISTORY_ACCEPTANCE, "1", "Run only in the devcontainer test app");
const entity = `sensor.opencode_history_${randomUUID().replaceAll("-", "")}`;
async function core(path, method = "GET", body) {
  const response = await fetch(`http://supervisor/core/api${path}`, {
    method, signal: AbortSignal.timeout(10000), redirect: "error",
    headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `Core ${method} failed (${response.status})`);
  return response.json();
}
const client = new Client({ name: "history-acceptance", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8765/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${readFileSync("/run/opencode-v2/sidecar-secret", "utf8").trim()}` } },
});
const state = (sample) => core(`/states/${entity}`, "POST", { state: "42", attributes: { sample } });
let created = false;
async function call(args) {
  const result = await client.callTool({ name: "get_history", arguments: args });
  assert.ok(!result.isError, "History MCP call failed");
  return JSON.parse(result.content[0].text);
}
try {
  const config = await core("/config");
  console.log(`History acceptance: Core ${config.version}`);
  await state(0);
  created = true;
  await sleep(1100);
  const start = new Date().toISOString();
  for (let sample = 1; sample <= 3; sample += 1) {
    await sleep(1100);
    await state(sample);
  }
  await sleep(1100);
  const end = new Date().toISOString();
  const query = new URLSearchParams({ filter_entity_id: entity, end_time: end, significant_changes_only: "0", skip_initial_state: "true" });
  const path = `/history/period/${encodeURIComponent(start)}?${query}`;
  let recorded = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    recorded = (await core(path))[0] ?? [];
    if (recorded.length === 3) break;
    await sleep(1000);
  }
  assert.equal(recorded.length, 3, "Recorder must contain all three attribute-only updates");
  assert.equal(new Set(recorded.map((row) => row.last_changed)).size, 1);
  assert.equal(new Set(recorded.map((row) => row.last_updated)).size, 3);
  const lossy = (await core(`${path}&no_attributes=true`))[0] ?? [];
  console.log(`Core baseline: ${recorded.length} full rows; ${lossy.length} rows with no_attributes`);
  await client.connect(transport);
  const args = { entity_id: entity, start_time: start, end_time: end, include_all_changes: true, page_from: "oldest" };
  const full = await call({ ...args, minimal: false });
  const first = await call({ ...args, response_format: "values", limit: 2 });
  const second = await call(first.meta.continuation);
  assert.deepEqual([...first.data, ...second.data], full.data[0].map((row) => ({ state: row.state, timestamp: row.last_updated })));
  assert.equal(first.meta.total_events, 3);
  assert.equal(first.meta.numeric_summary.numeric_events, 3);
  assert.equal(first.meta.numeric_summary.sum, 126);
  assert.equal(second.meta.has_more, false);
  const compact = await call({ ...args, minimal: true });
  assert.equal(compact.data[0].length, 3);
  assert.ok(compact.data[0].every((row) => !("attributes" in row)));
  console.log("PASS: attribute-only rows, repeated values, timestamps, pagination, summaries and compact attribute removal");
} finally {
  try {
    await client.close();
  } finally {
    if (created) await core(`/states/${entity}`, "DELETE");
  }
}
