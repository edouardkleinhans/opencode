// Run inside the beta app with HA_LSP_ACCEPTANCE=1. Uses only in-memory YAML
// and HA reads; does not create configuration files or change devices.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { requestLsp, LSP_SOCKET } from "/opt/opencode-v2-homeassistant/lsp.js";

assert.equal(process.env.HA_LSP_ACCEPTANCE, "1");
const socket = await stat(LSP_SOCKET);
assert.equal(socket.uid, 0);
assert.equal(socket.mode & 0o777, 0o600);
const denied = spawnSync("runuser", ["-u", "opencode-v2-tui", "--", "python3", "-c", "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/run/opencode-v2/lsp.sock')"], { stdio: "ignore", timeout: 5000 });
assert.notEqual(denied.status, 0, "The unprivileged TUI must not reach the credential-bearing worker");
const health = await requestLsp("homeassistant/health");
assert.equal(health.authenticated, true);
assert.ok(health.core_version);
const path = "/homeassistant/opencode-lsp-in-memory-acceptance.yaml";
const completions = await requestLsp("textDocument/completion", { path, text: "triggers:\n- trigger: " }, { line: 1, character: 11 });
assert.ok(completions.some((item) => item.label === "state"));
const diagnostics = await requestLsp("textDocument/diagnostic", {
  path, text: "triggers:\n- trigger: state\n  entity_id: sensor.opencode_lsp_nonexistent_fixture\nactions:\n- action: opencode_fixture.missing_service\n",
});
assert.ok(diagnostics.items.some((item) => item.code === "unknown-entity"));
assert.ok(diagnostics.items.some((item) => item.code === "unknown-service"));
const clean = await requestLsp("textDocument/diagnostic", { path, text: "triggers:\n- trigger: time\n  at: '12:00:00'\nactions: []\n" });
assert.equal(clean.items.length, 0, "Diagnostics must reflect the corrected document");
console.log(`PASS: root-only credentialed LSP, Core ${health.core_version}, modern completion and live entity/service diagnostics`);
