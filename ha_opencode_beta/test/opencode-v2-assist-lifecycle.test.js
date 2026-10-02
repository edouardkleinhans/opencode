import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireStateLock } from "../rootfs/opt/ha-mcp-server/lib/ha-facing-auth.js";
import { launchAssist } from "../rootfs/opt/opencode-v2-homeassistant/assist-main.js";
import { openAssistPairing } from "../rootfs/opt/opencode-v2-homeassistant/assist-pairing.js";

const supported = process.platform === "linux";
const options = (directory) => ({ stateDirectory: join(directory, "state"), ingressSecretPath: join(directory, "ipc/secret"),
  hostname: "fixture", coreHost: "127.0.0.1", corePort: 0, ipcPort: 0, client: { rpc: () => ({}) }, verifyAdmin: async () => false });

test("Assist worker locks pairing state until close, closes once, and preserves pairing on restart", { skip: !supported }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "assist-lifecycle-"));
  const settings = options(directory);
  const listeners = process.listenerCount("SIGTERM");
  let service;
  try {
    const key = openAssistPairing(settings.stateDirectory).provision("a".repeat(43));
    service = await launchAssist(settings);
    await assert.rejects(launchAssist(settings), { code: "EADDRINUSE" });
    const closed = service.close();
    assert.equal(service.close(), closed);
    await closed;
    assert.equal(service.core.listening, false);
    assert.equal(service.ipc.listening, false);
    assert.equal(process.listenerCount("SIGTERM"), listeners);
    await (await acquireStateLock(settings.stateDirectory))();
    service = await launchAssist(settings);
    assert.ok(openAssistPairing(settings.stateDirectory).authenticate(`Bearer ${key}`));
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Assist startup failure releases the lock and listener without masking the original error", { skip: !supported }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "assist-startup-failure-"));
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const settings = { ...options(directory), ipcPort: occupied.address().port };
  try {
    // The Core listener starts first; failing IPC must close it and unlock state.
    await assert.rejects(launchAssist(settings), { code: "EADDRINUSE" });
    await (await acquireStateLock(settings.stateDirectory))();
    const service = await launchAssist({ ...settings, ipcPort: 0 });
    await service.close();
    // Fail earlier, while creating the IPC secret, after opening pairing state.
    await assert.rejects(launchAssist({ ...settings, ingressSecretPath: settings.stateDirectory }), { code: "EISDIR" });
    await (await acquireStateLock(settings.stateDirectory))();
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker shutdown aborts an in-flight Supervisor publication before unlocking", { skip: !supported, timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "assist-discovery-stop-"));
  const settings = options(directory);
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  let aborted = false;
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    started();
  }));
  let service;
  try {
    service = await launchAssist({ ...settings, supervisorToken: "fixture-supervisor" });
    await requested;
    await service.close();
    assert.equal(aborted, true);
    assert.equal(service.core.listening, false);
    await (await acquireStateLock(settings.stateDirectory))();
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const signal of ["SIGTERM", "SIGINT", "both"]) {
  test(`Assist supervised worker exits cleanly on ${signal} and releases its lock`, { skip: !supported, timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "assist-signal-"));
    const settings = options(directory);
    const moduleUrl = new URL("../rootfs/opt/opencode-v2-homeassistant/assist-main.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { launchAssist } from ${JSON.stringify(moduleUrl)};
      await launchAssist({ ...${JSON.stringify(settings)}, client: { rpc: () => ({}) }, verifyAdmin: async () => false });
      process.on("message", () => { process.emit("SIGTERM"); process.emit("SIGINT"); });
      process.send("ready");
    `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = once(child, "exit");
    try {
      await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Worker exited before ready: ${stderr}`); })]);
      await assert.rejects(acquireStateLock(settings.stateDirectory), { code: "EADDRINUSE" });
      if (signal === "both") child.send("stop-twice");
      else child.kill(signal);
      assert.deepEqual(await exited, [0, null], stderr);
      assert.equal(stderr, "");
      await (await acquireStateLock(settings.stateDirectory))();
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
