// Status/recovery content for the administrator-only direct setup route.
const validBase = (path) => /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/.test(path);

function assistUnavailable(ingressPath, installation) {
  const back = validBase(ingressPath) ? `<p><a target="_self" href="${ingressPath}/">Back to OpenCode Beta</a></p>` : '';
  const blocked = installation?.action === "blocked";
  const conflict = blocked && ["unmanaged", "modified"].includes(installation.reason);
  // Only fixed messages are rendered: installation records are never HTML.
  const reason = conflict
    ? `<p>${installation.reason === "unmanaged" ? "An existing companion has no valid app ownership record (for example, a manually installed b0 ZIP)." : "The app-managed companion has local edits or extra files."} Your existing files were preserved, so Assist has not started.</p>`
    : blocked ? '<p>The bundled companion could not be installed. Check the OpenCode Beta app log for the installation error, resolve it, then restart the app.</p>'
      : '<p>Enable <code>ha_assist_enabled</code> in the OpenCode Beta app options and restart the app to install the bundled companion and start Assist.</p><p>If already enabled, check the app log for an installation conflict or startup failure.</p>';
  const recovery = `<h2>${conflict ? "Resolve the installation conflict" : "If the log reports an existing companion conflict"}</h2><ol><li>Back up <code>custom_components/opencode_assist</code> in your Home Assistant configuration directory.</li><li>Move that folder <strong>outside custom_components</strong>, for example into a backup folder. Remove any old manually paired OpenCode Assist integration entry in Home Assistant.</li><li>Restart the OpenCode Beta app with <code>ha_assist_enabled</code> enabled. Confirm the app log reports a successful companion installation.</li><li>Restart <strong>Home Assistant Core</strong> to load the installed code, then configure the discovered <strong>OpenCode Assist</strong> app in Settings → Devices &amp; services.</li></ol><p>The HA configuration directory is <code>/homeassistant</code> inside OpenCode; other HA tools may show it as <code>/config</code>. Moving the files preserves the backup; local code changes need review before reapplying.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>OpenCode Assist setup</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:16px}a{display:inline-flex;align-items:center;min-height:44px}code{overflow-wrap:anywhere}li{margin:12px 0}</style></head><body>${back}<h1>${conflict ? "OpenCode Assist installation conflict" : "OpenCode Assist is not running"}</h1>${reason}${recovery}<p>Restarting Core temporarily interrupts HA and Assist. Home Assistant is never restarted automatically.</p></body></html>`;
}

module.exports = { assistUnavailable };
