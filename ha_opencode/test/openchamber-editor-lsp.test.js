import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { registerEditorLspRoutes, sameOrigin } from '../rootfs/opt/openchamber/editor-lsp/routes.mjs';
import { documentPath } from '../rootfs/opt/opencode-v2-homeassistant/lsp-client.js';
import { DraftSession, eligiblePath, diagnosticsFor, completionsFor } from '../rootfs/opt/openchamber/editor-lsp/editor-core.mjs';

const require = createRequire(process.env.HA_EDITOR_TEST_DEPS
  ? resolve(process.env.HA_EDITOR_TEST_DEPS, 'package.json')
  : new URL('../rootfs/opt/ha-mcp-server/package.json', import.meta.url));
const express = require('express');
const draft = { path: '/homeassistant/draft.yaml', text: 'entity_id: light.test', editorId: 'editor-1', version: 3 };
async function fixture(t, requestLsp, options = {}) {
  const app = express();
  let authorized = true;
  app.use('/api', (_req, res, next) => authorized ? next() : res.status(401).end());
  registerEditorLspRoutes(app, { express, loadClient: async () => ({ documentPath, requestLsp }), ...options });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { origin, deny: () => { authorized = false; },
    post: (body = draft, kind = 'diagnostics', headers = {}, signal) => fetch(`${origin}/api/ha-editor-lsp/${kind}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body), signal,
    }),
  };
}

test('editor bridge sends the unsaved draft only and echoes its identity', async (t) => {
  const calls = [];
  const f = await fixture(t, async (...args) => { calls.push(args); return { items: [] }; });
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { path: draft.path, editorId: draft.editorId, version: 3, items: [], truncated: false });
  assert.equal(calls[0][0], 'textDocument/diagnostic');
  assert.deepEqual(calls[0][1], { path: draft.path, text: draft.text });
  const completion = await f.post({ ...draft, text: '😀 light.te', position: { line: 0, character: 11 } }, 'completions');
  assert.equal(completion.status, 200);
  assert.equal(calls[1][0], 'textDocument/completion');
  assert.deepEqual(calls[1][2], { line: 0, character: 11 });
  f.deny();
  assert.equal((await f.post()).status, 401);
  assert.equal(calls.length, 2);
});

test('editor bridge rejects paths, injected settings, missing drafts, invalid versions and positions before dispatch', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return []; });
  for (const path of ['/etc/passwd', '../outside.yaml', '/homeassistant2/file.yaml', 'secrets.yml', 'nested/secrets.yaml', '.storage/x.yaml', '.cloud/x.yml', 'ssl/key.yml', 'file.json', 'foo\\file.yaml', 'foo\0.yaml']) {
    assert.equal((await f.post({ ...draft, path })).status, 403, path);
  }
  for (const body of [null, [], {}, { ...draft, text: undefined }, { ...draft, text: null }, { ...draft, method: 'shutdown' },
    { ...draft, socketPath: '/tmp/x' }, { ...draft, uri: 'file:///etc/passwd' }, { ...draft, version: -1 },
    { ...draft, version: 1.1 }, { ...draft, version: Number.MAX_SAFE_INTEGER + 1 }, { ...draft, editorId: '' },
    { ...draft, editorId: 'x'.repeat(81) }, { ...draft, position: {} }]) {
    assert.equal((await f.post(body)).status, 400, JSON.stringify(body));
  }
  for (const position of [undefined, {}, { line: 0, character: -1 }, { line: 1, character: 0 },
    { line: 0, character: 22 }, { line: 0.5, character: 1 }, { line: 0, character: 1, method: 'x' }]) {
    assert.equal((await f.post({ ...draft, position }, 'completions')).status, 400, JSON.stringify(position));
  }
  assert.equal((await f.post(draft, 'definition')).status, 404);
  assert.equal(calls, 0);
});

test('JSON and UTF-8 limits are enforced for fixed-length and chunked requests', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return []; });
  assert.equal((await f.post({ ...draft, text: 'é'.repeat(512 * 1024 + 1) })).status, 413);
  assert.equal((await f.post({ ...draft, text: 'a'.repeat(2 * 1024 * 1024) })).status, 413);
  assert.equal((await f.post('{broken')).status, 400);
  assert.equal((await f.post(draft, 'diagnostics', { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await f.post(draft, 'diagnostics', { 'content-encoding': 'gzip' })).status, 400);
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(`${f.origin}/api/ha-editor-lsp/diagnostics`, {
      method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' },
    }, (res) => { res.resume(); res.once('end', () => resolve(res)); });
    req.on('error', reject);
    req.write('{"text":"');
    req.write('a'.repeat(2 * 1024 * 1024));
    req.end('"}');
  });
  assert.equal(response.statusCode, 413);
  assert.equal(calls, 0);
  assert.equal((await f.post({ ...draft, text: 'a'.repeat(1024 * 1024) })).status, 200);
});

test('origin policy ignores forwarding claims and rejects non-browser/cross-origin requests', async (t) => {
  const f = await fixture(t, async () => []);
  for (const headers of [{ origin: '' }, { origin: 'null' }, { origin: 'https://evil.example' },
    { origin: f.origin, 'sec-fetch-site': 'cross-site' },
    { origin: 'https://ha.example', 'x-forwarded-host': 'ha.example', 'x-forwarded-proto': 'https' }]) {
    assert.equal((await f.post(draft, 'diagnostics', headers)).status, 403);
  }
  assert.equal(sameOrigin({ headers: { origin: 'http://ha.example', host: 'ha.example' }, socket: { encrypted: true } }), false);
  assert.equal(sameOrigin({ headers: { origin: 'http://ha.example/path', host: 'ha.example' }, socket: {} }), false);
  assert.equal((await f.post(draft, 'diagnostics', { 'sec-fetch-site': 'same-origin' })).status, 200);
});

test('result count and byte bounds; failures are sanitized, never clean diagnostics', async (t) => {
  let result = Array.from({ length: 130 }, (_, index) => ({ label: String(index) }));
  const f = await fixture(t, async () => { if (result instanceof Error) throw result; return result; });
  const body = await (await f.post()).json();
  assert.equal(body.items.length, 100);
  assert.equal(body.truncated, true);
  for (const invalid of [null, undefined, { kind: 'unchanged' }, new Error('/secret/path token=private'), [{ message: 'x'.repeat(256 * 1024) }]]) {
    result = invalid;
    const response = await f.post();
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.doesNotMatch(text, /token|private|secret|items/);
  }
});

test('at most two socket calls globally; cancellation releases capacity across routers', async (t) => {
  let active = 0;
  let peak = 0;
  const wait = (_method, _document, _position, signal) => new Promise((_resolve, reject) => {
    active++;
    peak = Math.max(peak, active);
    signal.addEventListener('abort', () => { active--; reject(new Error('cancelled')); }, { once: true });
  });
  const a = await fixture(t, wait);
  const b = await fixture(t, wait);
  const abortA = new AbortController();
  const abortB = new AbortController();
  const first = a.post(draft, 'diagnostics', {}, abortA.signal).catch(() => {});
  const second = b.post(draft, 'diagnostics', {}, abortB.signal).catch(() => {});
  for (let n = 0; active < 2 && n < 100; n++) await delay(5);
  assert.equal(active, 2);
  assert.equal((await a.post()).status, 429);
  abortA.abort(); abortB.abort();
  await Promise.all([first, second]);
  for (let n = 0; active && n < 100; n++) await delay(5);
  assert.equal(active, 0);
  assert.equal(peak, 2);
});

test('deadline aborts a pending LSP call and returns sanitized 504', async (t) => {
  let aborted = false;
  const f = await fixture(t, (_method, _doc, _pos, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('private timeout')); }, { once: true });
  }), { timeoutMs: 25 });
  const response = await f.post();
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.doesNotMatch(await response.text(), /private/);
});

function doc(text) {
  const lines = text.split('\n');
  return { lines: lines.length, line: (number) => ({ from: lines.slice(0, number - 1).reduce((sum, line) => sum + line.length + 1, 0), length: lines[number - 1].length }) };
}
test('editor adapters use UTF-16 ranges, full dotted tokens and conservative completion edits', () => {
  const text = doc('😀 light.te\nnext');
  assert.deepEqual(diagnosticsFor(text, [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 11 } }, message: 'Unknown', severity: 2 }]),
    [{ from: 3, to: 11, message: 'Unknown', severity: 'warning', source: 'Home Assistant' }]);
  assert.equal(diagnosticsFor(text, [{ range: { start: { line: 2, character: 0 } }, message: 'bad' }, null]).length, 0);
  const range = { start: { line: 0, character: 3 }, end: { line: 0, character: 11 } };
  const items = [{ label: 'light.test', textEdit: { range, newText: 'light.test' } },
    { label: 'snippet', insertTextFormat: 2 }, { label: 'command', command: {} },
    { label: 'extra', additionalTextEdits: [{}] }, { label: 'replace', textEdit: { insert: range, replace: range, newText: 'x' } },
    { label: 'outside', textEdit: { range: { ...range, start: { line: 0, character: 0 } }, newText: 'x' } }];
  assert.deepEqual(completionsFor(text, items, 3, 11), [{ label: 'light.test', apply: 'light.test' }]);
  assert.equal(eligiblePath('/homeassistant/automations.yaml'), true);
  for (const path of ['/homeassistant/secrets.yml', '/homeassistant/.storage/x.yaml', '/homeassistant/../x.yaml', '/tmp/x.yaml']) assert.equal(eligiblePath(path), false);
});

test('per-editor lifecycle rejects stale edit-undo, different view/file and destroyed responses', () => {
  const session = new DraftSession(draft.path, draft.editorId);
  const first = session.begin('diagnostics', 'a');
  assert.equal(first.current(first.body), true);
  session.changed(); // a -> b
  session.changed(); // b -> a (same text must still be stale)
  assert.equal(first.signal.aborted, true);
  assert.equal(first.current(first.body), false);
  const next = session.begin('diagnostics', 'a');
  const completion = session.begin('completions', 'a');
  assert.equal(next.current({ ...next.body, editorId: 'different' }), false);
  assert.equal(next.current({ ...next.body, path: '/homeassistant/other.yaml' }), false);
  assert.equal(next.current(next.body), true);
  session.destroy();
  assert.equal(next.signal.aborted, true);
  assert.equal(completion.signal.aborted, true);
  assert.equal(next.current(next.body), false);
});
