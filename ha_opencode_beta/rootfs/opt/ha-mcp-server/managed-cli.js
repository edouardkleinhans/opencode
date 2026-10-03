import { constants, openSync, readSync, fstatSync, closeSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const command = process.argv[2];
const client = new Client({ name: "ha-mcp-managed-client", version: "1" });
const controller = new AbortController();
const timeout = setTimeout(() => { controller.abort(); void client.close().catch(() => {}); }, 10000);
try {
  if (!["status", "tools", "test"].includes(command)) throw new Error();
  if (readFileSync("/run/opencode-v2/mcp-enabled", "utf8").trim() !== "true") {
    console.log("Home Assistant MCP integration is disabled in the app configuration");
  } else {
    const fd = openSync("/run/opencode-v2/sidecar-secret", constants.O_RDONLY | constants.O_NOFOLLOW);
    let secret;
    const bytes = Buffer.alloc(65);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.size !== 64 || (info.mode & 0o777) !== 0o600) throw new Error();
      const length = readSync(fd, bytes);
      secret = bytes.subarray(0, length).toString("utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error();
    } finally { closeSync(fd); bytes.fill(0); }
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8765/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` }, redirect: "error", signal: controller.signal },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log(`Home Assistant MCP: connected (${tools.length} advertised tools)`);
    if (command === "tools") for (const tool of tools) console.log(tool.name);
  }
} catch {
  console.error("Could not inspect the managed Home Assistant MCP sidecar; check the app status and logs");
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch { process.exitCode = 1; }
  clearTimeout(timeout);
}
