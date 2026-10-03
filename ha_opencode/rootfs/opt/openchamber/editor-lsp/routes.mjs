// Mounted AFTER OpenChamber's /api authentication middleware. No credentials,
// general LSP methods, disk fallback, configurable socket or target are exposed.
const METHODS = Object.freeze({ diagnostics: "textDocument/diagnostic", completions: "textDocument/completion" });
const MAX_BODY = 2 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_RESULT = 256 * 1024;
let inFlight = 0; // Process-wide, not per editor/session/router.
const failure = (status) => Object.assign(new Error("Editor language service request failed"), { status });
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.includes(key));

export function sameOrigin(req) {
  // Deliberately ignore Forwarded/X-Forwarded-* until a trusted proxy supplies
  // a validated authority. Loopback transport alone does NOT validate headers.
  try {
    const origin = new URL(req.headers.origin);
    return ["http:", "https:"].includes(origin.protocol)
      && origin.origin === req.headers.origin
      && origin.host === req.headers.host
      && origin.protocol === (req.socket.encrypted ? "https:" : "http:")
      && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin");
  } catch { return false; }
}

export function validateDraft(body, operation, documentPath) {
  if (!exactKeys(body, ["path", "text", "editorId", "version", ...(operation === "completions" ? ["position"] : [])])
      || typeof body.path !== "string" || body.path.length > 4096
      || typeof body.text !== "string"
      || typeof body.editorId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.editorId)
      || !Number.isSafeInteger(body.version) || body.version < 0) throw failure(400);
  if (Buffer.byteLength(body.text) > MAX_TEXT) throw failure(413);
  let path;
  try { path = documentPath(body.path); } catch { throw failure(403); }
  if (operation === "completions") {
    const position = body.position;
    const lines = body.text.split(/\r\n|\r|\n/);
    if (!exactKeys(position, ["line", "character"]) || !Number.isSafeInteger(position.line)
        || !Number.isSafeInteger(position.character) || position.line < 0 || position.line >= lines.length
        || position.character < 0 || position.character > lines[position.line].length) throw failure(400);
  }
  return { path, text: body.text };
}

function boundedResult(operation, body, path, result) {
  const items = Array.isArray(result) ? result : result?.items;
  // A missing/failed diagnostic report must never masquerade as a clean draft.
  if (!Array.isArray(items)) throw failure(503);
  const response = { path, editorId: body.editorId, version: body.version,
    items: items.slice(0, 100), truncated: items.length > 100,
    ...(operation === "completions" ? { isIncomplete: Boolean(result?.isIncomplete) || items.length > 100 } : {}) };
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded) > MAX_RESULT) throw failure(503);
  return encoded;
}

export function registerEditorLspRoutes(app, { express,
  loadClient = () => import("/opt/opencode-v2-homeassistant/lsp-client.js"),
  timeoutMs = 15000,
} = {}) {
  const parse = express.json({ limit: MAX_BODY, strict: true, inflate: false });
  for (const [operation, method] of Object.entries(METHODS)) {
    app.post(`/api/ha-editor-lsp/${operation}`, (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      if (!sameOrigin(req)) return res.status(403).json({ error: "Editor language service request denied" });
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "")) {
        return res.status(400).json({ error: "Editor language service requires JSON" });
      }
      parse(req, res, (error) => {
        if (error) return res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid editor request" });
        next();
      });
    }, async (req, res) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!res.writableEnded) abort(); };
      req.once("aborted", abort);
      res.once("close", close);
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([controller.signal, deadline]);
      let acquired = false;
      try {
        // Laziness permits the builder's server import smoke check, before the
        // runtime package is installed. The import target is never client input.
        const client = await loadClient();
        const document = validateDraft(req.body, operation, client.documentPath);
        signal.throwIfAborted();
        if (inFlight >= 2) throw failure(429);
        inFlight++;
        acquired = true;
        const result = await client.requestLsp(method, document, req.body.position, signal);
        signal.throwIfAborted();
        res.type("application/json").send(boundedResult(operation, req.body, document.path, result));
      } catch (error) {
        if (!controller.signal.aborted && !res.destroyed) {
          const status = deadline.aborted ? 504 : [400, 403, 413, 429].includes(error?.status) ? error.status : 503;
          res.status(status).json({ error: status === 429 ? "Editor language service busy" : "Editor language service unavailable or request rejected" });
        }
      } finally {
        if (acquired) inFlight--;
        req.removeListener("aborted", abort);
        res.removeListener("close", close);
      }
    });
  }
}
