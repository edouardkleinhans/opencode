import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOKEN = "llm-discovery-fixture-token";
let core, sockets, client, transport, baseUrl, stderr, requests, commands;
let apis, commandError, authRejected, endpointAvailable, version, closeEarly;

beforeEach(async () => {
  apis = [{ id: "assist", name: "Assist" }, { id: "custom", name: "My custom API" }];
  commandError = null;
  authRejected = false;
  closeEarly = false;
  endpointAvailable = true;
  version = "2026.10.0b0";
  requests = []; commands = []; stderr = "";
  core = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, authorized: req.headers.authorization === `Bearer ${TOKEN}` });
    res.setHeader("content-type", "application/json");
    if (req.url === "/config") {
      res.end(JSON.stringify({ version, components: ["llm", "mcp_server"] }));
      return;
    }
    if (req.url.startsWith("/mcp")) {
      let body = "";
      for await (const part of req) body += part;
      const message = JSON.parse(body);
      if (!endpointAvailable) { res.writeHead(404); res.end("MCP Server is not configured"); return; }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: "2025-11-25", capabilities: { tools: {} },
        serverInfo: { name: "home-assistant-fixture", version },
      } }));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
  sockets = new WebSocketServer({ server: core, path: "/core/websocket" });
  sockets.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "auth_required", ha_version: version }));
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.type === "auth") {
        ws.send(JSON.stringify({ type: msg.access_token === TOKEN && !authRejected ? "auth_ok" : "auth_invalid" }));
        return;
      }
      commands.push(msg);
      if (closeEarly) { ws.close(); return; }
      // An unrelated result must not be mistaken for this command's response.
      ws.send(JSON.stringify({ type: "result", id: 999, success: true, result: { apis: [] } }));
      ws.send(JSON.stringify({ type: "result", id: msg.id, success: !commandError,
        ...(commandError ? { error: { code: commandError, message: `withheld ${TOKEN}` } } : { result: { apis } }),
      }));
    });
  });
  await new Promise((resolve) => core.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${core.address().port}`;
});

afterEach(async () => {
  await client?.close();
  client = null;
  await transport?.close();
  transport = null;
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => core.close(resolve));
});

async function connect({ apiId = "custom", bridge = true } = {}) {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url))],
    env: { ...process.env, SUPERVISOR_TOKEN: TOKEN, SUPERVISOR_BASE_URL: baseUrl,
      HA_API_BASE_URL: baseUrl, HA_NATIVE_MCP_API_ID: apiId,
      OPENCODE_MCP_TOOL_PROFILE: "compact", OPENCODE_NATIVE_HA_MCP_ENABLED: String(bridge) },
    stderr: "pipe",
  });
  transport.stderr.on("data", (data) => { stderr += data; });
  client = new Client({ name: "llm-discovery-test", version: "1" });
  await client.connect(transport);
}

async function capabilities() {
  const result = await client.callTool({ name: "get_agent_capabilities", arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(stderr).not.toContain(TOKEN);
  return JSON.parse(result.content[0].text).home_assistant;
}

describe("native API discovery through the shipped MCP server", () => {
  it("authenticates one read-only registry command and refreshes the tool/resource reports", async () => {
    await connect();
    const first = await capabilities();
    expect(first.native_mcp.api_discovery.apis).toEqual(apis);
    expect(first.native_mcp.selected_api).toMatchObject({ status: "registered", id: "custom", name: "My custom API" });
    expect(commands).toEqual([{ id: 1, type: "llm/api/list" }]);
    expect(requests.every(({ authorized }) => authorized)).toBe(true);
    expect(requests.every(({ method, url }) => method === "GET" || url.startsWith("/mcp"))).toBe(true);

    apis = [{ id: "assist", name: "Assist" }];
    const result = await client.readResource({ uri: "ha://agent/capabilities" });
    const refreshed = JSON.parse(result.contents[0].text).home_assistant;
    expect(refreshed.native_mcp.selected_api.status).toBe("unknown_api");
    expect(refreshed.native_mcp.status).toBe("configured_api_unknown");
    expect(refreshed.external_native_llm_api.available_to_opencode).toBe(false);
    expect(refreshed.native_mcp.configured_api_id).toBe("custom");
    expect(commands).toHaveLength(2);
  });

  it("does not equate registered APIs with a working MCP endpoint or enabled bridge", async () => {
    endpointAvailable = false;
    await connect({ bridge: false });
    const result = await capabilities();
    expect(result.native_mcp.selected_api.status).toBe("registered");
    expect(result.external_native_llm_api.available_to_addons).toBe(false);
    expect(result.external_native_llm_api.available_to_opencode).toBe(false);
    expect(result.native_mcp.bridge.status).toBe("disabled");
  });

  it.each(["unknown_command", "unauthorized"])("keeps MCP readiness usable when discovery returns %s", async (code) => {
    commandError = code;
    version = code === "unknown_command" ? "2026.8.3" : "2026.10.0b0";
    await connect();
    const result = await capabilities();
    expect(result.native_mcp.api_discovery.status).toBe(code === "unknown_command" ? "unsupported" : "unauthorized");
    expect(result.native_mcp.selected_api.status).toBe("not_checked");
    expect(result.native_mcp.configured_endpoint_status).toBe("available");
  });

  it("reports an authentication failure without disclosing the credential", async () => {
    authRejected = true;
    await connect();
    expect((await capabilities()).native_mcp.api_discovery.status).toBe("unauthorized");
    expect(commands).toEqual([]);
  });

  it("reports a dropped websocket rather than a missing API", async () => {
    closeEarly = true;
    await connect();
    const result = await capabilities();
    expect(result.native_mcp.api_discovery.status).toBe("unavailable");
    expect(result.native_mcp.selected_api.status).toBe("not_checked");
  });

  it("keeps an empty API ID as the configured endpoint, without choosing a discovered API", async () => {
    await connect({ apiId: "" });
    const result = await capabilities();
    expect(result.native_mcp.selected_api.status).toBe("configured_endpoint");
    expect(result.native_mcp.configured_api_id).toBeNull();
    expect(result.native_mcp.selected_api.detail).toContain("all registered APIs");
  });
});
