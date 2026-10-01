"""Scoped add-on client. No OpenCode administrative API access."""

import asyncio
import json
from urllib.parse import urlsplit

import aiohttp
from homeassistant.exceptions import HomeAssistantError


class AssistAuthError(HomeAssistantError):
    """The pairing credential was rejected or revoked."""


class AssistClient:
    """Use HA's managed HTTP session and keep active streams cancellable."""

    def __init__(self, session: aiohttp.ClientSession, url: str, key: str) -> None:
        parsed = urlsplit(url)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")):
            raise ValueError("Invalid add-on URL")
        self.session = session
        self.url = url.rstrip("/")
        self._key = key
        self._active: set[asyncio.Task] = set()

    async def close(self) -> None:
        """Cancel requests without closing HA's shared HTTP session."""
        tasks = list(self._active)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def _request(self, method: str, path: str, **kwargs):
        return self.session.request(
            method, self.url + path, headers={"Authorization": f"Bearer {self._key}"},
            timeout=kwargs.pop("timeout", aiohttp.ClientTimeout(total=130, sock_read=130)),
            allow_redirects=False, **kwargs,
        )

    @staticmethod
    def _check(response) -> None:
        if response.status in (401, 403):
            raise AssistAuthError("OpenCode pairing must be renewed")
        if response.status != 200:
            raise HomeAssistantError("OpenCode Assist is unavailable")

    async def info(self) -> dict:
        try:
            async with self._request("GET", "/v1/info", timeout=aiohttp.ClientTimeout(total=10)) as response:
                self._check(response)
                data = await response.json()
                if data.get("version") != 1 or not isinstance(data.get("models"), list):
                    raise HomeAssistantError("Unsupported OpenCode Assist protocol")
                return data
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise HomeAssistantError("Cannot connect to OpenCode Assist") from err

    async def revoke(self) -> None:
        """Invalidate only this pairing when the HA entry is removed."""
        try:
            async with self._request("DELETE", "/v1/pairing", timeout=aiohttp.ClientTimeout(total=10)) as response:
                if response.status != 401:  # Already revoked is also success.
                    self._check(response)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HomeAssistantError("Cannot revoke the OpenCode pairing") from err

    async def stream(self, payload: dict):
        task = asyncio.current_task()
        self._active.add(task)
        complete = False
        try:
            async with self._request("POST", "/v1/requests", json=payload) as response:
                self._check(response)
                async for line in response.content:
                    if len(line) > 262144:
                        raise HomeAssistantError("OpenCode response exceeds the limit")
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise HomeAssistantError("Invalid OpenCode event")
                    if event.get("type") == "error":
                        raise HomeAssistantError("OpenCode generation failed")
                    yield event
                    if event.get("type") == "done":
                        complete = True
                        break
                if not complete:
                    raise HomeAssistantError("OpenCode stream ended unexpectedly")
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise HomeAssistantError("OpenCode stream failed") from err
        finally:
            self._active.discard(task)

    async def result(self, request_id: str, call_id: str, result: dict) -> None:
        if len(request_id) != 36 or any(c not in "0123456789abcdef-" for c in request_id):
            raise HomeAssistantError("Invalid OpenCode request identifier")
        try:
            async with self._request("POST", f"/v1/requests/{request_id}/results",
                                     json={"callID": call_id, "result": result}, timeout=aiohttp.ClientTimeout(total=10)) as response:
                self._check(response)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HomeAssistantError("OpenCode tool result delivery failed") from err
