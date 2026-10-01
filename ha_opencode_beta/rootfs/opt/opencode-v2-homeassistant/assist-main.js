import { openSync, fstatSync, readFileSync, closeSync, constants } from "node:fs";
import { OpenCode } from "@opencode/client";
import { acquireStateLock, createIngressSecret, verifyAdministrator } from "../ha-mcp-server/lib/ha-facing-auth.js";
import { openAssistPairing } from "./assist-pairing.js";
import { startAssistHttp } from "./assist-http.js";

async function main() {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) throw new Error("Supervisor unavailable");
  const response = await fetch("http://supervisor/addons/self/info", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  const info = await response.json();
  const hostname = info.data?.hostname;
  if (!response.ok || !/^[A-Za-z0-9-]+$/.test(hostname)) throw new Error("App identity unavailable");
  const fd = openSync("/run/opencode-v2/server-password", constants.O_RDONLY | constants.O_NOFOLLOW);
  let password;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 256) throw new Error("Unsafe server credential");
    password = readFileSync(fd, "utf8").trim();
    if (!password) throw new Error("Missing server credential");
  } finally { closeSync(fd); }
  const client = OpenCode.make({ baseUrl: "http://127.0.0.1:4100", headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
  await client.agent.list();
  const pairing = openAssistPairing("/data/ha-assist");
  const lock = await acquireStateLock("/data/ha-assist");
  try {
    const service = await startAssistHttp({ client, pairing, hostname,
      ingressSecret: createIngressSecret("/run/ha-assist/ingress-secret"), verifyAdmin: (user) => verifyAdministrator(token, user) });
    const close = async () => { await service.close(); await lock.close(); process.exit(0); };
    process.once("SIGTERM", close); process.once("SIGINT", close);
  } catch (error) { await lock.close(); throw error; }
}
main().catch(() => { console.error("OpenCode Assist unavailable; retrying under supervision"); process.exitCode = 1; });
