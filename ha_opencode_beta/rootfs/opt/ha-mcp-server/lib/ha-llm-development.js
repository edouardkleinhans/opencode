export function buildHaLlmDevelopmentGuide(args = {}) {
  const domain = String(args?.integration_domain || "example_domain")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_") || "example_domain";
  const toolClass = String(args?.tool_class || "ExampleStatusTool")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "") || "ExampleStatusTool";
  const apiClass = toolClass.endsWith("Tool")
    ? `${toolClass.slice(0, -4)}API`
    : `${toolClass}API`;

  return `# Home Assistant native LLM tool provider guide

Availability: the \`llm\` integration, the per-domain LLM tool platforms, and the keyed
\`/api/mcp/<API ID>\` endpoints first ship in **Home Assistant 2026.8**. None of this exists in
2026.7.x or earlier — on those releases only the configured \`/api/mcp\` endpoint and the legacy
\`/mcp_server/sse\` transport are served, and \`<integration>/llm.py\` is never loaded.

The starter code below targets **Home Assistant 2026.10.0b0**: \`probatio.Schema\`,
\`ToolResult\`, integration metadata and domain-prefixed tool names. For 2026.8/2026.9,
consult that release's source instead of copying the 2026.10 imports unchanged.

Upstream references:
- Architecture: home-assistant/architecture#1412
- Core plumbing: home-assistant/core#174253
- API ID passed to platforms: home-assistant/core#175572
- Assist migration: home-assistant/core#175659
- Keyed MCP endpoints: home-assistant/core#175570
- Tool schema conversion fix: home-assistant/core#176814 (issue #176762)
- Developer docs: home-assistant/developers.home-assistant#3201
- Current LLM API docs update: home-assistant/developers.home-assistant#3236
- API discovery: home-assistant/core#177903 (\`llm/api/list\`, HA 2026.9+)
- Tool names and metadata: home-assistant/core#179938, #182614, #182714
- ToolResult: home-assistant/core#182487
- Tagged examples: https://github.com/home-assistant/core/blob/2026.10.0b0/homeassistant/components/light/llm.py
- HA guidelines: https://developers.home-assistant.io/docs/core/llm/

Use this when developing a Home Assistant integration or custom integration that should contribute
curated tools to Assist through \`<integration>/llm.py\`. This is different from OpenCode's own MCP
server: native HA LLM tools run inside Home Assistant and are consumed by Assist/native MCP when
available.

Checklist:
- Put the file at \`custom_components/${domain}/llm.py\` or \`homeassistant/components/${domain}/llm.py\`.
- Expose \`async_get_tools(hass, llm_context, api_id) -> LLMTools | None\` as a module-level \`@callback\`.
- No manifest change is needed. Home Assistant discovers \`llm.py\` for every loaded integration
  through \`LazyIntegrationPlatforms\`; core platforms such as \`light\` declare no \`llm\` dependency.
- Use \`api_id\` to return tools only for APIs your integration supports; return \`None\` otherwise.
  Compare against \`LLM_API_ASSIST\` rather than the literal string.
- Gate on exposure. Return \`None\` when \`llm_context.assistant\` is unset, and filter entities with
  \`async_should_expose(hass, llm_context.assistant, entity_id)\` so the assistant only ever sees what
  the user exposed to it.
- Prefer wrapping existing intents with \`IntentTool\` over hand-written tools to keep sentence
  support and tool support in sync. Use a domain-prefixed name and set \`integration\`.
- Keep prompt guidance next to the tools by returning \`LLMTools(tools=..., prompt=...)\`.
- Read tool arguments from \`tool_input.tool_args\`; request context lives on \`llm_context\`.
- Return \`ToolResult(data=...)\`; raise \`HomeAssistantError\` or set \`error=True\` for failures.
- Set \`title\`, \`integration\`, and accurate \`ToolAnnotations\`. Annotations describe behavior;
  permission/exposure checks must still be enforced by the tool or its intent handler.
- Keep destructive/admin tools out of Assist unless there is a clear approval model.
- Add tests for tool visibility, schema validation, success, and error paths.
- Once the MCP Server integration is set up, registered LLM APIs are exposed at \`/api/mcp/<API ID>\`.
- Home Assistant also serves the selected APIs at \`/api/mcp\`, or all registered APIs when the
  MCP Server's "Expose all LLM APIs" option is enabled. New 2026.10 entries default to all APIs
  and require admin; existing entries retain their selections and access setting.
- Keyed endpoints require admin access for every API ID except \`assist\`. An add-on clears that bar — the Supervisor calls Core as its own system user, which is created in the admin group — so a custom API you register can be exercised from OpenCode over \`/api/mcp/<your API ID>\` without a long-lived token.
- The configured-endpoint selection does not restrict the keyed endpoints. Use \`assist\` for ordinary
  home control and select custom APIs deliberately. The admin-only \`llm/api/list\` WebSocket command
  returns \`{"apis":[{"id":"assist","name":"Assist"}]}\`; \`get_agent_capabilities\` reports that
  registry separately from MCP transport availability. Discovery changes no configuration.

## Tool parameter schema gotchas

On 2026.10, tool \`parameters\` use \`probatio.Schema\`; native MCP converts them with
\`probatio.to_openapi(..., openapi_version="3.1.0")\`, including required parameters.
Prefer plain types or HA selectors with \`APIInstance.custom_serializer=selector_serializer\`.
Check the emitted MCP schema as well as Python-side validation.

Older-release compatibility: before home-assistant/core#176814 (Home Assistant 2026.8),
\`voluptuous_openapi\` could not infer some custom validators, producing an empty schema:

\`\`\`python
# Produces {"anyOf": [{}, {"items": {"type": "string"}, "type": "array"}]}
vol.Optional("domain"): vol.Any(cv.string, [cv.string])
\`\`\`

An empty member matches anything, so MCP clients that strictly compile tool parameters refuse the
union, fall back to sending raw arguments, and Home Assistant rejects the call with
\`extra keys not allowed @ data['__unparsedToolInput']\`. This is what broke \`GetLiveContext\` for
external clients on 2026.7.x.

For integrations targeting those older voluptuous-based releases:

\`\`\`python
vol.Optional("domain"): vol.All(cv.ensure_list, [cv.string])  # array of strings
vol.Optional("include_details"): bool                          # plain types convert directly
vol.Optional("area"): selector.AreaSelector()                  # selectors have a serializer
\`\`\`

From 2026.8, \`selector_serializer\` also maps bare \`cv.string\`, \`cv.boolean\`, and
\`intent.non_empty_string\`, but only \`APIInstance.custom_serializer=selector_serializer\` activates
it — so prefer plain types and \`cv.ensure_list\` if your integration must support older cores.

## Preferred pattern: expose your intents

This mirrors \`homeassistant/components/light/llm.py\`.

\`\`\`python
from homeassistant.components.homeassistant import async_should_expose
from homeassistant.components.llm import LLMTools
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import intent
from homeassistant.helpers.llm import LLM_API_ASSIST, IntentTool, LLMContext, Tool

from .const import DOMAIN
from .intent import INTENT_DO_SOMETHING

# Intents owned by this integration that are exposed as LLM tools.
LLM_INTENTS = (INTENT_DO_SOMETHING,)


@callback
def async_get_tools(
    hass: HomeAssistant, llm_context: LLMContext, api_id: str
) -> LLMTools | None:
    """Return LLM tools for the integration's intents when its domain is exposed."""
    if api_id != LLM_API_ASSIST:
        return None

    if not llm_context.assistant:
        return None

    if not any(
        async_should_expose(hass, llm_context.assistant, state.entity_id)
        for state in hass.states.async_all(DOMAIN)
    ):
        return None

    tools: list[Tool] = [
        IntentTool(
            f"{DOMAIN}__{handler.intent_type}",
            handler,
            integration=DOMAIN,
        )
        for handler in intent.async_get(hass)
        if handler.intent_type in LLM_INTENTS
    ]
    return LLMTools(tools=tools)
\`\`\`

## Hand-written tool

Use this when the behavior does not map to an intent. Modeled on
\`homeassistant/components/llm/llm.py\`.

\`\`\`python
from __future__ import annotations

from typing import override

import probatio

from homeassistant.components.llm import LLMTools
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.llm import (
    LLM_API_ASSIST, LLMContext, Tool, ToolAnnotations, ToolInput, ToolResult,
)
from homeassistant.util.json import JsonObjectType


class ${toolClass}(Tool):
    """Example read-only LLM tool for ${domain}."""

    name = "${domain}__example_status"
    title = "Get ${domain} status"
    integration = "${domain}"
    description = "Return a concise ${domain} status summary."
    annotations = ToolAnnotations(
        read_only=True, destructive=False, idempotent=True, open_world=False
    )
    parameters = probatio.Schema({
        probatio.Optional("include_details"): bool,
    })

    @override
    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> ToolResult:
        """Call the tool."""
        if "${domain}" not in hass.data:
            raise HomeAssistantError("${domain} is not loaded")

        result: JsonObjectType = {"success": True, "result": "${domain} is ready"}
        if tool_input.tool_args.get("include_details"):
            result["details"] = {
                "language": llm_context.language,
                "device_id": llm_context.device_id,
            }
        return ToolResult(data=result)


@callback
def async_get_tools(
    hass: HomeAssistant,
    llm_context: LLMContext,
    api_id: str,
) -> LLMTools | None:
    """Return tools to expose to the LLM for this request."""
    if api_id != LLM_API_ASSIST:
        return None

    return LLMTools(
        tools=[${toolClass}()],
        prompt="Use ${domain}__example_status only when the user asks about ${domain} status.",
    )
\`\`\`

Full custom API notes:
- Use \`<integration>/llm.py\` with \`async_get_tools(...)\` when your integration contributes tools to an existing API such as \`assist\`.
- Create and register a custom \`llm.API\` only when your integration owns a distinct LLM API surface.
- Implement \`async_get_api_instance(self, llm_context) -> APIInstance\`; do not implement API-level \`async_get_tools\`.
- Instantiate \`llm.API\` with keyword arguments, including the required \`hass\`, \`id\`, and \`name\` fields.
- The registered API ID becomes its native MCP endpoint: \`/api/mcp/<API ID>\`.
- Set \`APIInstance.custom_serializer\` if your tool schemas need custom conversion for selectors or
  other probatio shapes. \`homeassistant.helpers.llm.selector_serializer\` is the one Assist uses.

Minimal custom API sketch:

\`\`\`python
from typing import override

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import llm
from homeassistant.helpers.llm import APIInstance, LLMContext, selector_serializer


class ${apiClass}(llm.API):
    """Custom ${domain} LLM API."""

    @override
    async def async_get_api_instance(self, llm_context: LLMContext) -> APIInstance:
        """Return the API instance for this request."""
        return APIInstance(
            api=self,
            api_prompt="Use these tools for ${domain}-specific requests.",
            llm_context=llm_context,
            tools=[${toolClass}()],
            custom_serializer=selector_serializer,
        )


async def async_setup_api(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Register the ${domain} LLM API."""
    unregister = llm.async_register_api(
        hass,
        ${apiClass}(
            hass=hass,
            id=f"${domain}-{entry.entry_id}",
            name=entry.title,
        ),
    )
    entry.async_on_unload(unregister)
\`\`\`

## Recent upstream changes to be aware of

- Tools use domain-prefixed names such as \`homeassistant__GetLiveContext\`; discover names instead
  of hard-coding old unprefixed names in prompts. The tool provider supplies the prefixed name.
- In 2026.10, custom tools missing \`integration\` produce a warning and will stop working in 2027.10.
  Returning plain dicts instead of \`ToolResult\` warns and will stop working in 2027.11.
- HA's MCP Server accepts \`params._meta["io.home-assistant/device_id"]\` for device context.
  It is context, not authentication; take it from a trusted caller, never guessed model text.
- A native conversation provider implements \`ConversationEntity._async_handle_message\` and uses
  \`ChatLog.async_provide_llm_data\` with user-selected \`CONF_LLM_HASS_API\` options. MCP discovery
  alone does not register OpenCode as a conversation agent.
- \`homeassistant/helpers/llm.py\` was roughly halved by home-assistant/core#176082 once the Assist
  API moved into the \`llm\` integration. Older blog posts and snippets that reach into its internals
  are stale.
- \`async_render_no_api_prompt\` is deprecated (home-assistant/core#176111).
- \`LLMContext.assistant\` is now a required, non-optional field (home-assistant/core#175553).
- Script tool aliasing moved into the \`script\` integration (home-assistant/core#176114).
`;
}
