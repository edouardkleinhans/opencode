import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startAssistHttp } from "../../rootfs/opt/opencode-v2-homeassistant/assist-http.js";
import { openAssistPairing } from "../../rootfs/opt/opencode-v2-homeassistant/assist-pairing.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

export async function startAssistUiFixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), "assist-ui-"));
  const base = "/api/hassio_ingress/ios_fixture";
  const admin = "a".repeat(32);
  let user = admin;
  const pairing = openAssistPairing(directory);
  const worker = await startAssistHttp({ client: { rpc: () => ({}) }, pairing,
    ingressSecret: "fixture-secret", verifyAdmin: async (id) => id === admin, discovery: { published: true },
    coreHost: "127.0.0.1", corePort: 0, ipcPort: 0, installation: { version: "0.1.0b3", installed_at: "2026-10-02T10:00:00Z" } });
  // Match the pinned ttyd/container and OpenChamber fullscreen layout contracts.
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><style>html,body{height:100%;min-height:100%;margin:0;overflow:hidden}#terminal-container,#root{height:100%}.h-screen{height:100vh;min-height:100dvh}</style></head><body>${mode === "terminal" ? '<div id="terminal-container">Terminal</div>' : '<div id="root"><div class="flex flex-col h-screen">OpenChamber</div></div>'}</body></html>`);
  });
  await listen(upstream);
  const proxyPath = fileURLToPath(new URL("../../rootfs/usr/local/bin/openchamber-ingress-proxy.js", import.meta.url));
  const probe = createServer(); await listen(probe); const port = probe.address().port; await close(probe);
  const child = spawn(process.execPath, [proxyPath], { env: { ...process.env, HA_INGRESS_UI: mode,
    OPENCHAMBER_INGRESS_HOST: "127.0.0.1", OPENCHAMBER_INGRESS_PORT: String(port), HA_INGRESS_PROXY_IP: "127.0.0.1",
    OPENCHAMBER_UPSTREAM_PORT: String(upstream.address().port) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("UI proxy did not start")), 5000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("UI proxy exited")); });
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(); } });
  });
  let origin;
  const gateway = createServer((req, res) => {
    if (req.url === "/ha-parent") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe title="Ingress" src="${base}/" style="display:block;border:0;width:100vw;height:100dvh"></iframe></body></html>`);
      return;
    }
    const pairing = req.url === `${base}/ha-assist/`;
    // Simulate Core's authenticated Ingress metadata and the separately tested
    // trusted IPC hop. The real worker still enforces admin and trusted metadata.
    const headers = pairing ? { ...req.headers, "x-ha-mcp-ingress-secret": "fixture-secret", "x-ha-mcp-user-id": user,
      "x-ha-mcp-external-origin": origin, "x-ha-mcp-external-path": base + "/ha-assist/" } : {
      ...req.headers, "x-ingress-path": base, "x-remote-user-id": user,
      "x-forwarded-proto": "http", "x-forwarded-host": new URL(origin).host,
    };
    const upstreamReq = request({ hostname: "127.0.0.1", port: pairing ? worker.ipc.address().port : port,
      path: pairing ? "/ha-assist/" : req.url, method: req.method, headers }, (response) => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstreamReq.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstreamReq);
  });
  await listen(gateway);
  origin = `http://127.0.0.1:${gateway.address().port}`;
  return { origin, base, port, pairing, setUser: (value) => { user = value; },
    async close() { await close(gateway); child.kill(); await once(child, "exit"); await close(upstream); await worker.close(); await rm(directory, { recursive: true, force: true }); } };
}
