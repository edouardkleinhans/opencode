// Hand-authored protocol fixture, not a live HA capture. Shapes follow
// home-assistant/core@2026.10.0b0 components/mcp_server/server.py.
export const contextUri = "homeassistant://assist/context-snapshot";
export const tools = [
  {
    name: "homeassistant__GetLiveContext", title: "Get live context",
    description: "Get the current exposed home context.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "light__FixtureSet", title: "Set fixture light",
    description: "Synthetic tool: the fixture always returns an error.",
    inputSchema: {
      type: "object", properties: {
        name: { type: "string" }, brightness: { type: "integer", minimum: 0, maximum: 100 },
      }, required: ["name", "brightness"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

export function nativeResult(message, { snapshot = "fixture snapshot one", promptName = "Assist" } = {}) {
  const { id, method, params } = message;
  if (id === undefined) return null;
  let result;
  switch (method) {
    case "initialize":
      result = { protocolVersion: "2025-11-25", serverInfo: { name: "home-assistant", version: "2026.10.0b0" },
        capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: "upstream fixture instructions" };
      break;
    case "tools/list": result = { tools }; break;
    case "prompts/list": result = { prompts: [{ name: promptName, description: "Selected HA API prompt" }] }; break;
    case "prompts/get":
      if (params.name !== promptName) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown prompt" } };
      result = { messages: [{ role: "assistant", content: { type: "text", text: `selected API prompt: ${promptName}` } }] };
      break;
    case "resources/list":
      result = { resources: [{ name: "assist_context_snapshot", title: "Assist context snapshot", uri: contextUri, mimeType: "text/plain" }] };
      break;
    case "resources/templates/list": result = { resourceTemplates: [] }; break;
    case "resources/read":
      if (params.uri !== contextUri) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown resource" } };
      result = { contents: [{ uri: contextUri, mimeType: "text/plain", text: snapshot }] };
      break;
    case "tools/call":
      result = params.name === tools[0].name
        ? { content: [{ type: "text", text: JSON.stringify({ result: snapshot }) }], isError: false }
        : { content: [{ type: "text", text: JSON.stringify({ error: "fixture denied" }) }], isError: true };
      break;
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  }
  return { jsonrpc: "2.0", id, result };
}
