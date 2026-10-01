import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, lstatSync, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, constants } from "node:fs";
import { join } from "node:path";

const opaque = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => typeof a === "string" && typeof b === "string" && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));

// A separate root-owned store, never the MCP OAuth store. Only a digest is
// persisted. Replacing the one pairing revokes the previous credential.
export function openAssistPairing(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error("Unsafe Assist state directory");
  const path = join(directory, "pairing.json");
  let data = null;
  let healthy = true;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || (file.mode & 0o777) !== 0o600 || file.nlink !== 1 || file.uid !== stat.uid || file.size > 1024) throw new Error("Unsafe Assist state");
      data = JSON.parse(readFileSync(fd, "utf8"));
      if (data !== null && (data.version !== 1 || !/^[a-f0-9]{64}$/.test(data.hash) || !/^[A-Za-z0-9_-]{43}$/.test(data.id))) throw new Error("Invalid Assist state");
    } finally { closeSync(fd); }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  function save(value) {
    if (!healthy) throw new Error("Assist state unavailable");
    try {
      const temp = `${path}.${opaque()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      const dir = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      data = value;
    } catch (error) { healthy = false; throw error; }
  }
  return {
    get owner() { return data?.id; },
    authenticate(header) {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || "")?.[1];
      return healthy && data && token && equal(digest(token), data.hash) ? data.id : null;
    },
    provision() {
      const token = opaque();
      save({ version: 1, id: opaque(), hash: digest(token) });
      return token;
    },
    revoke() { save(null); },
  };
}
