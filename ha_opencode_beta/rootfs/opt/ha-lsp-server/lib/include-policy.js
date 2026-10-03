import * as fs from "node:fs";
import { posix } from "node:path";

const WORKSPACE = "/homeassistant";
// Linux UAPI O_PATH (not exposed by every Node release). Metadata handles never
// invoke a device's read-open handler and do not require opening file contents.
const O_PATH = fs.constants.O_PATH ?? 0o10000000;

function allowedPath(path, root) {
  if (!path.startsWith(`${root}/`)) return false;
  return !path.slice(root.length + 1).split("/").some((part) => {
    const name = part.toLowerCase();
    return name.startsWith(".") || name === "ssl" || /^secrets\.ya?ml$/.test(name) ||
      /\.(?:key|pem|p12|pfx|crt|cer)$/.test(name) || /^home-assistant(?:_v2)?\.(?:db|log)(?:[.-]|$)/.test(name);
  });
}

// Lexical rejection comes BEFORE filesystem access, including for missing paths.
// A draft must never turn diagnostics or definition into a sensitive-file oracle.
export function resolveIncludeTarget(documentUri, includePath, root = WORKSPACE) {
  if (typeof includePath !== "string" || !includePath || /[\\\x00-\x1f]/.test(includePath)) return null;
  try {
    const uri = new URL(documentUri);
    if (uri.protocol !== "file:" || uri.hostname || uri.search || uri.hash) return null;
    const document = decodeURIComponent(uri.pathname);
    if (/[\\\x00-\x1f]/.test(document) || !allowedPath(posix.resolve(document), root)) return null;
    const target = posix.resolve(posix.dirname(document), includePath);
    return allowedPath(target, root) ? target : null;
  } catch {
    return null;
  }
}

export function inspectAnchoredTarget(target, root = WORKSPACE, { io = fs, platform = process.platform } = {}) {
  if (!allowedPath(target, root)) return "blocked";
  // The app runs on Linux. Never silently substitute a symlink-following check
  // on another platform; tests of this boundary require Linux as well.
  if (platform !== "linux") throw new Error("Anchored include checks require Linux");
  const handles = [];
  let parent;
  try {
    parent = io.openSync(root, O_PATH | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    handles.push(parent);
    const parts = target.slice(root.length + 1).split("/");
    for (const part of parts.slice(0, -1)) {
      parent = io.openSync(`/proc/self/fd/${parent}/${part}`, O_PATH | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      handles.push(parent);
    }
    const leaf = io.openSync(`/proc/self/fd/${parent}/${parts.at(-1)}`, O_PATH | fs.constants.O_NOFOLLOW);
    handles.push(leaf);
    const info = io.fstatSync(leaf);
    return info.isFile() || info.isDirectory() ? "exists" : "blocked";
  } catch (error) {
    // ENOENT must describe the requested target, not a missing workspace/procfs.
    // Verify that the still-open parent is reachable through the procfs anchor
    // before classifying a target lookup failure as missing or denied.
    if (parent === undefined) throw new Error("Include workspace anchor is unavailable");
    try {
      const actual = io.fstatSync(parent);
      const anchor = io.statSync(`/proc/self/fd/${parent}`);
      if (!anchor.isDirectory() || actual.dev !== anchor.dev || actual.ino !== anchor.ino) throw new Error();
    } catch {
      throw new Error("Include metadata anchor is unavailable");
    }
    if (error.code === "ENOENT") return "missing";
    if (["ELOOP", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return "blocked";
    throw new Error("Include metadata check is unavailable");
  } finally {
    for (const fd of handles.reverse()) io.closeSync(fd);
  }
}

export function inspectInclude(documentUri, includePath, { root = WORKSPACE, inspect = inspectAnchoredTarget } = {}) {
  const target = resolveIncludeTarget(documentUri, includePath, root);
  if (!target) return { status: "blocked" };
  const status = inspect(target, root);
  return status === "exists" ? { status, path: target } : { status };
}
