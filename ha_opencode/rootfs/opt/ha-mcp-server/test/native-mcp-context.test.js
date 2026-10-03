import { describe, expect, it, vi } from "vitest";
import { createNativeMcpHandler } from "../lib/native-mcp-handler.js";
import { contextUri, nativeResult, tools } from "./fixtures/ha-native-2026.10.mjs";

function fixture({ apiId = "assist", endpointMode = "keyed", transform = (response) => response } = {}) {
  let snapshot = "first snapshot";
  const fetchImpl = vi.fn(async (_url, options) => {
    const message = JSON.parse(options.body);
    const result = transform(nativeResult(message, { snapshot }), message);
    return result === null ? new Response(null, { status: 202 }) : Response.json(result);
  });
  const handler = createNativeMcpHandler({ supervisorToken: "fixture-token", apiId, endpointMode, fetchImpl });
  let id = 0;
  return { handler, fetchImpl, changeSnapshot(value) { snapshot = value; },
    request(method, params) { return handler({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }); },
  };
}

describe("native HA 2026.10 prompt/context contract", () => {
  it("adds initialization guidance while preserving upstream instructions and capabilities, without reading home state", async () => {
    const { request, fetchImpl } = fixture();
    const { result } = await request("initialize", { protocolVersion: "2025-11-25" });
    expect(result.instructions).toContain("upstream fixture instructions");
    expect(result.instructions).toContain("/homeassistant_native:<prompt>");
    expect(result.instructions).toContain(contextUri);
    expect(result.capabilities).toEqual({ tools: {}, prompts: {}, resources: {} });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("first snapshot");
  });

  it("does not imply absent capabilities on an older or custom endpoint", async () => {
    const { request } = fixture({ transform(response) {
      response.result.capabilities = { tools: {} };
      delete response.result.instructions;
      return response;
    } });
    const { result } = await request("initialize");
    expect(result.instructions).not.toContain(contextUri);
    expect(result.instructions).not.toContain("commands");
    expect(result.capabilities).toEqual({ tools: {} });
  });

  it.each(["Custom API", "Assist, Custom API"])("forwards the selected prompt name %s and its roles without caching or renaming", async (promptName) => {
    const { handler, fetchImpl } = fixture({ apiId: "custom", transform(_response, message) {
      return nativeResult(message, { promptName });
    } });
    const list = await handler({ jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(list.result.prompts[0].name).toBe(promptName);
    const message = { jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: promptName } };
    expect(await handler(message)).toEqual(nativeResult(message, { promptName }));
    expect(fetchImpl.mock.calls.every(([url]) => url.endsWith("/mcp/custom"))).toBe(true);
  });

  it("reads a fresh snapshot per request and preserves trusted caller metadata without inventing it", async () => {
    const { request, fetchImpl, changeSnapshot } = fixture();
    const list = await request("resources/list");
    expect(list.result.resources[0].uri).toBe(contextUri);
    const params = { uri: contextUri, _meta: { "io.home-assistant/device_id": "trusted-fixture-device", sessionID: "opaque-fixture" } };
    expect((await request("resources/read", params)).result.contents[0].text).toBe("first snapshot");
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body).params).toEqual(params);
    changeSnapshot("second snapshot");
    expect((await request("resources/read", { uri: contextUri })).result.contents[0].text).toBe("second snapshot");
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body).params).toEqual({ uri: contextUri });
  });

  it("keeps titles, required schemas and all four annotations intact", async () => {
    const { request } = fixture();
    const listed = await request("tools/list");
    expect(listed.result.tools).toEqual(tools);
  });

  it.each(["vendor__Unconstrained", "CustomTool"])("does not narrow an intentional unconstrained schema for %s", async (name) => {
    const modern = { ...tools[1], name, inputSchema: {
      type: "object", required: ["payload"], properties: { payload: { anyOf: [{}, { type: "string" }] } },
    } };
    const { request } = fixture({ transform(response) { response.result = { tools: [modern] }; return response; } });
    expect((await request("tools/list")).result.tools).toEqual([modern]);
  });

  it("returns native tool failures and unknown resources without retrying a wider endpoint", async () => {
    const { request, fetchImpl } = fixture({ endpointMode: "auto" });
    const failure = await request("tools/call", { name: tools[1].name, arguments: { name: "Fixture", brightness: 20 } });
    expect(failure.result.isError).toBe(true);
    expect(JSON.parse(failure.result.content[0].text)).toEqual({ error: "fixture denied" });
    expect((await request("resources/read", { uri: "homeassistant://missing" })).error.code).toBe(-32602);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => url.endsWith("/mcp/assist"))).toBe(true);
  });

  it("preserves initialization errors without attaching successful context guidance", async () => {
    const error = { code: -32602, message: "Invalid protocol" };
    const { request } = fixture({ transform(response) { return { jsonrpc: "2.0", id: response.id, error }; } });
    expect(await request("initialize")).toEqual({ jsonrpc: "2.0", id: 1, error });
  });

  it("aborts a resource read without sharing its cancellation with another request", async () => {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const fetchImpl = vi.fn(async (_url, options) => {
      const message = JSON.parse(options.body);
      if (message.method !== "resources/read") return Response.json(nativeResult(message));
      started();
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const handler = createNativeMcpHandler({ supervisorToken: "fixture-token", fetchImpl });
    const controller = new AbortController();
    const pending = handler({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: contextUri } }, { signal: controller.signal });
    await ready;
    controller.abort();
    expect((await pending).error).toBeDefined();
    expect((await handler({ jsonrpc: "2.0", id: 2, method: "resources/list" })).result.resources[0].uri).toBe(contextUri);
  });
});
