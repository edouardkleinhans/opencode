import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startAssistFixture } from "../ha_opencode_beta/test/helpers/assist-fixture.mjs";
import { createAssistService } from "../ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/assist-service.js";

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
const service = createAssistService({ client: fixture.client, directory: fixture.directory,
  authenticate: (header) => header === "Bearer fixture-only" ? "fixture" : null });
const server = createServer((req, res) => { void service.handle(req, res); });
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Host networking reaches only this fixture's loopback listener. No real HA
  // config, secrets or provider credentials are mounted into the test container.
  const child = spawn("docker", ["run", "--rm", "--network", "host", "--entrypoint", "python",
    "-e", "PYTHONPATH=/work", "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", `ASSIST_FIXTURE_URL=http://127.0.0.1:${server.address().port}`,
    "-v", `${root}ha_opencode_beta/rootfs/opt/opencode-assist/custom_components:/work/custom_components:ro`, "-v", `${root}tests/ha_assist_contract.py:/work/ha_assist_contract.py:ro`, "-w", "/work",
    "ghcr.io/home-assistant/home-assistant:2026.10.0b0", "ha_assist_contract.py"], { stdio: "inherit" });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
  await service.close();
  assert.equal((await fixture.client.session.list()).data.length, 0);
} finally {
  await service.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fixture.close();
}
