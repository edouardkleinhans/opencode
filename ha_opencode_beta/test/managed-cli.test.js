import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("managed CLI routing, non-starting status and native read-only policy", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./managed-cli.test.py", import.meta.url))], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
});
