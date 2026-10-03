import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));

const expectedCli = packageJson.dependencies["@opencode/cli"];
const expectedPlugin = packageJson.dependencies["@opencode/plugin"];

assert.match(expectedCli, /^2\.\d+\.\d+$/);
assert.equal(expectedPlugin, expectedCli, "CLI and plugin versions must match");
assert.equal(lock.packages["node_modules/@opencode/cli"].version, expectedCli);
assert.equal(lock.packages["node_modules/@opencode/plugin"].version, expectedPlugin);

console.log(`OpenCode V2 pins matching official CLI/plugin ${expectedCli}`);
