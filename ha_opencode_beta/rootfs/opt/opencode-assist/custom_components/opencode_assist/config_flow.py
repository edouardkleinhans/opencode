"""UI setup, revocable pairing, reauthentication and per-entity options."""

import secrets

import probatio

from homeassistant.config_entries import ConfigFlow, ConfigSubentryFlow, ConfigEntryState, FlowType, SOURCE_USER
from homeassistant.const import CONF_API_KEY, CONF_LLM_HASS_API, CONF_MODEL, CONF_PROMPT, CONF_URL
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import SelectSelector, SelectSelectorConfig, TemplateSelector

from .client import AssistAuthError, AssistClient
from .const import DOMAIN
from .supervisor import async_discover_apps

CONF_ADDON_SLUG = "addon_slug"


class OpenCodeFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self):
        self._selected_slug = None
        self._auto_entry = None
        self._auto_key = None
        self._initial_subentry = "conversation"

    async def async_step_user(self, user_input=None):
        return await self.async_step_supervisor(user_input)

    async def async_step_supervisor(self, user_input=None):
        errors = {}
        try:
            apps = await async_discover_apps(self.hass)
        except HomeAssistantError:
            apps = []
            errors["base"] = "supervisor_unavailable"
        if not apps:
            errors.setdefault("base", "no_apps")
        if len(apps) == 1 and not user_input:
            return await self._select_app(apps[0])
        if user_input:
            app = next((item for item in apps if item.slug == user_input.get(CONF_ADDON_SLUG)), None)
            if app:
                return await self._select_app(app)
            errors["base"] = "no_apps"
        schema = probatio.Schema({probatio.Required(CONF_ADDON_SLUG): SelectSelector(SelectSelectorConfig(
            options=[{"value": app.slug, "label": app.name} for app in apps]))}) if apps else probatio.Schema({})
        return self.async_show_form(step_id="supervisor", data_schema=schema, errors=errors)

    async def async_step_hassio(self, discovery_info):
        # Re-read through Core's authenticated Supervisor client, not from a
        # caller-supplied config URL or a bootstrap stored in the flow context.
        try:
            apps = await async_discover_apps(self.hass)
        except HomeAssistantError:
            return self.async_abort(reason="supervisor_unavailable")
        app = next((item for item in apps if item.slug == discovery_info.slug), None)
        if not app:
            return self.async_abort(reason="no_apps")
        return await self._select_app(app)

    async def _select_app(self, app):
        unique_id = f"supervisor:{app.slug}"
        await self.async_set_unique_id(unique_id)
        if self._auto_entry is None:
            self._abort_if_unique_id_configured(updates={CONF_URL: app.url, CONF_ADDON_SLUG: app.slug})
        self._selected_slug = app.slug
        self.context["title_placeholders"] = {"name": app.name}
        self.context["configuration_url"] = f"homeassistant://hassio/addon/{app.slug}/info"
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                # Refresh expiring discovery data when the user submits, even if
                # the card was open across a Core/app restart or bootstrap expiry.
                apps = await async_discover_apps(self.hass)
                app = next((item for item in apps if item.slug == self._selected_slug), None)
                if app is None:
                    errors["base"] = "no_apps"
                else:
                    client = AssistClient(async_get_clientsession(self.hass), app.url, app.bootstrap)
                    info = await client.onboard()
                    if not info["models"]:
                        errors["base"] = "no_models"
                    else:
                        # Generate once per flow: retrying a lost response sends
                        # the same key. The app only stores its digest.
                        self._auto_key = self._auto_key or secrets.token_urlsafe(32)
                        await client.onboard(self._auto_key)
                        data = {CONF_URL: app.url, CONF_API_KEY: self._auto_key, CONF_ADDON_SLUG: app.slug}
                        if self._auto_entry is not None:
                            return self.async_update_and_abort(self._auto_entry, data={**self._auto_entry.data, **data})
                        self._initial_subentry = user_input.get("entity_type", "conversation")
                        return self.async_create_entry(title=app.name, data=data)
            except AssistAuthError:
                errors["base"] = "discovery_expired"
            except (HomeAssistantError, ValueError):
                errors["base"] = "cannot_connect"
        schema = probatio.Schema({}) if self._auto_entry else probatio.Schema({
            probatio.Required("entity_type", default="conversation"): SelectSelector(SelectSelectorConfig(options=[
                {"value": "conversation", "label": "Conversation agent"},
                {"value": "ai_task_data", "label": "AI data task"},
            ])),
        })
        return self.async_show_form(step_id="hassio_confirm", data_schema=schema, errors=errors)

    async def async_on_create_entry(self, result):
        entry = result["result"]
        if entry.state is ConfigEntryState.LOADED and self._initial_subentry in ("conversation", "ai_task_data"):
            subflow = await self.hass.config_entries.subentries.async_init(
                (entry.entry_id, self._initial_subentry), context={"source": SOURCE_USER})
            if subflow["type"] is FlowResultType.FORM:
                result["next_flow"] = (FlowType.CONFIG_SUBENTRIES_FLOW, subflow["flow_id"])
        return result

    async def async_step_reauth(self, entry_data):
        entry = self._get_reauth_entry()
        if entry.data.get(CONF_ADDON_SLUG):
            self._auto_entry = entry
            self._selected_slug = entry.data[CONF_ADDON_SLUG]
            return await self.async_step_hassio_confirm()
        return self.async_abort(reason="legacy_pairing")

    async def async_step_reconfigure(self, user_input=None):
        entry = self._get_reconfigure_entry()
        if entry.data.get(CONF_ADDON_SLUG):
            self._auto_entry = entry
            self._selected_slug = entry.data[CONF_ADDON_SLUG]
            return await self.async_step_hassio_confirm(user_input)
        return self.async_abort(reason="legacy_pairing")

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
