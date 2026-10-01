// Targeted patches for the immutable OpenChamber preview. Fail on source drift
// before writing anything; no runtime pins or backend ownership are changed.
const fs = require("node:fs");
const path = require("node:path");

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`Unexpected preview source: ${label}`);
  return source.replace(before, after);
}

function patchUsageModel(root) {
  const files = new Map();
  const edit = (file, before, after) => {
    const source = files.get(file) ?? fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    files.set(file, replaceOnce(source, before, after, file));
  };
  const auth = "packages/web/server/lib/opencode/auth.js";
  edit(auth, `  const legacy = readLegacyAuthFile();
  const stored = readCredentialsFromDb({
    dbPath: resolveCredentialDbPath({ dataDir: OPENCODE_DATA_DIR, path }),
    fs,
  });
  return stored ? { ...legacy, ...stored } : legacy;`, `  // The HA launcher supplies the active V2 generation's database path only.
  // Never merge retained V1 auth, including after disconnect or a read failure.
  const dbPath = process.env.OPENCODE_DB;
  if (!dbPath || !path.isAbsolute(dbPath)) throw new Error('Managed provider credentials unavailable');
  const stored = readCredentialsFromDb({ dbPath, fs });
  if (stored === null) throw new Error('Managed provider credentials unavailable');
  return stored;`);
  edit(auth, "readCredentialsFromDb, resolveCredentialDbPath", "readCredentialsFromDb");
  edit(auth, `function readLegacyAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed);
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
}
`, "// Legacy paths remain exported for upstream compatibility, but auth is V2-only.\n");
  const db = "packages/web/server/lib/opencode/credential-db.js";
  // Match OpenCode 2.0.13's active / creation-time / ID selection, not refresh time.
  edit(db, "ORDER BY integration_id, active DESC, time_updated DESC",
    "ORDER BY integration_id, active DESC, time_created DESC, id DESC");
  edit(db, `    const result = {};
    for (const row of rows) {`, `    const result = {};
    const selected = new Set();
    for (const row of rows) {`);
  edit(db, "      if (!id || id in result) continue;", `      if (!id || selected.has(id)) continue;
      selected.add(id); // An unsupported active value must not resurrect an inactive account.`);
  edit(db, "console.warn('Could not read OpenCode credentials database:', error instanceof Error ? error.message : error);",
    "console.warn('Could not read managed OpenCode credentials database');");
  const quota = "packages/web/server/lib/quota/providers/codex.js";
  edit(quota, "Session expired \\u2014 please re-authenticate with OpenAI",
    "OpenAI usage authorization expired. Send a message to refresh your OpenCode sign-in, then refresh Usage. Reconnect OpenAI if chat also fails.");

  const config = "packages/ui/src/stores/useConfigStore.ts";
  const source = fs.readFileSync(path.join(root, config), "utf8").replace(/\r\n/g, "\n");
  const start = "                applyDefaultModelAgentSelection: (options) => {";
  const end = "                applyOpenCodeConfigDefaults: (directory, source = \"syncConfig\", config) => {";
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error("Unexpected preview model-selection boundary");
  const before = source.slice(source.indexOf(start), source.indexOf(end));
  let after = replaceOnce(before, "                    const {\n                        agentName: resolvedAgentName,",
    "                    let {\n                        agentName: resolvedAgentName,", config);
  after = replaceOnce(after, "                    set((state) => {", `                    // New chats inherit the last-used model stored by the composer.
                    // Missing/removed models fall back to the normal default cascade.
                    const last = useSelectionStore.getState().lastUsedProvider;
                    const remembered = last && hasProviderModel(providers, last.providerID, last.modelID);
                    if (remembered) {
                        if (resolvedProviderId !== last.providerID || resolvedModelId !== last.modelID) resolvedVariant = undefined;
                        resolvedProviderId = last.providerID;
                        resolvedModelId = last.modelID;
                    }

                    set((state) => {`, config);
  // Keep asynchronous provider/agent discovery from replacing this user choice.
  if (after.split('selectionSource: "auto",').length !== 3) throw new Error("Unexpected preview selection sources");
  after = after.replaceAll('selectionSource: "auto",', 'selectionSource: remembered ? "manual" : "auto",');
  files.set(config, source.replace(before, after));
  for (const [file, contents] of files) fs.writeFileSync(path.join(root, file), contents);
}

module.exports = { patchUsageModel };
if (require.main === module) {
  if (process.argv.length !== 3) throw new Error("Usage: patch-usage-model.cjs <preview-source-root>");
  patchUsageModel(process.argv[2]);
  console.log("OpenChamber uses managed V2 usage credentials and remembers the last model for new chats");
}
