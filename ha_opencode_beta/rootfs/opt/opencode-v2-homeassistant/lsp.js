import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { documentPath, readDocument, requestLsp } from "./lsp-client.js";
export { documentPath, readDocument, requestLsp, LSP_SOCKET, MAX_DOCUMENT_BYTES } from "./lsp-client.js";

export const LSP_PLUGIN_ID = "homeassistant.lsp";
const METHODS = {
  diagnostics: "textDocument/diagnostic", completions: "textDocument/completion",
  hover: "textDocument/hover", definition: "textDocument/definition",
};

export function createLspSetup({ request = requestLsp, load = readDocument } = {}) {
  return async (ctx) => {
    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "ha_yaml_status", description: "Check the real Home Assistant YAML language server and its authenticated HA connection.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false, permission: "lsp" },
        execute: async (_input, context) => ({ content: JSON.stringify(await request("homeassistant/health", null, null, context.signal)) }),
      });
      for (const [name, method] of Object.entries(METHODS)) {
        const positioned = name !== "diagnostics";
        editor.add({
          name: `ha_yaml_${name}`,
          description: `Home Assistant YAML ${name} through the credential-isolated language server. Reads a workspace file or validates supplied in-memory text; never writes files. Positions use zero-based lines and UTF-16 character offsets.`,
          input: {
            type: "object", additionalProperties: false,
            properties: {
              path: { type: "string", description: "YAML path relative to /homeassistant, or an absolute path inside it" },
              text: { type: "string", description: "Optional in-memory YAML draft; no file is written" },
              ...(positioned ? { line: { type: "integer", minimum: 0 }, character: { type: "integer", minimum: 0 } } : {}),
            },
            required: positioned ? ["path", "line", "character"] : ["path"],
          },
          options: { codemode: false, permission: "lsp" },
          execute: async (input, context) => {
            const document = await load(input.path, input.text);
            const lines = document.text.split("\n");
            if (positioned && (!Number.isInteger(input.line) || !Number.isInteger(input.character) || input.line < 0 || input.line >= lines.length || input.character < 0 || input.character > lines[input.line].length)) {
              throw new Error("LSP position is outside the document");
            }
            let result = await request(method, document, positioned ? { line: input.line, character: input.character } : null, context.signal);
            if (name === "definition" && result) {
              const entries = Array.isArray(result) ? result : [result];
              result = entries.filter((entry) => {
                try { documentPath(fileURLToPath(entry.uri ?? entry.targetUri)); return true; } catch { return false; }
              });
            }
            const items = Array.isArray(result) ? result : result?.items;
            const total = items?.length;
            if (items) result = Array.isArray(result) ? items.slice(0, 100) : { ...result, items: items.slice(0, 100) };
            const content = JSON.stringify({ path: document.path, result, ...(total !== undefined ? { total, truncated: total > 100 } : {}) });
            if (Buffer.byteLength(content) > 256 * 1024) throw new Error("LSP response is too large; use a more specific query");
            return { content };
          },
        });
      }
    });
    try {
      // Materialize the registry during activation so the first request sees
      // the registered tools, and fail visibly if the pinned API rejects them.
      const registered = new Set((await ctx.tool.list()).map((tool) => tool.id));
      const names = ["ha_yaml_status", ...Object.keys(METHODS).map((name) => `ha_yaml_${name}`)];
      if (names.some((name) => !registered.has(name))) throw new Error("LSP tool registration is incomplete");
      console.info(`Home Assistant LSP registered tools: ${names.join(", ")}`);
    } catch (error) {
      await registration.dispose();
      throw error;
    }
    return () => registration.dispose();
  };
}

export default Plugin.define({ id: LSP_PLUGIN_ID, setup: createLspSetup() });
