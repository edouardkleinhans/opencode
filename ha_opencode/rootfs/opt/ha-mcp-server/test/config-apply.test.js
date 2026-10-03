import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configApplyGuidance } from "../lib/config-apply.js";
import { scoreScenario } from "../lib/agent-evaluation.js";

const saved = { persisted: true, validated: true };
const { scenarios } = JSON.parse(readFileSync(new URL("../evaluation/scenarios.json", import.meta.url), "utf8"));
const approved = scenarios.find(({ id }) => id === "automation-approved-write-reload-verify");
const call = (name, args) => ({ name, arguments: args, valid: true });
const sequence = [
  call("write_config_safe", { file_path: "automations.yaml", content: approved.prompt.split("Complete draft:\n")[1], dry_run: false }),
  call("call_service", { domain: "automation", service: "reload" }),
  call("get_entity_details", { entity_id: "automation.quote_test" }),
];

describe("safe-write apply guidance", () => {
  it.each([["automations.yaml", "automation"], ["/homeassistant/automations.yaml", "automation"], ["./scripts.yaml", "script"], ["scenes.yaml", "scene"]])(
    "identifies the standard domain for %s without claiming it was applied", (path, domain) => {
      const text = configApplyGuidance(path, saved);
      expect(text).toContain(`call_service(domain="${domain}", service="reload")`);
      expect(text).toContain("pending apply");
      expect(text).toContain("Obtain approval");
      expect(text).toContain("read-only tools");
    },
  );
  it.each([{}, { persisted: false, validated: true }, { persisted: true, validated: false }])(
    "does not recommend applying a dry run or failed validation: %j", (status) => {
      expect(configApplyGuidance("automations.yaml", status)).toBe("");
    },
  );
  it.each(["packages/automations.yaml", "/homeassistant/packages/automations.yaml", "/homeassistant2/automations.yaml", "includes/scripts.yaml", "configuration.yaml", "custom.yaml"])(
    "does not infer a reload from the basename of %s", (path) => {
      const text = configApplyGuidance(path, saved);
      expect(text).not.toContain('call_service(domain=');
      expect(text).toContain("follow the includes/packages");
    },
  );
  it("handles missing reload tools without bypassing the profile", () => {
    expect(configApplyGuidance("automations.yaml", saved)).toContain("do not bypass the profile");
  });
});

describe("automation evaluation boundaries", () => {
  it("accepts write, reload, then read-only verification", () => {
    expect(scoreScenario(approved, sequence, "Saved, reloaded, load verified.").passed).toBe(true);
  });
  it("rejects reload before writing, missing verification, and triggering instead of reloading", () => {
    for (const calls of [
      [sequence[1], sequence[0], sequence[2]],
      sequence.slice(0, 2),
      [sequence[0], call("call_service", { domain: "automation", service: "trigger" }), sequence[2]],
      [...sequence, call("call_service", { domain: "automation", service: "turn_on" })],
    ]) expect(scoreScenario(approved, calls, "Done.").passed).toBe(false);
  });
  it("requires every service call to satisfy an all-arguments assertion", () => {
    const assertionOnly = { ...approved, expect: { arguments: approved.expect.arguments.filter(({ tool }) => tool === "call_service") } };
    expect(scoreScenario(assertionOnly, [sequence[1], call("call_service", { domain: "automation", service: "trigger" })], "Done.").passed).toBe(false);
    expect(scoreScenario(assertionOnly, [], "Done.").passed).toBe(false);
  });
  it("rejects reload without approval", () => {
    const pending = scenarios.find(({ id }) => id === "automation-reload-not-approved");
    expect(scoreScenario(pending, [], "Saved, pending reload approval.").passed).toBe(true);
    expect(scoreScenario(pending, [sequence[1]], "Reloaded.").passed).toBe(false);
  });
  it("rejects damaged quoting in the approved YAML", () => {
    const damaged = call("write_config_safe", { ...sequence[0].arguments, content: sequence[0].arguments.content.replace("states('sensor.test')", "states(sensor.test)") });
    expect(scoreScenario(approved, [damaged, ...sequence.slice(1)], "Done.").passed).toBe(false);
  });
});
