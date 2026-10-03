const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { validEditorIngressOrigin } = require("../rootfs/usr/local/bin/editor-ingress-origin.js");
const ingress = "/api/hassio_ingress/fixture_123";

test("editor Ingress accepts matching HTTP/HTTPS authorities without trusting forwarding claims", () => {
  for (const origin of ["http://ha.example:8123", "https://ha.example", "http://[::1]:8123"]) {
    assert.equal(validEditorIngressOrigin({ origin, host: new URL(origin).host, "sec-fetch-site": "same-origin",
      "x-forwarded-host": "evil.example", "x-forwarded-proto": "invalid" }, ingress, false), true);
  }
});

test("editor Ingress rejects cross-site, ambiguous, missing and LAN authority", () => {
  const good = { origin: "https://ha.example", host: "ha.example", "sec-fetch-site": "same-origin" };
  for (const headers of [
    { ...good, origin: "https://evil.example", "x-forwarded-host": "evil.example" },
    { ...good, "sec-fetch-site": "cross-site" }, { ...good, "sec-fetch-site": "same-site" },
    { ...good, "sec-fetch-site": undefined }, { ...good, "sec-fetch-site": "" },
    { ...good, origin: "null" }, { ...good, origin: undefined },
    { ...good, origin: "https://ha.example/" }, { ...good, origin: [good.origin] },
    { ...good, host: "ha.example/" }, { ...good, host: "evil.example@ha.example" },
    { ...good, host: "ha.example,evil.example" }, { ...good, host: "ha.example\n" },
  ]) assert.equal(validEditorIngressOrigin(headers, ingress, false), false);
  assert.equal(validEditorIngressOrigin(good, ingress, true), false);
  assert.equal(validEditorIngressOrigin(good, "", false), false);
  assert.equal(validEditorIngressOrigin(good, "/api/hassio_ingress/token/extra", false), false);
});

test("real proxy normalizes only validated editor requests and preserves backend origin enforcement", { timeout: 10000 }, async (t) => {
  const { sameOrigin } = await import(pathToFileURL(path.join(__dirname, "../rootfs/opt/openchamber/editor-lsp/routes.mjs")));
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin });
    req.resume();
    res.writeHead(sameOrigin(req) ? 200 : 403, { "content-type": "application/json" });
    res.end("{}");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reserve = http.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const proxy = spawn(process.execPath, [path.join(__dirname, "../rootfs/usr/local/bin/openchamber-ingress-proxy.js")], {
    env: { ...process.env, HA_INGRESS_UI: "openchamber", OPENCHAMBER_INGRESS_HOST: "127.0.0.1",
      OPENCHAMBER_INGRESS_PORT: String(port), OPENCHAMBER_UPSTREAM_HOST: "127.0.0.1",
      OPENCHAMBER_UPSTREAM_PORT: String(upstream.address().port), OPENCHAMBER_ALLOW_ANY_REMOTE: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (proxy.exitCode === null && proxy.signalCode === null) {
      const done = once(proxy, "exit"); proxy.kill(); await done;
    }
  });
  proxy.stderr.resume();
  await once(proxy.stdout, "data");
  const send = (origin, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method: "POST", path: ingress + "/api/ha-editor-lsp/diagnostics",
      headers: { host: "ha.example:8123", origin, "content-type": "application/json", "x-ingress-path": ingress,
        "sec-fetch-site": "same-origin", ...extra } },
    (res) => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.once("error", reject); req.end("{}");
  });
  assert.equal(await send("http://ha.example:8123"), 200);
  assert.equal(await send("https://ha.example:8123"), 200);
  assert.equal(await send("https://evil.example", { "x-forwarded-host": "evil.example" }), 403);
  assert.equal(await send("http://ha.example:8123", { "sec-fetch-site": "cross-site" }), 403);
  assert.equal(seen.length, 2, "Denied requests must not reach OpenChamber");
  for (const headers of seen) assert.deepEqual(headers, {
    host: `127.0.0.1:${upstream.address().port}`, origin: `http://127.0.0.1:${upstream.address().port}`,
  });
});
