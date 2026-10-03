import assert from "node:assert/strict";
import { test } from "vitest";
import { prepareHabRequest, splitHabCommand, formatHabExecution } from "../lib/hab-cli.js";

const unwrap = (response) => JSON.parse(response.content[0].text);

test("literal argv preserves JSON, Jinja, apostrophes, spaces and empty values", () => {
  const args = ["event", "fire", "test_event", "--data", JSON.stringify({ text: `Alice's \"room\"`, template: "{{ states('sun.sun') }}", empty: "" })];
  assert.deepEqual(prepareHabRequest({ args }).argv, ["--skip-update-check", "--json", ...args]);
  assert.deepEqual(prepareHabRequest({ args: ["template", "render", ""] }).argv.slice(-1), [""]);
  assert.equal(prepareHabRequest({ args }).timeoutMs, 60000);
  assert.ok(!prepareHabRequest({ args: ["help", "--text"] }).argv.includes("--json"));
});

test("legacy parsing handles adjacent/escaped quotes without interpreting a shell", () => {
  assert.deepEqual(splitHabCommand(`template render "{{ states('sun.sun') }}"`), ["template", "render", "{{ states('sun.sun') }}"]);
  assert.deepEqual(splitHabCommand(`person create 'Alice'"'"'s office'`), ["person", "create", "Alice's office"]);
  assert.deepEqual(splitHabCommand('event fire test --data \'{"text":"a \\\"quote\\\""}\''), ["event", "fire", "test", "--data", '{"text":"a \\"quote\\""}']);
  assert.deepEqual(splitHabCommand('template render ""'), ["template", "render", ""]);
  assert.deepEqual(splitHabCommand('template render "C:\\path"'), ["template", "render", "C:\\path"]);
  for (const command of ["version; update", "version | cat", "version > out", "$(echo update)", "`update`", "'unfinished", '"unfinished', "unfinished\\"]) {
    assert.throws(() => prepareHabRequest({ command }));
  }
});

test("managed auth/update policy is applied after tokenization and global flags", () => {
  for (const args of [["auth"], ["update", "--check"], ["--json", "auth", "login"], ["--config", "/tmp/fixture", "update"], ["--text=true", "--", "auth"], ["--verbose", "esphome", "list"]]) {
    if (args.includes("esphome")) assert.equal(prepareHabRequest({ args }).root, "esphome");
    else assert.throws(() => prepareHabRequest({ args }), /Auth commands|Self-update/);
  }
  assert.throws(() => prepareHabRequest({ command: '"update" --force' }), /Self-update/);
  assert.equal(prepareHabRequest({ args: ["schema", "auth", "login"] }).root, "schema");
  assert.equal(prepareHabRequest({ args: ["--help"] }).root, "help");
});

test("invalid inputs fail before subprocess execution", () => {
  for (const input of [{}, { args: [], command: "version" }, { args: [] }, { args: [1] }, { args: ["bad\0value"] }, { command: 1 }, { args: ["hab", "version"] }, { args: ["version"], timeout_seconds: 121 }, { args: ["version"], timeout_seconds: 0 }, { args: ["version"], timeout_seconds: 1.5 }]) {
    assert.throws(() => prepareHabRequest(input));
  }
});

test("compact discovery keeps the selected contract and immediate children only", () => {
  const request = prepareHabRequest({ args: ["schema", "dashboard"] });
  const envelope = { success: true, operation: "schema", data: { path: "hab dashboard", use: "dashboard", side_effect: "meta",
    flags: [{ name: "json", type: "bool" }], output_contract: { repeated: "x".repeat(100000) },
    subcommands: [{ path: "hab dashboard card", use: "card", summary: "Cards", subcommands: [{ path: "hab dashboard card get" }], output_contract: { repeated: "x".repeat(100000) } }] } };
  const result = unwrap(formatHabExecution(request, JSON.stringify(envelope)));
  assert.equal(result.data.data.path, "hab dashboard");
  assert.equal(result.data.metadata.compact_schema, true);
  assert.equal(result.data.data.output_contract, undefined);
  assert.equal(result.data.data.subcommands[0].subcommands, undefined);
  assert.deepEqual(result.data.data.flags, envelope.data.flags);
  assert.match(result.data.data.contract_notes.join(" "), /not permission checks/);
  assert.ok(JSON.stringify(result).length < 3000);

  const typo = formatHabExecution(prepareHabRequest({ args: ["schema", "device", "update"] }),
    JSON.stringify({ success: true, operation: "schema", data: { path: "hab device" } }));
  assert.equal(typo.isError, true);
  assert.equal(unwrap(typo).data.error.code, "UNKNOWN_COMMAND_PATH");
});

test("guide indexes are compact while selected guide recipes are retained", () => {
  const topic = { id: "dashboard", title: "Dashboard", summary: "Edit cards", recipes: [{ steps: ["read", "plan", "apply"] }] };
  const list = unwrap(formatHabExecution(prepareHabRequest({ args: ["guide", "list"] }),
    JSON.stringify({ success: true, resource_type: "guide", operation: "list", data: [topic] })));
  assert.equal(list.data.data[0].recipes, undefined);
  const get = unwrap(formatHabExecution(prepareHabRequest({ args: ["guide", "dashboard"] }),
    JSON.stringify({ success: true, resource_type: "guide", operation: "get", data: topic })));
  assert.deepEqual(get.data.data.recipes, topic.recipes);
});

test("CLI failures, partial results and interrupted mutations keep honest outcomes", () => {
  const request = prepareHabRequest({ args: ["area", "create", "Kitchen"] });
  const failure = { success: false, error: { code: "VALIDATION_ERROR", message: "Invalid input" } };
  for (const error of [undefined, { code: 1 }]) {
    const result = formatHabExecution(request, JSON.stringify(failure), error);
    assert.equal(result.isError, true);
    assert.match(unwrap(result).summary, /failed/);
    assert.equal(unwrap(result).data.error.code, "VALIDATION_ERROR");
  }
  const partial = unwrap(formatHabExecution(request, JSON.stringify({ success: true, partial_result: true, warnings: ["Reload not confirmed"] })));
  assert.match(partial.summary, /partial/);
  assert.deepEqual(partial.data.warnings, ["Reload not confirmed"]);
  for (const error of [{ name: "TimeoutError" }, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }]) {
    const result = formatHabExecution(request, '{"success":true,"data":{"id":"kitchen"}}', error);
    assert.equal(result.isError, true);
    assert.equal(unwrap(result).data.metadata.outcome_unverified, true);
    assert.equal(unwrap(result).data.data.result.data.id, "kitchen");
    assert.match(unwrap(result).summary, /failed/);
  }
});

test("large results preserve the complete envelope without echoing input payloads", () => {
  const request = prepareHabRequest({ args: ["dashboard", "save-config", "panel", "--data", "private-input"] });
  const data = { success: true, data: { views: [{ content: "x".repeat(40000) }] } };
  let saved;
  const result = unwrap(formatHabExecution(request, JSON.stringify(data), undefined, {
    saveLargeOutput: (value) => { saved = value; return "/runtime/full.json"; },
  }));
  assert.equal(result.meta.truncated, true);
  assert.equal(result.meta.full_output_path, "/runtime/full.json");
  assert.equal(result.meta.command, "dashboard");
  assert.deepEqual(JSON.parse(saved), data);
  assert.ok(!JSON.stringify(result).includes("private-input"));
});
