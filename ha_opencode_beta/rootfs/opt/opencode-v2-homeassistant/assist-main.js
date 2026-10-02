import { openSync, fstatSync, readFileSync, closeSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { acquireStateLock, createIngressSecret, verifyAdministrator } from "../ha-mcp-server/lib/ha-facing-auth.js";
import { openAssistPairing } from "./assist-pairing.js";
import { startAssistHttp } from "./assist-http.js";
import { createAssistBootstrap, createAssistDiscovery, runAssistDiscovery } from "./assist-discovery.js";
import { createAssistRestartNotification, runAssistRestartNotification } from "./assist-notification.js";

export async function launchAssist({ stateDirectory = "/data/ha-assist",
  ingressSecretPath = "/run/ha-assist/ingress-secret", supervisorToken, createClient, ...options }) {
  const unlock = await acquireStateLock(stateDirectory);
  try {
    const pairing = openAssistPairing(stateDirectory);
    let discovery;
    const bootstrap = createAssistBootstrap(pairing, { onChange: () => discovery?.refresh() });
    discovery = supervisorToken ? createAssistDiscovery({ token: supervisorToken,
      directory: stateDirectory, hostname: options.hostname, bootstrap }) : undefined;
    const notification = supervisorToken ? createAssistRestartNotification({ token: supervisorToken,
      directory: stateDirectory, hostname: options.hostname, installation: options.installation }) : undefined;
    // Tell HA about the installed code even if backend credentials/readiness
    // subsequently fail. One bounded attempt here; background retries below.
    try { await notification?.notify(); }
    catch { console.error("OpenCode Assist restart notification pending; retrying when Home Assistant is available"); }
    const client = createClient ? await createClient() : options.client;
    const service = await startAssistHttp({ ...options, client, pairing, bootstrap, discovery,
      ingressSecret: createIngressSecret(ingressSecretPath) });
    const discoveryStop = new AbortController();
    const publishing = discovery ? runAssistDiscovery(discovery, { signal: discoveryStop.signal }) : Promise.resolve();
    const notifying = runAssistRestartNotification(notification, { signal: discoveryStop.signal });
    let closing;
    let stopping = false;
    const close = () => closing ??= (async () => {
      try {
        discoveryStop.abort();
        try { await Promise.all([publishing, notifying]); } finally { await service.close(); }
      }
      finally {
        process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
        await unlock();
      }
    })();
    const stop = () => {
      if (stopping) return;
      stopping = true;
      // s6 must be able to finish stopping even if the backend is unresponsive.
      const deadline = setTimeout(() => process.exit(1), 10000).unref();
      void close().then(() => { clearTimeout(deadline); process.exit(0); }, () => {
        console.error("OpenCode Assist shutdown failed"); process.exit(1);
      });
    };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    return { ...service, close };
  } catch (error) { await unlock(); throw error; }
}

async function main() {
  const token = process.env.SUPERVISOR_TOKEN;
  if (process.argv[2] === "--withdraw") {
    const unlock = await acquireStateLock("/data/ha-assist");
    try { await runAssistDiscovery(createAssistDiscovery({ token }), { withdraw: true }); }
    finally { await unlock(); }
    return;
  }
  if (!token) throw new Error("Supervisor unavailable");
  const response = await fetch("http://supervisor/addons/self/info", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  const info = await response.json();
  const hostname = info.data?.hostname;
  if (!response.ok || typeof hostname !== "string" || !/^[A-Za-z0-9-]{1,253}$/.test(hostname)) throw new Error("App identity unavailable");
  const installation = JSON.parse(readFileSync("/run/ha-assist-install.json", "utf8"));
  await launchAssist({ hostname, installation, supervisorToken: token, verifyAdmin: (user) => verifyAdministrator(token, user),
    createClient: async () => {
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
      return client;
    } });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("OpenCode Assist unavailable; retrying under supervision"); process.exitCode = 1; });
}
