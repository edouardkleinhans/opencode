import { createServer } from "node:http";
import { equal } from "../ha-mcp-server/lib/ha-facing-auth.js";
import { createAssistService, assistJson, AssistError, readAssistJson } from "./assist-service.js";

const requireValue = (value, status, code) => { if (!value) throw new AssistError(status, code); };
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
function page(res, content, path, installation) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'" });
  const installed = installation ? `<p>Bundled companion ${escape(installation.version)} installed at ${escape(installation.installed_at)}.</p>` : "";
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>OpenCode Assist</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:16px max(16px,env(safe-area-inset-right)) 16px max(16px,env(safe-area-inset-left))}a{min-height:44px;display:inline-flex;align-items:center}aside{border:1px solid #888;padding:12px}</style></head><body><a target="_self" href="${escape(path.replace(/ha-assist\/$/, ""))}">Back to OpenCode Beta</a><h1>OpenCode Assist setup</h1><aside>${installed}<strong>Restart Home Assistant after installing or updating the companion.</strong> Restarting only the app is insufficient. This interrupts HA and Assist while Core restarts. If you have already restarted HA since installation, continue below. HA is never restarted automatically.</aside>${content}</body></html>`);
}
export async function startAssistHttp({ client, pairing, ingressSecret, verifyAdmin,
  directory, coreHost = "0.0.0.0", corePort = 8768, ipcPort = 8769, installation, bootstrap, discovery }) {
  const service = createAssistService({ client, directory, authenticate: (header) => pairing.authenticate(header),
    revokePairing: (owner) => { if (pairing.owner === owner) { pairing.revoke(); bootstrap?.invalidate(); } } });
  let inflight = 0;
  let pairingBusy = false;
  async function handleCore(req, res) {
    if (req.url !== "/v1/onboarding" || !bootstrap) return service.handle(req, res);
    try {
      requireValue(!req.headers.origin && req.rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === "authorization").length === 1, 403, "untrusted_onboarding");
      try { bootstrap.authorize(req.headers.authorization); } catch { throw new AssistError(401, "bootstrap_expired"); }
      requireValue(["GET", "POST"].includes(req.method), 405, "method_not_allowed");
      if (req.method === "GET") return assistJson(res, 200, await service.info());
      requireValue(!pairingBusy, 409, "pairing_busy");
      pairingBusy = true;
      try {
        const body = await readAssistJson(req, 1024);
        requireValue(body && Object.keys(body).length === 1 && typeof body.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.key), 400, "invalid_pairing_key");
        const old = pairing.owner;
        try { bootstrap.pair(req.headers.authorization, body.key); } catch { throw new AssistError(409, "pairing_conflict"); }
        if (old && old !== pairing.owner) await service.revoke(old);
        return assistJson(res, 200, { paired: true });
      } finally { pairingBusy = false; }
    } catch (error) {
      if (!res.headersSent) assistJson(res, error instanceof AssistError ? error.status : 503, { error: error instanceof AssistError ? error.message : "unavailable" });
      else res.destroy();
    }
  }
  const core = createServer({ requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 16384 }, (req, res) => { void handleCore(req, res); });
  const ipc = createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 16384 }, (req, res) => {
    void (async () => {
      requireValue(req.socket.remoteAddress === "127.0.0.1" && equal(req.headers["x-ha-mcp-ingress-secret"], ingressSecret), 403, "untrusted_ingress");
      requireValue(req.url === "/ha-assist/", 404, "not_found");
      requireValue(req.method === "GET", 405, "method_not_allowed");
      requireValue(inflight < 4, 429, "busy"); inflight++;
      try {
        const user = req.headers["x-ha-mcp-user-id"];
        const origin = req.headers["x-ha-mcp-external-origin"];
        const path = req.headers["x-ha-mcp-external-path"];
        const external = new URL(origin);
        requireValue(external.origin === origin && ["http:", "https:"].includes(external.protocol), 403, "invalid_origin");
        requireValue(typeof path === "string" && /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/ha-assist\/$/.test(path), 403, "invalid_path");
        requireValue(typeof user === "string" && await verifyAdmin(user), 403, "administrator_required");
        const show = (content) => page(res, content, path, installation);
        const configured = Boolean(pairing.owner);
        const setup = configured
          ? `<h2>Add a conversation agent or AI data task</h2><p>Your app connection is already paired. Open <strong>Settings → Devices &amp; services → OpenCode Assist</strong>, then choose <strong>Add conversation agent</strong> for Assist or <strong>Add AI data task</strong> for automations and scripts. You can add both, one at a time, using this same connection.</p>`
          : `<h2>Automatic Home Assistant setup</h2><p>${discovery?.published ? "OpenCode Assist has been announced to Home Assistant through Supervisor." : "Supervisor discovery is starting or retrying; check the app log if the discovered card does not appear."} After the Core restart, open <strong>Settings → Devices &amp; services</strong> and configure the discovered <strong>OpenCode Assist</strong> app. Choose your first entity, confirm the connection, then choose your model and, for conversations, Home Assistant APIs. No URL or key needs copying.</p>`;
        return show(`<p>Home Assistant owns your conversations and selected tools. Provider charges may apply.</p>${setup}<p><a target="_top" href="https://my.home-assistant.io/redirect/${configured ? "integration" : "config_flow_start"}/?domain=opencode_assist">${configured ? "Open OpenCode Assist" : "Open Home Assistant setup"}</a></p><p>Current pairing: ${configured ? "configured" : "none"}.</p><p>Manage or renew this connection in Home Assistant. Removing the integration revokes its pairing. Old experimental manually paired entries should be removed and recreated through this automatic flow.</p>`);
      } finally { inflight--; }
    })().catch((error) => {
      if (!res.headersSent) assistJson(res, error instanceof AssistError ? error.status : 503, { error: error instanceof AssistError ? error.message : "unavailable" });
      else res.destroy();
    });
  });
  core.maxConnections = 48; ipc.maxConnections = 16;
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
  const stop = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  try { await listen(core, corePort, coreHost); await listen(ipc, ipcPort, "127.0.0.1"); }
  catch (error) { await Promise.all([stop(core), stop(ipc)]); throw error; }
  return { core, ipc, async close() { bootstrap?.invalidate(); try { await service.close(); } finally { await Promise.all([stop(core), stop(ipc)]); } } };
}
