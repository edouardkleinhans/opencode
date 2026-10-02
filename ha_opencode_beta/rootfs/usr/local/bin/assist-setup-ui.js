// Plain same-frame navigation works inside HA's iOS Ingress webview: no address
// bar, popup, custom URL scheme, clipboard permission or parent-frame access.
const validBase = (path) => /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/.test(path);

function injectAssistSetup(html, ingressPath, trustedIngress) {
  if (!trustedIngress || !validBase(ingressPath) || html.includes('id="ha-assist-setup"')) return html;
  let result = html.replace(/<html\b/i, '<html data-ha-assist-ui');
  if (!/<meta\b[^>]*name=["']viewport["']/i.test(result)) {
    result = result.replace(/<head([^>]*)>/i, '<head$1><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  }
  const style = `<style id="ha-assist-setup-style">
html[data-ha-assist-ui]{--ha-assist-bar:calc(48px + env(safe-area-inset-top,0px));box-sizing:border-box;padding-top:var(--ha-assist-bar);height:100%;min-height:0}
html[data-ha-assist-ui] body{height:100%;min-height:0;margin:0}
html[data-ha-assist-ui] #root .flex.flex-col.h-screen{height:100%!important;min-height:0!important}
#ha-assist-setup{box-sizing:border-box;position:fixed;inset:0 0 auto 0;height:var(--ha-assist-bar);padding:env(safe-area-inset-top,0px) max(12px,env(safe-area-inset-right,0px)) 0 max(12px,env(safe-area-inset-left,0px));z-index:2147483647;display:flex;align-items:center;justify-content:flex-end;background:#17212b;color:#fff;font:16px/1.25 system-ui,sans-serif}
#ha-assist-setup a{box-sizing:border-box;display:inline-flex;align-items:center;min-height:44px;padding:0 8px;color:#fff;text-decoration:underline;touch-action:manipulation}
#ha-assist-setup a:focus-visible{outline:2px solid #9cdbff;outline-offset:-2px}
</style>`;
  return result.replace(/<\/head>/i, style + '</head>').replace(/<body([^>]*)>/i,
    `<body$1><nav id="ha-assist-setup" aria-label="OpenCode Beta setup"><a target="_self" href="${ingressPath}/ha-assist/">Set up OpenCode Assist</a></nav>`);
}

function assistUnavailable(ingressPath) {
  const back = validBase(ingressPath) ? `<p><a target="_self" href="${ingressPath}/">Back to OpenCode Beta</a></p>` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenCode Assist setup</title><h1>OpenCode Assist is not running</h1><p>Enable <code>ha_assist_enabled</code> in the OpenCode Beta app options and restart the app to install the bundled companion and start Assist.</p><p>If already enabled, check the app log for an installation conflict or startup failure. An existing manual integration or local edits are preserved; resolve the conflict before restarting the app.</p><p>After new companion code is installed, restart <strong>Home Assistant</strong>, not only the app. Home Assistant is never restarted automatically.</p>${back}</html>`;
}

module.exports = { injectAssistSetup, assistUnavailable };
