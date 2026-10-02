"""Home Assistant-owned conversations using the scoped OpenCode adapter."""

from dataclasses import dataclass
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_API_KEY, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import AssistAuthError, AssistClient
from .const import PLATFORMS


@dataclass
class RuntimeData:
    client: AssistClient
    info: dict


type OpenCodeConfigEntry = ConfigEntry[RuntimeData]


async def async_setup_entry(hass: HomeAssistant, entry: OpenCodeConfigEntry) -> bool:
    client = AssistClient(async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_API_KEY])
    try:
        info = await client.info()
    except AssistAuthError as err:
        raise ConfigEntryAuthFailed("Renew the OpenCode pairing credential") from err
    except HomeAssistantError as err:
        raise ConfigEntryNotReady("OpenCode Assist is unavailable") from err
    entry.runtime_data = RuntimeData(client, info)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def _async_reload(hass: HomeAssistant, entry: OpenCodeConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: OpenCodeConfigEntry) -> bool:
    await entry.runtime_data.client.close()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: OpenCodeConfigEntry) -> None:
    client = AssistClient(async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_API_KEY])
    try:
        await client.revoke()
    except HomeAssistantError:
        logging.getLogger(__name__).warning("Could not revoke the app-side pairing; revoke it on the app's Assist pairing page")
