import { describe, expect, it, vi } from "vitest";
import { discoverNativeLlmApis, describeNativeLlmApiSelection } from "../lib/ha-llm-apis.js";

describe("native LLM API discovery", () => {
  it("projects only registered IDs and names in registration order", async () => {
    const call = vi.fn(async () => ({ apis: [
      { id: "custom", name: "Custom API", internal: "not public" },
      { id: "assist", name: "Assist" },
    ] }));
    const result = await discoverNativeLlmApis(call);
    expect(call).toHaveBeenCalledExactlyOnceWith("llm/api/list");
    expect(result.status).toBe("available");
    expect(result.apis).toEqual([{ id: "custom", name: "Custom API" }, { id: "assist", name: "Assist" }]);
    expect(describeNativeLlmApiSelection(result, "custom")).toMatchObject({ status: "registered", name: "Custom API" });
  });

  it("distinguishes a complete empty registry from unavailable discovery", async () => {
    const empty = await discoverNativeLlmApis(async () => ({ apis: [] }));
    expect(empty.status).toBe("available");
    expect(describeNativeLlmApiSelection(empty, "assist").status).toBe("unknown_api");
    expect(describeNativeLlmApiSelection({ status: "unavailable", apis: [] }, "assist").status).toBe("not_checked");
    expect(describeNativeLlmApiSelection(empty, null).status).toBe("configured_endpoint");
  });

  it.each([null, {}, { apis: {} }, { apis: [null] }, { apis: [{ id: "assist" }] },
    { apis: [{ id: "", name: "Blank" }] },
    { apis: [{ id: "assist", name: "Assist" }, { id: "assist", name: "Duplicate" }] },
  ])("does not infer absent APIs from malformed data: %j", async (result) => {
    const discovery = await discoverNativeLlmApis(async () => result);
    expect(discovery.status).toBe("invalid_response");
    expect(describeNativeLlmApiSelection(discovery, "assist").status).toBe("not_checked");
  });

  it.each([
    ["unknown_command", "unsupported"], ["unauthorized", "unauthorized"],
    ["auth_invalid", "unauthorized"], ["timeout", "timeout"], ["ECONNREFUSED", "unavailable"],
  ])("classifies %s without reflecting upstream errors", async (code, status) => {
    const discovery = await discoverNativeLlmApis(async () => {
      throw Object.assign(new Error("secret token or private URL"), { code });
    });
    expect(discovery.status).toBe(status);
    expect(JSON.stringify(discovery)).not.toContain("secret token");
    expect(describeNativeLlmApiSelection(discovery, "assist").status).toBe("not_checked");
  });

  it("propagates cancellation before and during discovery", async () => {
    const controller = new AbortController();
    const reason = new Error("canceled by caller");
    const call = vi.fn(async () => { controller.abort(reason); throw reason; });
    await expect(discoverNativeLlmApis(call, { signal: controller.signal })).rejects.toBe(reason);
    const unused = vi.fn();
    await expect(discoverNativeLlmApis(unused, { signal: controller.signal })).rejects.toBe(reason);
    expect(unused).not.toHaveBeenCalled();
  });
});
