import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE = "/run/opencode-v2/workspace";
const RETENTION_MS = 24 * 60 * 60 * 1000;
const PREFIX = ".hab-output-";

// Keep full CLI output out of tool/model context. The workspace is a root-owned
// runtime directory, not the user's HA configuration or the persistent V2 DB.
// Its files are discarded at container restart and aged out on later exports.
export function saveHabOutput(output, format = "json", { workspace = WORKSPACE, now = Date.now() } = {}) {
  if (!["json", "text"].includes(format)) throw new Error("unsupported hab output format");
  const root = lstatSync(workspace);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o022)) {
    throw new Error("unsafe hab output workspace");
  }

  for (const name of readdirSync(workspace)) {
    if (!/^\.hab-output-[A-Za-z0-9]{6}$/.test(name)) continue;
    const path = join(workspace, name);
    const info = lstatSync(path);
    if (info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077)
        && now - info.mtimeMs > RETENTION_MS) {
      rmSync(path, { recursive: true, force: true });
    }
  }

  const directory = mkdtempSync(join(workspace, PREFIX));
  chmodSync(directory, 0o700);
  const path = join(directory, `output.${format === "json" ? "json" : "txt"}`);
  try {
    writeFileSync(path, output, { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return path;
}
