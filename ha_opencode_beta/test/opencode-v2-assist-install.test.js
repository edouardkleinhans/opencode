import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
test("companion installer publishes whole trees and preserves conflicts/failures", () => {
  const result = spawnSync("python3", [join(root, "test/assist-install.test.py")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("disabled Assist does not install; install failure prevents service start", () => {
  const directory = mkdtempSync(join(tmpdir(), "assist-service-gate-"));
  try {
    const calls = join(directory, "calls");
    for (const name of ["python3", "sleep"]) writeFileSync(join(directory, name), `#!/bin/bash\necho ${name} >> "$CALLS"\n${name === "python3" ? "exit 1" : "exit 0"}\n`, { mode: 0o755 });
    const script = join(root, "rootfs/etc/s6-overlay/s6-rc.d/ha-assist/run");
    for (const enabled of ["false", "true"]) {
      writeFileSync(calls, "");
      const result = spawnSync("bash", ["-c", 'function bashio::config() { echo "$ENABLED"; }; export -f bashio::config; bash "$RUN_SCRIPT"'], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CALLS: calls, ENABLED: enabled, RUN_SCRIPT: script }, encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(calls, "utf8"), enabled === "true" ? "python3\nsleep\n" : "sleep\n");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
