import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { OpenCode } from "../../rootfs/opt/opencode-v2-homeassistant/node_modules/@opencode/client/dist/promise/index.js";

const runtime = fileURLToPath(new URL("../../rootfs/opt/opencode-v2-homeassistant/", import.meta.url));
export async function startAssistFixture(respond) {
  const root = await mkdtemp(join(tmpdir(), "ha-assist-adapter-"));
  let child;
  const requests = [];
  const provider = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts));
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      await respond(body, emit, res);
      if (!res.writableEnded) res.end("data: [DONE]\n\n");
    } catch { res.destroy(); }
  });
  let logs = "";
  const close = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited; clearTimeout(timer);
    }
    provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    for (const name of ["home", "config", "data", "cache", "state", "project"]) await mkdir(join(root, name));
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const configPath = join(root, "managed.json");
    await writeFile(configPath, JSON.stringify({
      model: "fixture/coding", plugins: [{ package: pathToFileURL(join(runtime, "assist-plugin")).href }],
      agents: { "home-assistant-assist": { mode: "primary", hidden: true, system: "Fixture private agent", permissions: [{ action: "*", resource: "*", effect: "deny" }] } },
      providers: { fixture: { name: "Fixture", env: ["FIXTURE_API_KEY"], package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1` },
        models: { coding: { modelID: "fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32000, output: 1000 } } } } },
    }));
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    child = spawn(join(runtime, "node_modules/@opencode/cli/bin/opencode.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
      cwd: join(root, "project"), stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG: configPath,
        OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_SERVER_PASSWORD: "fixture-password", FIXTURE_API_KEY: "fixture-only" },
    });
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", (chunk) => { logs += chunk; });
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}` } });
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        await client.server.info({ signal: AbortSignal.timeout(500) });
        await client.agent.list();
        const models = await client.model.list({ location: { directory: join(root, "project") } });
        if (!models.data.some((model) => model.providerID === "fixture")) { await sleep(50); continue; }
        return { client, requests, close, directory: join(root, "project"), logs: () => logs };
      }
      catch { await sleep(50); }
    }
    throw new Error("Isolated Assist fixture did not start");
  } catch (error) { await close(); throw error; }
}
