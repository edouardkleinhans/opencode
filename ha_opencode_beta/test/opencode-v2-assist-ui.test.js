import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { startAssistUiFixture } from "./helpers/assist-ui-fixture.mjs";

const require = createRequire(import.meta.url);
const { injectAssistSetup } = require("../rootfs/usr/local/bin/assist-setup-ui.js");
const browserPath = process.env.HA_ASSIST_BROWSER_EXECUTABLE || process.env.HA_MCP_BROWSER_EXECUTABLE;
const mcpRequire = createRequire(new URL("../rootfs/opt/ha-mcp-server/package.json", import.meta.url));

test("setup links are session-scoped and excluded outside trusted Ingress", () => {
  const html = '<html><head></head><body>app</body></html>';
  assert.equal(injectAssistSetup(html, "/api/hassio_ingress/test", false), html);
  assert.equal(injectAssistSetup(html, '//evil.example', true), html);
  assert.equal(injectAssistSetup(html, '/api/hassio_ingress/test\" onclick=bad', true), html);
  const output = injectAssistSetup(html, "/api/hassio_ingress/test", true);
  assert.match(output, /target="_self" href="\/api\/hassio_ingress\/test\/ha-assist\/"/);
  assert.equal(injectAssistSetup(output, "/api/hassio_ingress/test", true), output);
});

for (const mode of ["terminal", "openchamber"]) {
  test(`${mode}: proxy serves setup link and protects direct setup access`, async () => {
    const fixture = await startAssistUiFixture(mode);
    try {
      const response = await fetch(fixture.origin + fixture.base + "/");
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /Set up OpenCode Assist/);
      assert.match(html, new RegExp(`href="${fixture.base}/ha-assist/"`));
      assert.doesNotMatch(await (await fetch(`http://127.0.0.1:${fixture.port}/`)).text(), /Set up OpenCode Assist/);
      assert.equal((await fetch(`http://127.0.0.1:${fixture.port}${fixture.base}/ha-assist/`)).status, 403);
      fixture.setUser("b".repeat(32));
      assert.equal((await fetch(fixture.origin + fixture.base + "/ha-assist/")).status, 403);
    } finally { await fixture.close(); }
  });

  test(`${mode}: mobile Ingress opens setup first and existing integration after pairing`, { skip: !browserPath && "set HA_ASSIST_BROWSER_EXECUTABLE for rendered mobile checks", timeout: 30000 }, async () => {
    const fixture = await startAssistUiFixture(mode);
    const puppeteer = mcpRequire("puppeteer-core");
    let browser;
    try {
      browser = await puppeteer.launch({ executablePath: browserPath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
      const page = await browser.newPage();
      await page.emulate(puppeteer.KnownDevices["iPhone 13"]);
      await page.goto(fixture.origin + "/ha-parent");
      let frame = page.frames().find((entry) => entry.url().endsWith(fixture.base + "/"));
      await frame.waitForSelector("#ha-assist-setup a", { visible: true });
      const geometry = await frame.evaluate(() => {
        const link = document.querySelector("#ha-assist-setup a").getBoundingClientRect();
        const app = document.querySelector("#terminal-container, #root > div").getBoundingClientRect();
        return { x: link.x, y: link.y, width: link.width, height: link.height, viewport: innerWidth, bottom: link.bottom, appTop: app.top, appBottom: app.bottom, viewportHeight: innerHeight };
      });
      assert.ok(geometry.height >= 44 && geometry.x >= 0 && geometry.x + geometry.width <= geometry.viewport);
      assert.ok(geometry.appTop >= geometry.bottom && geometry.appBottom <= geometry.viewportHeight + 1, JSON.stringify(geometry));
      await Promise.all([frame.waitForNavigation(), frame.tap("#ha-assist-setup a")]);
      assert.equal(frame.url(), fixture.origin + fixture.base + "/ha-assist/");
      assert.equal(page.url(), fixture.origin + "/ha-parent", "navigation stays within the HA Ingress iframe");
      assert.match(await frame.content(), /Restart Home Assistant after installing or updating/);
      assert.match(await frame.content(), /No URL or key needs copying/);
      assert.equal(await frame.$("form"), null);
      assert.equal(await frame.$eval('a[target="_top"]', (link) => link.href), "https://my.home-assistant.io/redirect/config_flow_start/?domain=opencode_assist");
      assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "setup fits the mobile viewport");
      fixture.pairing.provision("a".repeat(43));
      const owner = fixture.pairing.owner;
      await frame.goto(frame.url());
      assert.equal(await frame.$eval('a[target="_top"]', (link) => link.href), "https://my.home-assistant.io/redirect/integration/?domain=opencode_assist");
      assert.match(await frame.content(), /Add conversation agent/);
      assert.match(await frame.content(), /Add AI data task/);
      assert.doesNotMatch(await frame.content(), /config_flow_start/);
      assert.equal(fixture.pairing.owner, owner, "returning to setup preserves the existing pairing");
      assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "paired setup fits the mobile viewport");
      await Promise.all([frame.waitForNavigation(), frame.tap('a[target="_self"]')]);
      assert.equal(frame.url(), fixture.origin + fixture.base + "/");
    } finally { await browser?.close(); await fixture.close(); }
  });
}
