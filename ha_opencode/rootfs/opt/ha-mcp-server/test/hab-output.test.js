import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import { createCommandOutputContent } from "../lib/command-output.js";
import { saveHabOutput } from "../lib/hab-output.js";

const workspaces = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test("large dashboard JSON remains complete in a private runtime file while the MCP preview stays bounded", () => {
  const workspace = mkdtempSync(join(tmpdir(), "hab-workspace-"));
  workspaces.push(workspace);
  const dashboard = { views: [{ title: "Panel", cards: [{ type: "picture-elements",
    elements: Array.from({ length: 500 }, (_, n) => ({ type: "state-label", entity: `sensor.example_${n}` })) }] }] };
  const original = JSON.stringify(dashboard);
  assert.ok(original.length > 20000);
  const saveLargeOutput = (text, format) => saveHabOutput(text, format, { workspace });

  const result = JSON.parse(createCommandOutputContent("hab", "dashboard get sample --json", original,
    { saveLargeOutput }).text);
  assert.equal(result.meta.truncated, true);
  assert.ok(result.meta.omitted_chars > 0);
  assert.equal(result.meta.full_output_format, "json");
  assert.equal(result.data.raw_json_preview.includes("chars omitted"), true);
  const path = result.meta.full_output_path;
  assert.ok(path.startsWith(`${workspace}/.hab-output-`));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), dashboard);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(lstatSync(dirname(path)).mode & 0o777, 0o700);

  const small = JSON.parse(createCommandOutputContent("hab", "dashboard list --json", "[]",
    { saveLargeOutput: () => { throw new Error("should not write a small result"); } }).text);
  assert.equal(small.meta.truncated, false);
  assert.equal(small.meta.full_output_path, undefined);
});

test("large plain text is preserved and expired private exports are removed on the next export", () => {
  const workspace = mkdtempSync(join(tmpdir(), "hab-workspace-"));
  workspaces.push(workspace);
  const text = "line\n".repeat(6000);
  const save = (value, format) => saveHabOutput(value, format, { workspace });
  const first = JSON.parse(createCommandOutputContent("hab", "dashboard view get sample 0", text,
    { saveLargeOutput: save }).text);
  assert.equal(first.meta.full_output_format, "text");
  assert.equal(readFileSync(first.meta.full_output_path, "utf8"), text.trim() + "\n");

  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(dirname(first.meta.full_output_path), old, old);
  saveHabOutput("{}", "json", { workspace });
  assert.throws(() => readFileSync(first.meta.full_output_path));
});

test("does not write through a symlink or a group-writable workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "hab-boundary-"));
  workspaces.push(root);
  const workspace = join(root, "workspace");
  symlinkSync(root, workspace);
  assert.throws(() => saveHabOutput("{}", "json", { workspace }), /unsafe hab output workspace/);
  rmSync(workspace);
  chmodSync(root, 0o770);
  assert.throws(() => saveHabOutput("{}", "json", { workspace: root }), /unsafe hab output workspace/);
});
