import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:net";
import { documentPath, readDocument, createLspSetup, requestLsp } from "../rootfs/opt/opencode-v2-homeassistant/lsp.js";
import { buildManagedConfig, DEFAULT_LSP_PACKAGE, READ_ONLY_AGENT_ID } from "../rootfs/opt/opencode-v2-homeassistant/managed-config.js";

test("LSP rejects private/outside paths, including virtual drafts", async () => {
  for (const path of ["../outside.yaml", "/data/options.yaml", "secrets.yaml", "secrets.yml", "nested/secrets.yml", ".storage/state.yaml", "ssl/key.yaml", "file.txt"]) {
    assert.throws(() => documentPath(path));
    await assert.rejects(readDocument(path, "draft: true"));
  }
  assert.equal(documentPath("packages/automation.yaml"), "/homeassistant/packages/automation.yaml");
});

test("LSP opens bounded real documents without following file or directory links", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-lsp-boundary-"));
  try {
    await mkdir(join(root, "workspace"));
    await mkdir(join(root, "private"));
    await writeFile(join(root, "workspace/config.yaml"), "test: true");
    await writeFile(join(root, "private/config.yaml"), "private-sentinel");
    await symlink(join(root, "private/config.yaml"), join(root, "workspace/link.yaml"));
    await symlink(join(root, "private"), join(root, "workspace/linked"));
    const workspace = join(root, "workspace");
    assert.equal((await readDocument("config.yaml", undefined, workspace)).text, "test: true");
    await assert.rejects(readDocument("link.yaml", undefined, workspace));
    await assert.rejects(readDocument("linked/config.yaml", undefined, workspace));
    await writeFile(join(workspace, "large.yaml"), "x".repeat(1024 * 1024 + 1));
    await assert.rejects(readDocument("large.yaml", undefined, workspace), /bounded/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("LSP uses native lsp permissions independently of MCP and bounds completion output", async () => {
  const config = buildManagedConfig({ pluginEnabled: false, lspEnabled: true });
  assert.ok(config.plugins.some((plugin) => plugin.package === DEFAULT_LSP_PACKAGE));
  assert.ok(config.permissions.some((rule) => rule.action === "lsp" && rule.effect === "allow"));
  assert.equal(config.agents[READ_ONLY_AGENT_ID].permissions.some((rule) => rule.action === "lsp" && rule.effect === "allow"), false);
  const tools = new Map();
  let calls = 0;
  let disposed = false;
  const cleanup = await createLspSetup({
    load: (path, text) => readDocument(path, text),
    request: async () => { calls++; return Array.from({ length: 130 }, (_, index) => ({ label: `entity${index}` })); },
  })({ tool: { async list() { return [...tools.keys()].map((id) => ({ id })); }, async transform(callback) {
    callback({ add(tool) { tools.set(tool.name, tool); } });
    return { dispose() { disposed = true; } };
  } } });
  assert.equal(tools.size, 5);
  assert.ok([...tools.values()].every((tool) => tool.options.permission === "lsp" && tool.options.codemode === false));
  const complete = tools.get("ha_yaml_completions");
  const result = await complete.execute({ path: "draft.yaml", text: "triggers:\n- trigger: ", line: 1, character: 11 }, { signal: new AbortController().signal });
  const body = JSON.parse(result.content);
  assert.equal(body.result.length, 100);
  assert.equal(body.total, 130);
  assert.equal(body.truncated, true);
  await assert.rejects(complete.execute({ path: "draft.yaml", text: "", line: 9, character: 0 }, {}), /outside/);
  assert.equal(calls, 1);
  await cleanup();
  assert.equal(disposed, true);
});

test("cancelling a stalled LSP request closes its connection", { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-lsp-cancel-"));
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.resume();
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    const path = process.platform === "win32" ? `\\\\.\\pipe\\ha-lsp-cancel-${process.pid}-${Date.now()}` : join(root, "lsp.sock");
    await new Promise((resolve) => server.listen(path, resolve));
    await assert.rejects(requestLsp("homeassistant/health", null, null, AbortSignal.timeout(50), path));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
