// Pure adapters shared by the CodeMirror extension and its policy tests.
export function eligiblePath(path) {
  return typeof path === "string" && path.startsWith("/homeassistant/") && /\.ya?ml$/.test(path)
    && !path.includes("\\") && !path.includes("\0")
    && !path.split("/").some((part) => ["..", ".", ".storage", ".cloud", "ssl", "secrets.yaml", "secrets.yml"].includes(part));
}

export function offsetAt(doc, position) {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)
      || position.line < 0 || position.line >= doc.lines || position.character < 0) return null;
  const line = doc.line(position.line + 1);
  return position.character <= line.length ? line.from + position.character : null;
}

export function diagnosticsFor(doc, items) {
  return items.slice(0, 100).flatMap((item) => {
    const from = offsetAt(doc, item?.range?.start);
    const to = offsetAt(doc, item?.range?.end);
    if (from === null || to === null || to < from || typeof item.message !== "string") return [];
    return [{ from, to, message: item.message.slice(0, 8192),
      severity: item.severity === 1 ? "error" : item.severity === 2 ? "warning" : "info", source: "Home Assistant" }];
  });
}

export function completionsFor(doc, items, from, cursor) {
  return items.slice(0, 100).flatMap((item) => {
    if (!item || typeof item.label !== "string" || item.insertTextFormat === 2
        || item.command || item.additionalTextEdits?.length || item.textEdit?.insert || item.textEdit?.replace) return [];
    let insert = item.insertText ?? item.label;
    if (item.textEdit) {
      // A single exact token replacement only; never apply an arbitrary edit.
      if (offsetAt(doc, item.textEdit.range?.start) !== from || offsetAt(doc, item.textEdit.range?.end) !== cursor) return [];
      insert = item.textEdit.newText;
    }
    if (typeof insert !== "string" || insert.length > 8192 || item.label.length > 1024) return [];
    return [{ label: item.label, apply: insert,
      ...(typeof item.detail === "string" ? { detail: item.detail.slice(0, 1024) } : {}) }];
  });
}

export class DraftSession {
  constructor(path, editorId) {
    this.path = path;
    this.editorId = editorId;
    this.version = 0;
    this.closed = false;
    this.requests = new Map();
  }
  cancel(kind) {
    this.requests.get(kind)?.abort();
    this.requests.delete(kind);
  }
  changed() {
    this.version++;
    for (const kind of this.requests.keys()) this.cancel(kind);
  }
  destroy() { this.changed(); this.closed = true; }
  begin(kind, text, position) {
    this.cancel(kind);
    const controller = new AbortController();
    if (this.closed) controller.abort();
    this.requests.set(kind, controller);
    const body = { path: this.path, editorId: this.editorId, version: this.version, text, ...(position ? { position } : {}) };
    return { body, signal: controller.signal, abort: () => controller.abort(),
      current: (reply) => !this.closed && !controller.signal.aborted && this.version === body.version
        && reply?.editorId === body.editorId && reply?.version === body.version && reply?.path === body.path };
  }
}
