import { posix } from "node:path";

const RELOAD_DOMAINS = new Map([
  ["automations.yaml", "automation"],
  ["scripts.yaml", "script"],
  ["scenes.yaml", "scene"],
]);

/** Next steps only: saving a file never authorizes or performs a reload. */
export function configApplyGuidance(filePath, { persisted = false, validated = false } = {}) {
  if (!persisted || !validated) return "";
  // Match config-root files, never a package/include's basename.
  const relativePath = posix.relative("/homeassistant", posix.resolve("/homeassistant", filePath));
  const domain = RELOAD_DOMAINS.get(relativePath);
  const next = domain
    ? `For the standard ${domain} include, use \`call_service(domain="${domain}", service="reload")\` after confirming this file is loaded by that domain. No Core restart is needed for that edit.`
    : "Inspect configuration.yaml and follow the includes/packages to identify the affected domains and their supported reloads. Do not infer the domain from this file's basename or automatically restart Core. Explain any required restart and obtain approval first.";
  return `---\n**Saved and validated; pending apply.** This tool has not reloaded Home Assistant.\n\n${next}\n\n` +
    "Obtain approval for the reload if it was not already approved with the write. Automation reload stops running automation actions. " +
    "If call_service is unavailable in this tool profile, report the pending reload and offer a manual reload in HA Developer Tools → YAML, or the full profile after an add-on restart; do not bypass the profile via shell/API calls. " +
    "After applying, check the service result and affected runtime entities with read-only tools, and inspect relevant errors if needed. " +
    "Report saved/reloaded/load-verified separately. Do not trigger or enable automations as a loading check; functional testing needs separate approval.\n";
}
