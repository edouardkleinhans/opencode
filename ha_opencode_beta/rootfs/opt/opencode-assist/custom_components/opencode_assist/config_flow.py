"""UI setup, revocable pairing, reauthentication and per-entity options."""

import probatio

from homeassistant.config_entries import ConfigFlow, ConfigSubentryFlow, ConfigEntryState
from homeassistant.const import CONF_API_KEY, CONF_LLM_HASS_API, CONF_MODEL, CONF_PROMPT, CONF_URL
from homeassistant.core import callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import SelectSelector, SelectSelectorConfig, TextSelector, TextSelectorConfig, TextSelectorType, TemplateSelector

from .client import AssistAuthError, AssistClient
from .const import DOMAIN


def connection_schema(reauth=False):
    fields = {} if reauth else {probatio.Required(CONF_URL): TextSelector(TextSelectorConfig(type=TextSelectorType.URL))}
    fields[probatio.Required(CONF_API_KEY)] = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))
    return probatio.Schema(fields)


class OpenCodeFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def _connection(self, step, user_input=None):
        entry = self._get_reauth_entry() if step == "reauth_confirm" else self._get_reconfigure_entry() if step == "reconfigure" else None
        errors = {}
        if user_input is not None:
            url = (entry.data[CONF_URL] if step == "reauth_confirm" else user_input[CONF_URL]).strip().rstrip("/")
            key = user_input[CONF_API_KEY].strip()
            try:
                client = AssistClient(async_get_clientsession(self.hass), url, key)
                info = await client.info()
                if not info["models"]:
                    errors["base"] = "no_models"
            except AssistAuthError:
                errors["base"] = "invalid_auth"
            except (HomeAssistantError, ValueError):
                errors["base"] = "cannot_connect"
            if not errors:
                if any(existing.entry_id != (entry.entry_id if entry else None) and existing.data[CONF_URL] == url
                       for existing in self._async_current_entries()):
                    return self.async_abort(reason="already_configured")
                data = {CONF_URL: url, CONF_API_KEY: key}
                if entry:
                    return self.async_update_and_abort(entry, data=data)
                return self.async_create_entry(title="OpenCode Assist", data=data)
        return self.async_show_form(step_id=step, data_schema=connection_schema(step == "reauth_confirm"), errors=errors)

    async def async_step_user(self, user_input=None):
        return await self._connection("user", user_input)

    async def async_step_reauth(self, entry_data):
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input=None):
        return await self._connection("reauth_confirm", user_input)

    async def async_step_reconfigure(self, user_input=None):
        return await self._connection("reconfigure", user_input)

    @classmethod
    @callback
    def async_get_supported_subentry_types(cls, config_entry):
        return {"conversation": OpenCodeSubentryFlow, "ai_task_data": OpenCodeSubentryFlow}


class OpenCodeSubentryFlow(ConfigSubentryFlow):
    async def async_step_user(self, user_input=None):
        return await self._options(user_input)

    async def async_step_reconfigure(self, user_input=None):
        return await self._options(user_input)

    async def _options(self, user_input):
        entry = self._get_entry()
        if entry.state is not ConfigEntryState.LOADED:
            return self.async_abort(reason="entry_not_loaded")
        try:
            info = await entry.runtime_data.client.info()
        except AssistAuthError:
            entry.async_start_reauth(self.hass)
            return self.async_abort(reason="invalid_auth")
        except HomeAssistantError:
            return self.async_abort(reason="cannot_connect")
        models = {f"{m['providerID']}/{m['id']}": m for m in info["models"]}
        apis = {api.id: api.name for api in llm.async_get_apis(self.hass)}
        errors = {}
        if user_input is not None:
            selected = models.get(user_input[CONF_MODEL])
            chosen = user_input.get(CONF_LLM_HASS_API, [])
            if selected is None or (chosen and not selected["tools"]):
                errors["base"] = "unsupported_model"
            elif any(api not in apis for api in chosen):
                errors["base"] = "unknown_api"
            else:
                if self.source == "reconfigure":
                    return self.async_update_and_abort(entry, self._get_reconfigure_subentry(), data=user_input)
                return self.async_create_entry(title="OpenCode conversation" if self._subentry_type == "conversation" else "OpenCode AI task", data=user_input)
        defaults = self._get_reconfigure_subentry().data if self.source == "reconfigure" else {}
        fields = {probatio.Required(CONF_MODEL, description={"suggested_value": defaults.get(CONF_MODEL)}): SelectSelector(SelectSelectorConfig(
            options=[{"value": key, "label": f"{model['name']} ({key})"} for key, model in models.items()]))}
        if self._subentry_type == "conversation":
            fields[probatio.Optional(CONF_LLM_HASS_API, default=defaults.get(CONF_LLM_HASS_API, []))] = SelectSelector(SelectSelectorConfig(
                options=[{"value": key, "label": value} for key, value in apis.items()], multiple=True))
            fields[probatio.Optional(CONF_PROMPT, default=defaults.get(CONF_PROMPT, llm.DEFAULT_INSTRUCTIONS_PROMPT))] = TemplateSelector()
        return self.async_show_form(step_id="user" if self.source != "reconfigure" else "reconfigure", data_schema=probatio.Schema(fields), errors=errors)
