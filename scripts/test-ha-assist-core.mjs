import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startAssistFixture } from "../ha_opencode_beta/test/helpers/assist-fixture.mjs";
import { startAssistHttp } from "../ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/assist-http.js";
import { createAssistBootstrap } from "../ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/assist-discovery.js";
import { openAssistPairing } from "../ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/assist-pairing.js";
import { createAssistRestartNotification } from "../ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/assist-notification.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = await startAssistFixture(async (body, emit) => {
  const result = body.messages.findLast(({ role }) => role === "tool");
  if (result) { emit({ role: "assistant", content: `Completed ${result.content}` }); emit({}, "stop"); return; }
  assert.equal(body.tools.length, 1);
  const tool = body.tools[0].function;
  emit({ role: "assistant", content: "Checking " });
  emit({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: tool.name, arguments: '{"name":"Fixture"}' } }] });
  emit({}, "tool_calls");
});
const state = await mkdtemp(join(tmpdir(), "ha-assist-contract-"));
const pairing = openAssistPairing(state);
const bootstrap = createAssistBootstrap(pairing);
let service;
try {
  let notification;
  await createAssistRestartNotification({ directory: state, hostname: "fixture-beta", token: "fixture-only",
    installation: { action: "updated", version: "0.1.0b4", installed_at: "2026-10-02T10:00:00+00:00" },
    fetchImpl: async (_url, request) => { notification = request.body; return Response.json([]); },
  }).notify();
  service = await startAssistHttp({ client: fixture.client, pairing, bootstrap, ingressSecret: "fixture-ipc", verifyAdmin: async () => false,
    coreHost: "127.0.0.1", corePort: 0, ipcPort: 0 });
  // Host networking reaches only this fixture's loopback listener. No real HA
  // config, secrets or provider credentials are mounted into the test container.
  const child = spawn("docker", ["run", "--rm", "--network", "host", "--entrypoint", "python",
    "-e", "PYTHONPATH=/work", "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", `ASSIST_FIXTURE_URL=http://127.0.0.1:${service.core.address().port}`,
    "-e", `ASSIST_FIXTURE_BOOTSTRAP=${bootstrap.current().bootstrap}`,
    "-e", `ASSIST_FIXTURE_NOTIFICATION=${notification}`,
    "-v", `${root}ha_opencode_beta/rootfs/opt/opencode-assist/custom_components:/work/custom_components:ro`, "-v", `${root}tests/ha_assist_contract.py:/work/ha_assist_contract.py:ro`, "-w", "/work",
    "ghcr.io/home-assistant/home-assistant:2026.10.0b0", "ha_assist_contract.py"], { stdio: "inherit" });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
  await service.close();
  assert.equal((await fixture.client.session.list()).data.length, 0);
} finally {
  await service?.close(); await fixture.close(); await rm(state, { recursive: true, force: true });
}
