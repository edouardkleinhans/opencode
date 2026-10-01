import { once } from "node:events";
import { AssistRpc } from "./assist-rpc.js";

export class AssistError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const requireValue = (value, status, code) => { if (!value) throw new AssistError(status, code); };
export async function readAssistJson(req) {
  requireValue(req.headers["content-type"]?.split(";")[0] === "application/json", 415, "json_required");
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= 524288, 413, "request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new AssistError(400, "invalid_json"); }
}
export function assistJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

// Fixed-purpose facade: never forward caller paths, headers, sessions, file
// attachments, agents or permissions to the privileged OpenCode API.
export function createAssistService({ client, authenticate, revokePairing, directory = "/homeassistant" }) {
  const active = new Map();
  const starting = new Set();
  let closing = false;
  const rpc = client.rpc(AssistRpc);
  async function models() {
    const result = await client.model.list({ location: { directory } });
    return result.data.filter((model) => model.enabled !== false && model.capabilities?.input?.includes("text") && model.capabilities?.output?.includes("text"))
      .map((model) => ({ id: model.id, providerID: model.providerID, name: model.name,
        tools: model.capabilities.tools === true }));
  }
  async function cleanup(request) {
    if (request.closing) return request.closing;
    request.abort.abort();
    request.closing = (async () => {
      if (request.id) await rpc.release({ requestID: request.id }).catch(() => {});
      else await client.session.interrupt({ sessionID: request.sessionID }).catch(() => {});
      await client.session.remove({ sessionID: request.sessionID }).catch(() => {});
      active.delete(request.id);
    })();
    return request.closing;
  }
  async function revoke(owner) {
      for (const pending of starting) if (pending.owner === owner) pending.abort.abort();
      await Promise.all([...active.values()].filter((r) => r.owner === owner).map(cleanup));
  }
  return {
    revoke,
    async close() {
      closing = true;
      for (const pending of starting) pending.abort.abort();
      await Promise.all([...active.values()].map(cleanup));
    },
    async handle(req, res) {
      let request;
      let reservation;
      try {
        requireValue(!closing, 503, "unavailable");
        requireValue(!req.headers.origin, 403, "browser_requests_denied");
        requireValue(req.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "authorization").length === 1, 401, "unauthorized");
        const owner = authenticate(req.headers.authorization);
        requireValue(owner, 401, "unauthorized");
        const path = req.url;
        if (req.method === "DELETE" && path === "/v1/pairing" && revokePairing) {
          revokePairing(owner);
          await revoke(owner);
          assistJson(res, 200, { revoked: true }); return;
        }
        if (req.method === "GET" && path === "/v1/info") {
          assistJson(res, 200, { version: 1, conversation: true, generate_data: true, streaming: true,
            attachments: false, generate_image: false, models: await models() }); return;
        }
        const match = /^\/v1\/requests\/([a-f0-9-]{36})\/results$/.exec(path);
        if (req.method === "POST" && match) {
          const current = active.get(match[1]);
          requireValue(current && current.owner === owner && !current.closing, 404, "unknown_request");
          const body = await readAssistJson(req);
          requireValue(typeof body.callID === "string" && body.result && typeof body.result === "object", 400, "invalid_result");
          await rpc.result({ requestID: current.id, callID: body.callID, result: body.result });
          assistJson(res, 200, { accepted: true }); return;
        }
        requireValue(req.method === "POST" && path === "/v1/requests", 404, "not_found");
        requireValue(active.size + starting.size < 8, 429, "busy");
        reservation = { owner, abort: new AbortController() };
        starting.add(reservation);
        res.once("close", () => reservation.abort.abort());
        const body = await readAssistJson(req);
        requireValue(body && typeof body === "object" && Object.keys(body).every((key) => ["system", "messages", "tools", "model"].includes(key)), 400, "invalid_request");
        requireValue(Array.isArray(body.tools) && Array.isArray(body.messages) && typeof body.system === "string", 400, "invalid_request");
        const model = (await models()).find((candidate) => candidate.id === body.model?.id && candidate.providerID === body.model?.providerID);
        requireValue(model && (!body.tools.length || model.tools), 400, "unsupported_model");
        const session = await client.session.create({ title: "Home Assistant request", location: { directory }, agent: "home-assistant-assist", model: { id: model.id, providerID: model.providerID },
          permissions: [{ action: "*", resource: "*", effect: "deny" }] });
        request = { sessionID: session.id, owner, abort: reservation.abort };
        request.abort.signal.throwIfAborted();
        const prepared = await rpc.prepare({ sessionID: session.id, system: body.system, messages: body.messages, tools: body.tools });
        request.id = prepared.requestID;
        active.set(request.id, request);
        starting.delete(reservation);
        request.abort.signal.throwIfAborted();
        await client.session.update({ sessionID: session.id, permissions: prepared.permissions });
        await rpc.start({ requestID: request.id });
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.write(JSON.stringify({ type: "request", id: request.id }) + "\n");
        const deadline = AbortSignal.timeout(125000);
        const signal = AbortSignal.any([deadline, request.abort.signal]);
        let done = false;
        while (!done) {
          const { events } = await rpc.poll({ requestID: request.id }, { signal });
          for (const event of events) {
            if (!res.write(JSON.stringify(event) + "\n")) await once(res, "drain", { signal });
            if (event.type === "done" || event.type === "error") { done = true; break; }
          }
        }
        res.end();
      } catch (error) {
        if (!res.headersSent) assistJson(res, error instanceof AssistError ? error.status : 502,
          { error: error instanceof AssistError ? error.message : "assist_unavailable" });
        else if (!res.destroyed) res.end(JSON.stringify({ type: "error", code: "generation_failed" }) + "\n");
      } finally {
        if (reservation) starting.delete(reservation);
        if (request) await cleanup(request);
      }
    },
  };
}
