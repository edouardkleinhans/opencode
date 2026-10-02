import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { equal } from "../ha-mcp-server/lib/ha-facing-auth.js";
import { createAssistService, assistJson, AssistError } from "./assist-service.js";

const requireValue = (value, status, code) => { if (!value) throw new AssistError(status, code); };
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
function page(res, content, path, installation) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'" });
  const installed = installation ? `<p>Bundled companion ${escape(installation.version)} installed at ${escape(installation.installed_at)}.</p>` : "";
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>OpenCode Assist</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:16px max(16px,env(safe-area-inset-right)) 16px max(16px,env(safe-area-inset-left))}button,a{min-height:44px;display:inline-flex;align-items:center}button{font:inherit;margin:4px;padding:8px 12px}code{overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}aside{border:1px solid #888;padding:12px}</style></head><body><a target="_self" href="${escape(path.replace(/ha-assist\/$/, ""))}">Back to OpenCode Beta</a><h1>OpenCode Assist pairing</h1><aside>${installed}<strong>Restart Home Assistant after installing or updating the companion.</strong> Restarting only the app is insufficient. This interrupts HA and Assist while Core restarts. If you have already restarted HA since installation, continue below. HA is never restarted automatically.</aside>${content}</body></html>`);
}
export async function startAssistHttp({ client, pairing, ingressSecret, verifyAdmin, hostname,
  directory = "/homeassistant", coreHost = "0.0.0.0", corePort = 8768, ipcPort = 8769, installation }) {
  const service = createAssistService({ client, directory, authenticate: (header) => pairing.authenticate(header),
    revokePairing: (owner) => { if (pairing.owner === owner) pairing.revoke(); } });
  const forms = new Map();
  let inflight = 0;
  const core = createServer({ requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 16384 }, (req, res) => { void service.handle(req, res); });
  const ipc = createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 16384 }, (req, res) => {
    void (async () => {
      requireValue(req.socket.remoteAddress === "127.0.0.1" && equal(req.headers["x-ha-mcp-ingress-secret"], ingressSecret), 403, "untrusted_ingress");
      requireValue(req.url === "/ha-assist/" && ["GET", "POST"].includes(req.method), 404, "not_found");
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
        for (const [key, value] of forms) if (value.expires <= Date.now()) forms.delete(key);
        if (req.method === "GET") {
          requireValue(forms.size < 64, 429, "busy");
          const csrf = randomBytes(32).toString("base64url");
          forms.set(csrf, { user, origin, path, expires: Date.now() + 300000 });
          return show(`<p>Pair the optional OpenCode Assist companion integration for HA-owned conversations and AI data tasks. Home Assistant chooses and executes its selected tools. The credential permits model usage, not the OpenCode administrative API. Provider charges may apply.</p><p>After the HA restart, add <strong>OpenCode Assist</strong> in Settings → Devices &amp; services. The config flow requires the URL and key you create here; pairing is not automatic.</p><p>Current pairing: ${pairing.owner ? "configured" : "none"}.</p><form method="post" action="${escape(path)}"><input type="hidden" name="csrf" value="${csrf}"><button name="action" value="provision">Create or replace pairing</button> <button name="action" value="revoke">Revoke pairing</button></form>`);
        }
        requireValue(req.headers.origin === origin && req.headers["content-type"]?.split(";")[0] === "application/x-www-form-urlencoded", 403, "invalid_origin");
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; requireValue(size <= 2048, 413, "too_large"); chunks.push(chunk); }
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        requireValue(params.getAll("csrf").length === 1 && params.getAll("action").length === 1, 400, "invalid_form");
        const nonce = forms.get(params.get("csrf"));
        requireValue(nonce && nonce.user === user && nonce.origin === origin && nonce.path === path, 403, "invalid_csrf");
        forms.delete(params.get("csrf"));
        requireValue(["provision", "revoke"].includes(params.get("action")), 400, "invalid_action");
        const old = pairing.owner;
        // Revoke before awaiting cancellation so no new request can use the old token.
        pairing.revoke();
        if (old) await service.revoke(old);
        forms.clear();
        if (params.get("action") === "revoke") return show("<p>Pairing revoked. Active requests have been cancelled.</p>");
        const token = pairing.provision();
        return show(`<p>Use these values in Settings → Devices &amp; services → Add integration → OpenCode Assist. The credential is shown once; copy it before leaving this page. On iOS, touch and hold the URL or key to select and copy it. The internal HTTP endpoint must not be published on the host.</p><p>URL: <code>http://${escape(hostname)}:${core.address().port}</code></p><p>Pairing key: <code>${escape(token)}</code></p>`);
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
  return { core, ipc, async close() { await service.close(); await Promise.all([stop(core), stop(ipc)]); } };
}
