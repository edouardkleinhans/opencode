// Home Assistant 2026.9+: admin-only websocket command. Registration is not
// evidence that MCP Server is configured or that a tool call will succeed.
export const LLM_API_LIST_COMMAND = "llm/api/list";

const FAILURE_DETAILS = {
  unsupported: "Home Assistant does not expose llm/api/list. It requires HA 2026.9 or later with the llm integration loaded; keep the configured API ID and check native MCP readiness separately.",
  unauthorized: "Home Assistant denied LLM API discovery; this command requires an authenticated administrator.",
  timeout: "Home Assistant did not answer LLM API discovery before the deadline. Retry the capability check when Core is ready.",
  unavailable: "Could not query Home Assistant's LLM API registry. Check Core/Supervisor connectivity and retry the capability check.",
  invalid_response: "Home Assistant returned an invalid LLM API list; the configured API ID could not be checked.",
};

export async function discoverNativeLlmApis(callCommand, { signal } = {}) {
  const base = { command: LLM_API_LIST_COMMAND, minimum_version: "2026.9.0", requires_admin: true };
  try {
    signal?.throwIfAborted();
    const result = await callCommand(LLM_API_LIST_COMMAND);
    signal?.throwIfAborted();
    if (!Array.isArray(result?.apis) || result.apis.some((api) =>
      typeof api?.id !== "string" || !api.id.trim() ||
      typeof api.name !== "string" || !api.name.trim()) ||
      new Set(result.apis.map((api) => api.id)).size !== result.apis.length) {
      return { ...base, status: "invalid_response", apis: [], detail: FAILURE_DETAILS.invalid_response };
    }
    return {
      ...base,
      status: "available",
      apis: result.apis.map(({ id, name }) => ({ id, name })),
      detail: "Registered LLM API IDs and names, in Home Assistant registration order. This list does not prove MCP endpoint or tool availability.",
    };
  } catch (error) {
    // A canceled MCP request must not turn into a successful capability report.
    signal?.throwIfAborted();
    const status = error?.code === "unknown_command" ? "unsupported"
      : ["unauthorized", "auth_invalid"].includes(error?.code) ? "unauthorized"
      : error?.code === "timeout" ? "timeout" : "unavailable";
    // Never reflect upstream error messages, URLs or authentication material.
    return { ...base, status, apis: [], detail: FAILURE_DETAILS[status] };
  }
}

export function describeNativeLlmApiSelection(discovery, apiId) {
  if (!apiId) {
    return {
      status: "configured_endpoint", id: null, name: null,
      detail: "Using /api/mcp: its APIs and admin requirement are controlled by MCP Server options. New HA 2026.10 entries expose all registered APIs by default, including APIs added later.",
    };
  }
  if (discovery?.status !== "available") {
    return {
      status: "not_checked", id: apiId, name: null,
      detail: "API discovery was unavailable; this does not establish whether the configured API ID exists. Check the endpoint probe separately.",
    };
  }
  const api = discovery.apis.find(({ id }) => id === apiId);
  return api
    ? { status: "registered", ...api, detail: "The configured API ID is registered. Check native MCP readiness separately." }
    : {
      status: "unknown_api", id: apiId, name: null,
      detail: "The configured API ID is absent from the current registry. Choose an ID from api_discovery.apis in the add-on's Native Home Assistant MCP API ID option; discovery does not change the selection or broaden access.",
    };
}
