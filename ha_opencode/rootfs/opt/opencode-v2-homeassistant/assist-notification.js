import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, lstatSync, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, constants } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Called under the Assist worker's state lock. Keep a durable delivery receipt,
// not a persistent "restart pending" flag: Core owns the notification lifecycle
// and clears it on restart. An ordinary app restart must not recreate it.
export function createAssistRestartNotification({ token, directory = "/data/ha-assist", hostname, installation,
  coreUrl = "http://supervisor/core/api", fetchImpl = fetch }) {
  if (!installation || !["installed", "updated", "unchanged"].includes(installation.action)) return;
  if (typeof installation.version !== "string" || !/^\d+\.\d+\.\d+(?:b\d+)?$/.test(installation.version) ||
      typeof installation.installed_at !== "string" || installation.installed_at.length > 64 || !Number.isFinite(Date.parse(installation.installed_at)) ||
      typeof hostname !== "string" || !/^[A-Za-z0-9-]{1,253}$/.test(hostname)) throw new Error("invalid_installation_notification");
  const identity = createHash("sha256").update(JSON.stringify([installation.version, installation.installed_at])).digest("hex");
  const path = join(directory, "restart-notification.json");
  function delivered() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("unsafe_notification_state");
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== stat.uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 1024) throw new Error("unsafe_notification_state");
      const saved = JSON.parse(readFileSync(fd, "utf8"));
      if (saved?.version !== 1 || typeof saved.installation !== "string" || !/^[a-f0-9]{64}$/.test(saved.installation)) throw new Error("invalid_notification_state");
      return saved.installation === identity;
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function saveReceipt() {
    const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, installation: identity })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temp, path);
      const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
  return {
    async notify(signal) {
      if (delivered()) return;
      if (!token) throw new Error("supervisor_unavailable");
      const response = await fetchImpl(`${coreUrl}/services/persistent_notification/create`, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        body: JSON.stringify({
          notification_id: `opencode_assist_restart_${hostname}`,
          title: "OpenCode Assist updated — restart Home Assistant",
          message: `OpenCode Beta installed **OpenCode Assist ${installation.version}** at ${installation.installed_at}.\n\n` +
            "**Restart Home Assistant Core** to load the companion before setting it up or using Assist. Restarting only the OpenCode app is not sufficient.\n\n" +
            "Open [Settings](/config/dashboard) and use Home Assistant's restart controls when convenient; restarting temporarily interrupts automations and Assist.\n\n" +
            "If you have already restarted Core since this installation, dismiss this reminder.",
        }),
      });
      if (response.status !== 200 || !Array.isArray(await response.json())) throw new Error("notification_unavailable");
      // Same ID replaces a prior notice if a response was lost or the companion
      // changed again. A receipt is saved only after Core accepted the notice.
      saveReceipt();
    },
  };
}

export async function runAssistRestartNotification(notification, { signal, wait = sleep } = {}) {
  if (!notification) return;
  let delay = 1000;
  while (!signal?.aborted) {
    try { await notification.notify(signal); return; }
    catch {
      if (signal?.aborted) return;
      console.error("OpenCode Assist restart notification unavailable; retrying with Home Assistant");
    }
    try { await wait(delay, undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
    delay = Math.min(delay * 2, 60000);
  }
}
