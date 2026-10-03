import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, showPanel, type ViewUpdate } from '@codemirror/view';
import { autocompletion, completionStatus, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { DraftSession, eligiblePath, diagnosticsFor, completionsFor } from './editor-core.mjs';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Reply = { path: string; editorId: string; version: number; items: unknown[]; truncated: boolean };
const MAX_TEXT = 1024 * 1024;

export function createHaEditorLsp(path: string, fetcher: Fetcher): Extension {
  if (!eligiblePath(path)) return [];
  const statusEffect = StateEffect.define<string>();
  const status = StateField.define<string>({
    create: () => 'HA YAML: waiting',
    update: (value, transaction) => {
      for (const effect of transaction.effects) if (effect.is(statusEffect)) value = effect.value;
      return value;
    },
  });
  const panel = showPanel.from(status, (message) => () => {
    const dom = document.createElement('div');
    dom.className = 'cm-ha-lsp-status';
    dom.setAttribute('role', 'status');
    dom.textContent = message;
    return { dom, top: false };
  });

  async function query(kind: string, request: ReturnType<DraftSession['begin']>): Promise<Reply> {
    const response = await fetcher(`/api/ha-editor-lsp/${kind}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), signal: request.signal,
    });
    if (!response.ok) throw new Error('HA YAML unavailable');
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 256 * 1024) throw new Error('HA YAML response too large');
    const reply = JSON.parse(text) as Reply;
    if (!Array.isArray(reply.items) || reply.items.length > 100) throw new Error('Invalid HA YAML response');
    return reply;
  }

  const lifecycle = ViewPlugin.fromClass(class {
    // getRandomValues also works on HTTP LAN origins where randomUUID is absent.
    session = new DraftSession(path, Array.from(crypto.getRandomValues(new Uint32Array(4)), (word) => word.toString(16).padStart(8, '0')).join(''));
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) { this.schedule(); }
    writable() { return !this.view.state.facet(EditorState.readOnly) && this.view.state.facet(EditorView.editable); }
    schedule() {
      clearTimeout(this.timer);
      if (this.writable()) this.timer = setTimeout(() => void this.diagnose(), 850);
    }
    update(update: ViewUpdate) {
      // CodeMirror can close its UI without aborting an outstanding source.
      if (completionStatus(update.startState) && !completionStatus(update.state)) this.session.cancel('completions');
      if (update.docChanged || update.startState.facet(EditorState.readOnly) !== update.state.facet(EditorState.readOnly)
          || update.startState.facet(EditorView.editable) !== update.state.facet(EditorView.editable)) {
        this.session.changed();
        this.schedule();
        // Dispatch cannot be nested in ViewPlugin.update. The next microtask
        // removes obsolete marks, including edit-undo drafts with equal text.
        const version = this.session.version;
        queueMicrotask(() => {
          if (!this.session.closed && this.session.version === version) {
            this.view.dispatch(setDiagnostics(this.view.state, []));
            this.view.dispatch({ effects: statusEffect.of(this.writable() ? 'HA YAML: waiting' : 'HA YAML: read-only') });
          }
        });
      }
    }
    async diagnose() {
      if (!this.writable() || this.session.closed) return;
      const text = this.view.state.doc.toString();
      if (new TextEncoder().encode(text).length > MAX_TEXT) {
        this.view.dispatch({ effects: statusEffect.of('HA YAML: document exceeds 1 MiB') });
        return;
      }
      const request = this.session.begin('diagnostics', text);
      this.view.dispatch({ effects: statusEffect.of('HA YAML: checking…') });
      try {
        const reply = await query('diagnostics', request);
        if (!request.current(reply)) return;
        this.view.dispatch(setDiagnostics(this.view.state, diagnosticsFor(this.view.state.doc, reply.items)));
        this.view.dispatch({ effects: statusEffect.of(reply.truncated ? 'HA YAML: first 100 diagnostics' : 'HA YAML: checked') });
      } catch {
        if (!request.signal.aborted && !this.session.closed) this.view.dispatch({ effects: statusEffect.of('HA YAML: unavailable — retry by editing') });
      }
    }
    destroy() { clearTimeout(this.timer); this.session.destroy(); }
  });

  const source = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const plugin = context.view?.plugin(lifecycle);
    if (!plugin || !plugin.writable()) return null;
    const token = context.matchBefore(/[\w.-]*/);
    if (!token || (!context.explicit && token.from === token.to)) return null;
    const text = context.state.doc.toString();
    if (new TextEncoder().encode(text).length > MAX_TEXT) return null;
    const line = context.state.doc.lineAt(context.pos);
    const request = plugin.session.begin('completions', text, { line: line.number - 1, character: context.pos - line.from });
    context.addEventListener('abort', request.abort, { onDocChange: true });
    if (context.aborted) { request.abort(); return null; }
    try {
      const reply = await query('completions', request);
      if (context.aborted || !request.current(reply)) return null;
      return { from: token.from, to: context.pos,
        options: completionsFor(context.state.doc, reply.items, token.from, context.pos) };
    } catch { return null; }
  };
  return [status, panel, lifecycle, lintGutter(), autocompletion({ override: [source], activateOnTypingDelay: 250 }),
    EditorView.baseTheme({ '.cm-ha-lsp-status': { fontSize: '11px', padding: '2px 8px', opacity: '0.75' } })];
}
