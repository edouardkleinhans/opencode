#!/usr/bin/env node
import { requestLsp } from "/opt/opencode-v2-homeassistant/lsp.js";
try {
  const result = await requestLsp("homeassistant/health");
  if (result.authenticated !== true || !result.core_version) throw new Error();
  console.log("ok");
} catch {
  console.error("The supervised YAML language server cannot verify its Home Assistant connection");
  process.exitCode = 1;
}
