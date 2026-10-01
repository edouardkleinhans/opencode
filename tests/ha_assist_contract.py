"""Run inside the pinned HA image; uses actual HA classes and no live HA instance."""

import asyncio
import json
import os
import tempfile
import unittest
from types import MappingProxyType, SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
import probatio
from homeassistant.components import conversation, ai_task
from homeassistant.config_entries import ConfigSubentry, ConfigEntryState
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm

from custom_components.opencode_assist.client import AssistClient, AssistAuthError
from custom_components.opencode_assist.config_flow import OpenCodeFlow, OpenCodeSubentryFlow
from custom_components.opencode_assist.conversation import OpenCodeConversation
from custom_components.opencode_assist.ai_task import OpenCodeTask
from custom_components.opencode_assist.entity import history_payload
from custom_components.opencode_assist import async_unload_entry, async_remove_entry
from custom_components.opencode_assist.diagnostics import async_get_config_entry_diagnostics


class FixtureTool(llm.Tool):
    name = "FixtureRead"
    description = "Read the fixture using HA's trusted context"
    parameters = probatio.Schema({probatio.Required("name"): str})

    def __init__(self, calls):
        self.calls = calls

    async def async_call(self, hass, tool_input, llm_context):
        self.parameters(tool_input.tool_args)
        self.calls.append((tool_input.tool_args, llm_context))
        return llm.ToolResult(data={"answer": "from HA"}, error=False)


class FixtureAPI(llm.API):
    async def async_get_api_instance(self, llm_context):
        raise NotImplementedError


class ContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.hass = HomeAssistant(self.temp.name)
        self.client = SimpleNamespace(info=AsyncMock(return_value={"version": 1, "models": [{"providerID": "fixture", "id": "coding", "name": "Fixture", "tools": True}]}), result=AsyncMock(), close=AsyncMock())
        self.entry = SimpleNamespace(runtime_data=SimpleNamespace(client=self.client, info={"version": 1, "conversation": True, "generate_data": True}), subentries={}, async_start_reauth=AsyncMock())

    async def asyncTearDown(self):
        await self.hass.async_stop()
        self.temp.cleanup()

    def entity(self, cls=OpenCodeConversation):
        subentry = ConfigSubentry(data=MappingProxyType({"model": "fixture/coding"}), subentry_type="conversation" if cls is OpenCodeConversation else "ai_task_data", title="Fixture", unique_id=None)
        self.entry.subentries[subentry.subentry_id] = subentry
        entity = cls(self.entry, subentry)
        entity.hass = self.hass
        entity.entity_id = "conversation.fixture" if cls is OpenCodeConversation else "ai_task.fixture"
        return entity

    def log(self, tools=False):
        log = conversation.ChatLog(self.hass, "fixture-conversation", content=[conversation.SystemContent("Only HA's system prompt"), conversation.UserContent("Fixture question")])
        calls = []
        if tools:
            context = llm.LLMContext(platform="opencode_assist", context=Context(user_id="trusted-user"), language="en", assistant="conversation", device_id="trusted-device")
            log.llm_api = llm.APIInstance(FixtureAPI(hass=self.hass, id="fixture", name="Fixture"), "Only selected tools", context, [FixtureTool(calls)])
        return log, calls

    async def test_actual_chatlog_executes_tool_with_original_context(self):
        entity = self.entity()
        log, calls = self.log(tools=True)
        async def stream(payload):
            self.assertEqual([tool["name"] for tool in payload["tools"]], ["FixtureRead"])
            self.assertEqual(payload["system"], "Only HA's system prompt")
            yield {"type": "request", "id": "a" * 36}
            yield {"type": "text", "text": "Checking "}
            yield {"type": "tool_call", "id": "call1", "name": "FixtureRead", "arguments": {"name": "Fixture"}}
            self.client.result.assert_awaited_once_with("a" * 36, "call1", {"data": {"answer": "from HA"}, "error": False})
            yield {"type": "text", "text": "Finished"}
            yield {"type": "done"}
        self.client.stream = stream
        await asyncio.wait_for(entity.async_run_chat(log), 5)
        self.assertEqual(calls[0][0], {"name": "Fixture"})
        self.assertEqual(calls[0][1].context.user_id, "trusted-user")
        self.assertEqual(calls[0][1].device_id, "trusted-device")
        self.assertEqual(log.content[-1].content, "Finished")
        _, messages = history_payload(log)
        self.assertEqual(messages[2]["role"], "tool")
        self.assertEqual(messages[2]["content"][0]["result"], {"type": "json", "value": {"answer": "from HA"}})

    async def test_unselected_tool_fails_and_closes_stream(self):
        entity = self.entity()
        log, _ = self.log()
        closed = asyncio.Event()
        async def stream(payload):
            try:
                yield {"type": "request", "id": "a" * 36}
                yield {"type": "tool_call", "id": "call1", "name": "NotSelected", "arguments": {}}
            finally:
                closed.set()
        self.client.stream = stream
        with self.assertRaises(HomeAssistantError):
            await entity.async_run_chat(log)
        self.assertTrue(closed.is_set())
        self.client.result.assert_not_awaited()

    async def test_structured_data_is_validated(self):
        entity = self.entity(OpenCodeTask)
        task = ai_task.GenDataTask("fixture", "Return data", structure=probatio.Schema({probatio.Required("count"): int}))
        for answer, valid in [("{\"count\":3}", True), ("{\"count\":\"bad\"}", False), ("not json", False)]:
            log, _ = self.log()
            async def stream(payload):
                self.assertIn("count", payload["system"])
                yield {"type": "request", "id": "a" * 36}
                yield {"type": "text", "text": answer}
                yield {"type": "done"}
            self.client.stream = stream
            if valid:
                result = await entity._async_generate_data(task, log)
                self.assertEqual(result.data, {"count": 3})
            else:
                with self.assertRaises(HomeAssistantError):
                    await entity._async_generate_data(task, log)

    async def test_connection_flow_and_subentry_schema(self):
        flow = OpenCodeFlow()
        flow.hass = self.hass
        self.assertEqual((await flow.async_step_user())["type"], "form")
        with patch("custom_components.opencode_assist.config_flow.async_get_clientsession", return_value=None), patch("custom_components.opencode_assist.config_flow.AssistClient", return_value=self.client), patch.object(flow, "_async_current_entries", return_value=[]):
            result = await flow.async_step_user({"url": "http://fixture:8768/", "api_key": "fixture-only"})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(result["data"]["url"], "http://fixture:8768")
        self.entry.state = ConfigEntryState.LOADED
        subflow = OpenCodeSubentryFlow()
        subflow.hass = self.hass
        subflow.handler = ("fixture", "conversation")
        subflow.context = {"source": "user"}
        with patch.object(subflow, "_get_entry", return_value=self.entry), patch("custom_components.opencode_assist.config_flow.llm.async_get_apis", return_value=[SimpleNamespace(id="assist", name="Assist")]):
            form = await subflow.async_step_user()
            values = form["data_schema"]({"model": "fixture/coding"})
            self.assertEqual(values["llm_hass_api"], [])
            invalid = await subflow.async_step_user({"model": "fixture/coding", "llm_hass_api": ["removed-api"]})
            self.assertEqual(invalid["errors"]["base"], "unknown_api")
            created = await subflow.async_step_user({"model": "fixture/coding", "llm_hass_api": ["assist"]})
            self.assertEqual(created["type"], "create_entry")

    async def test_unload_and_redacted_diagnostics(self):
        self.entity()
        hass = SimpleNamespace(config_entries=SimpleNamespace(async_unload_platforms=AsyncMock(return_value=True)))
        self.assertTrue(await async_unload_entry(hass, self.entry))
        self.client.close.assert_awaited_once()
        self.entry.data = {"url": "http://private-address", "api_key": "secret-value"}
        output = json.dumps(await async_get_config_entry_diagnostics(hass, self.entry))
        self.assertNotIn("secret-value", output)
        self.assertNotIn("private-address", output)
        self.client.revoke = AsyncMock()
        with patch("custom_components.opencode_assist.async_get_clientsession", return_value=None), patch("custom_components.opencode_assist.AssistClient", return_value=self.client):
            await async_remove_entry(hass, self.entry)
        self.client.revoke.assert_awaited_once()

    @unittest.skipUnless(os.environ.get("ASSIST_FIXTURE_URL"), "Run scripts/test-ha-assist-core.mjs for pinned OpenCode + HA transport")
    async def test_real_opencode_transport_and_followup(self):
        async with aiohttp.ClientSession() as session:
            client = AssistClient(session, os.environ["ASSIST_FIXTURE_URL"], "fixture-only")
            info = await client.info()
            self.assertEqual(info["version"], 1)
            self.entry.runtime_data.client = client
            entity = self.entity()
            log, calls = self.log(tools=True)
            await asyncio.wait_for(entity.async_run_chat(log), 20)
            self.assertEqual(len(calls), 1)
            self.assertIn("from HA", log.content[-1].content)
            log.content.append(conversation.UserContent("Follow up"))
            await asyncio.wait_for(entity.async_run_chat(log), 20)
            self.assertEqual(len(calls), 1)
            self.assertIn("from HA", log.content[-1].content)
            pending_log, _ = self.log(tools=True)
            started = asyncio.Event()
            cancelled = asyncio.Event()
            class PendingTool(FixtureTool):
                async def async_call(self, hass, tool_input, llm_context):
                    started.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cancelled.set()
            pending_log.llm_api.tools = [PendingTool([])]
            pending = asyncio.create_task(entity.async_run_chat(pending_log))
            await asyncio.wait_for(started.wait(), 10)
            await client.close()
            self.assertTrue(pending.cancelled())
            self.assertTrue(cancelled.is_set())
            bad = AssistClient(session, os.environ["ASSIST_FIXTURE_URL"], "revoked")
            with self.assertRaises(AssistAuthError):
                await bad.info()


if __name__ == "__main__":
    unittest.main(verbosity=2)
