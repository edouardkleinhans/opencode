"""Resolve app identity and expiring onboarding data through HA's Supervisor client."""

from dataclasses import dataclass
import re
import time

from aiohasupervisor import SupervisorError
from homeassistant.components.hassio.handler import get_supervisor_client
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.hassio import is_hassio

from .const import DOMAIN


@dataclass(repr=False)
class AppDiscovery:
    slug: str
    name: str
    url: str
    bootstrap: str
    expires_at: int


async def async_discover_apps(hass) -> list[AppDiscovery]:
    """Read only Supervisor-authenticated metadata; never use a supplied arbitrary URL."""
    if not is_hassio(hass):
        return []
    client = get_supervisor_client(hass)
    try:
        messages = await client.discovery.list()
        apps = []
        for message in messages:
            if message.service != DOMAIN:
                continue
            info = await client.addons.addon_info(message.addon)
            config = message.config
            if (not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", message.addon)
                    or not re.fullmatch(r"[a-zA-Z0-9-]{1,253}", info.hostname)
                    or config.get("version") != 1
                    or config.get("url") != f"http://{info.hostname}:8768"
                    or not isinstance(config.get("bootstrap"), str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{43}", config["bootstrap"])
                    or not isinstance(config.get("expires_at"), int)
                    or config["expires_at"] <= time.time() * 1000):
                continue
            apps.append(AppDiscovery(message.addon, info.name, config["url"], config["bootstrap"], config["expires_at"]))
        return apps
    except (SupervisorError, KeyError, TypeError, AttributeError, ValueError) as err:
        raise HomeAssistantError("Supervisor discovery is unavailable") from err
