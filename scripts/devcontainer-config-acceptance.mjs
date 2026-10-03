// Opt-in on the official devcontainer beta app only. Uses its existing MCP
// sidecar/profile for writes and reloads; no HA credential leaves that service.
// Run with env -i PATH=... LD_PRELOAD=/usr/local/lib/opencode-v2-non-dumpable.so
// HA_CONFIG_ACCEPTANCE=1 node /local_apps/opencode/scripts/devcontainer-config-acceptance.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, lstat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readRuntimeFile } from "/opt/opencode-v2-homeassistant/lan-config.js";
import { Client } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "/opt/ha-mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
const require = createRequire("/opt/opencode-v2-homeassistant/package.json");
const prettier = require("prettier");
assert.equal(process.env.HA_CONFIG_ACCEPTANCE, "1");
assert.equal(process.getuid(), 0);
// The native preload intentionally removes LD_PRELOAD from the environment.
// Verify the resulting process boundary instead of expecting that input to stay.
const protectedProcess = spawnSync("python3", ["-c", "import sys\ntry:\n open('/proc/'+sys.argv[1]+'/environ','rb').close()\nexcept PermissionError:\n sys.exit(0)\nsys.exit(1)", String(process.pid)], { stdio: "ignore", timeout: 5000 });
assert.equal(protectedProcess.status, 0, "Credential-bearing test client must be non-dumpable");
const client = new Client({ name: "devcontainer-config-acceptance", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8765/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${readRuntimeFile("sidecar-secret", 64)}` } },
});
const file = "/homeassistant/scripts.yaml";
const backup = file + ".bak";
const id = "opencode_qualification_" + randomBytes(6).toString("hex");
const entity = "script." + id;
const recovery = "/data/" + id + ".original";
let original;
let changed = false;
let stage = "connect existing MCP/profile";
let candidate;
let invalid;
async function call(name, args = {}, allowError = false) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000, signal: AbortSignal.timeout(90000) });
  assert.ok(allowError || !result.isError, `MCP ${name} failed`);
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
async function reload() {
  await call("call_service", { domain: "script", service: "reload" });
}
try {
  await client.connect(transport);
  const tools = new Set((await client.listTools()).tools.map((item) => item.name));
  for (const name of ["write_config_safe", "validate_config", "call_service", "get_states", "get_config", "get_integration_docs", "hab_run"]) {
    assert.ok(tools.has(name), `Required tool unavailable in current profile: ${name}`);
  }
  stage = "check configuration prerequisites";
  const config = JSON.parse(await call("get_config"));
  assert.ok(JSON.stringify(config).includes("2026."), "Expected a current HA development Core");
  await call("get_integration_docs", { integration: "script" });
  const source = await readFile("/homeassistant/configuration.yaml", "utf8");
  assert.ok(/^script:\s*!include\s+scripts\.yaml\s*$/m.test(source), "Fixture requires the standard scripts.yaml include");
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size < 65536);
  original = await readFile(file, "utf8");
  // This development scenario requires an empty scripts map, avoiding any reload
  // interruption to existing scripts or rewrites of another user's YAML.
  assert.ok(["{}", ""].includes(original.trim()), "Development scripts.yaml must be empty for this qualification");
  await assert.rejects(lstat(backup), { code: "ENOENT" }, "Preserve any pre-existing safe-write recovery backup");
  assert.equal(JSON.parse(await call("validate_config")).result, "valid");
  const draft = `${id}:\n  alias: "OpenCode qualification ${id}"\n  mode: single\n  sequence:\n    - stop: "Qualification fixture; never execute."\n`;
  const unformatted = draft.replace("  mode: single", "  mode:    single");
  candidate = await prettier.format(unformatted, { parser: "yaml", tabWidth: 2, singleQuote: false });
  assert.ok(candidate !== unformatted && candidate.includes("mode: single"));
  await writeFile(recovery, original, { mode: 0o600, flag: "wx" });
  stage = "prevalidate and safe write";
  const dry = await call("write_config_safe", { file_path: "scripts.yaml", content: candidate, dry_run: true });
  assert.ok(dry.includes("PASSED - Safe to write"));
  assert.ok(await readFile(file, "utf8") === original, "Dry-run changed the source");
  changed = true;
  const written = await call("write_config_safe", { file_path: "scripts.yaml", content: candidate });
  assert.ok(written.includes("Safe Config Write - SUCCESS"));
  assert.ok(await readFile(file, "utf8") === candidate);
  assert.equal(JSON.parse(await call("validate_config")).result, "valid");
  stage = "reload and read-only load verification";
  await reload();
  const state = JSON.parse(await call("get_states", { entity_id: entity }));
  assert.ok(JSON.stringify(state).includes(entity));
  assert.ok(JSON.stringify(state).includes('"off"'), "Fixture must be loaded but never running");
  console.log("PASS: pinned formatting, MCP safe-write dry run, full HA validation, script reload and read-only loaded/off verification");
  stage = "failed-write preservation";
  // HA's global check may log integration schema issues without returning an
  // invalid result. Use a definite YAML parse error for rollback qualification;
  // successful config checks alone never replace runtime load verification.
  invalid = candidate + "  qualification_broken_yaml: [\n";
  const refused = await call("write_config_safe", { file_path: "scripts.yaml", content: invalid }, true);
  assert.ok(/FAILED|REFUSED/.test(refused), "Malformed YAML must fail validation");
  assert.ok(await readFile(file, "utf8") === candidate, "Invalid write did not preserve the last valid content");
  console.log("PASS: invalid configuration rejected and previous valid file retained; no invalid reload attempted");
} catch (error) {
  console.error(`Configuration acceptance failed during ${stage} (${error.name})`);
  process.exitCode = 1;
} finally {
  try {
    if (changed) {
      const current = await readFile(file, "utf8");
      assert.ok(current === candidate || current === invalid || current === original, "Unexpected concurrent edit: use protected recovery file");
      // HA retains an unavailable/restored registry entry after YAML removal.
      // The supported script-delete API removes our own entry as well. Delete
      // while its config key still exists, then restore the original bytes.
      if (current !== original) {
        if (current === invalid) {
          const validAgain = await call("write_config_safe", { file_path: "scripts.yaml", content: candidate });
          assert.ok(validAgain.includes("Safe Config Write - SUCCESS"));
        }
        const removed = JSON.parse(await call("hab_run", { command: `script delete ${id} --force --json` }));
        assert.equal(removed.data.success, true);
      }
      const restored = await call("write_config_safe", { file_path: "scripts.yaml", content: original, confirm_deletions: true });
      assert.ok(restored.includes("Safe Config Write - SUCCESS"));
      await reload();
      assert.ok(await readFile(file, "utf8") === original);
      const absent = await client.callTool({ name: "get_states", arguments: { entity_id: entity } }, undefined, { timeout: 15000 });
      assert.ok(absent.isError && /404|not found/i.test(JSON.stringify(absent)), "Synthetic script still loaded after cleanup");
      // Prerequisites established that this backup was created by this run.
      await unlink(backup);
      console.log("PASS: restored original YAML exactly and removed the synthetic runtime script without executing it");
    }
    await unlink(recovery).catch((error) => { if (error.code !== "ENOENT") throw error; });
  } catch {
    console.error(`Cleanup needs inspection; protected original retained at ${recovery}`);
    process.exitCode = 1;
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
}
