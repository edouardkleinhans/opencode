import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, lstatSync, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, constants } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { equal } from "../ha-mcp-server/lib/ha-facing-auth.js";

const opaque = () => randomBytes(32).toString("base64url");
const digest = (key) => createHash("sha256").update(key).digest("hex");
const validKey = (key) => typeof key === "string" && /^[A-Za-z0-9_-]{43}$/.test(key);

// Supervisor stores discovery config, so advertise only an expiring bootstrap,
// never the durable pairing key. HA generates that key after user confirmation.
export function createAssistBootstrap(pairing, { now = Date.now, onChange = () => {} } = {}) {
  let tickets = [];
  function current() {
    tickets = tickets.filter((ticket) => ticket.expires > now());
    if (!tickets[0] || tickets[0].claimed || tickets[0].expires - now() < 120000) {
      tickets.unshift({ token: opaque(), expires: now() + 600000 });
      tickets = tickets.slice(0, 2);
    }
    return { bootstrap: tickets[0].token, expires_at: tickets[0].expires };
  }
  function authorize(header) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || "")?.[1];
    const ticket = tickets.find((entry) => entry.expires > now() && equal(entry.token, token));
    if (!ticket) throw new Error("bootstrap_expired");
    return ticket;
  }
  return {
    current,
    authorize,
    pair(header, key) {
      const ticket = authorize(header);
      if (!validKey(key)) throw new Error("invalid_pairing_key");
      // A lost response can retry only the identical credential, never rotate a
      // pairing twice with a consumed bootstrap or resurrect a revoked key.
      if (ticket.claimed) {
        if (ticket.claimed !== digest(key) || !pairing.authenticate(`Bearer ${key}`)) throw new Error("bootstrap_consumed");
        return;
      }
      pairing.provision(key);
      ticket.claimed = digest(key);
      tickets = [ticket];
      onChange();
    },
    invalidate() { tickets = []; onChange(); },
  };
}

export function createAssistDiscovery({ token, directory = "/data/ha-assist", hostname, bootstrap,
  supervisorUrl = "http://supervisor/discovery", fetchImpl = fetch }) {
  const path = join(directory, "discovery.json");
  let published = false;
  let changed = false;
  let wake;
  function state() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("unsafe_discovery_state");
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== stat.uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > 1024) throw new Error("unsafe_discovery_state");
      const data = JSON.parse(readFileSync(fd, "utf8"));
      if (typeof data?.uuid !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.uuid)) throw new Error("invalid_discovery_state");
      return data.uuid;
    } catch (error) { if (error.code === "ENOENT") return; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function syncDirectory() {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  async function request(url, options, signal) {
    if (!token) throw new Error("supervisor_unavailable");
    const response = await fetchImpl(url, { ...options, redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (options.method === "DELETE" && response.status === 404) return;
    if (!response.ok) throw new Error("discovery_unavailable");
    const body = await response.json();
    if (body.result !== "ok") throw new Error("discovery_unavailable");
    return body.data;
  }
  return {
    get published() { return published; },
    refresh() { changed = true; wake?.(); },
    async pause(delay, signal, wait) {
      if (changed) { changed = false; return; }
      const stop = new AbortController();
      const abort = () => stop.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) return;
        await Promise.race([wait(delay, undefined, { signal: stop.signal }), new Promise((resolve) => { wake = resolve; })]);
      } finally { stop.abort(); signal?.removeEventListener("abort", abort); wake = undefined; changed = false; }
    },
    async tick(signal) {
      published = false;
      state();
      if (typeof hostname !== "string" || !/^[A-Za-z0-9-]{1,253}$/.test(hostname)) throw new Error("invalid_app_identity");
      const data = await request(supervisorUrl, { method: "POST", body: JSON.stringify({ service: "opencode_assist",
        config: { version: 1, url: `http://${hostname}:8768`, ...bootstrap.current() } }) }, signal);
      if (typeof data?.uuid !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.uuid)) throw new Error("invalid_discovery_response");
      const temp = `${path}.${opaque()}.tmp`;
      try {
        const fd = openSync(temp, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify({ uuid: data.uuid })); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, path); syncDirectory();
      } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      published = true;
    },
    async withdraw(signal) {
      const uuid = state();
      if (uuid) {
        await request(`${supervisorUrl}/${encodeURIComponent(uuid)}`, { method: "DELETE" }, signal);
        unlinkSync(path); syncDirectory();
      }
      published = false;
    },
  };
}

export async function runAssistDiscovery(discovery, { signal, withdraw = false, wait = sleep } = {}) {
  let retry = 1000;
  while (!signal?.aborted) {
    let delay = 60000;
    try {
      if (withdraw) { await discovery.withdraw(signal); return; }
      await discovery.tick(signal);
      retry = 1000;
    } catch {
      if (!signal?.aborted) console.error("OpenCode Assist discovery unavailable; retrying with Supervisor");
      delay = retry; retry = Math.min(retry * 2, 60000);
    }
    try { await discovery.pause(delay, signal, wait); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
}
