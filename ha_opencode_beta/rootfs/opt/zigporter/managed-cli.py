"""Image-pinned CLI bootstrap for HA's environment-authenticated deployment."""
import os
import sys
from importlib.metadata import version

if version("zigporter") != "1.4.2":
    sys.exit("Unsupported zigporter runtime; rebuild the app with its certified pin.")

from zigporter import main
from zigporter import config
from zigporter.commands import check
import typer
import httpx
from zigporter.models import CheckResult, CheckStatus


def ensure_managed_config():
    # The stock bootstrap checks file existence before reading the documented
    # HA_URL/HA_TOKEN environment. Never ask an agent to write a credential file.
    if os.environ.get("HA_URL") and os.environ.get("HA_TOKEN"):
        return
    print("Home Assistant credentials are unavailable in this shell. Use the "
          "zigporter_run MCP tool; do not run setup or create a credential file.", file=sys.stderr)
    raise typer.Exit(code=1)


def environment_only():
    # Managed invocations use explicit service environment, never a user-writable
    # working-directory .env that could redirect credential-bearing requests.
    return None


async def check_z2m_without_ha_token(ha_url, token, z2m_url, verify_ssl):
    # Upstream always constructs a Bearer header, even for an empty token.
    # Z2M is a separate service: this checks reachability, not authentication.
    if not z2m_url:
        return CheckResult(name="Z2M running", status=CheckStatus.SKIPPED,
                           message="Skipped (no Z2M_URL configured)")
    try:
        async with httpx.AsyncClient(verify=verify_ssl, timeout=10) as client:
            response = await client.get(f"{z2m_url}/api/devices")
            if response.status_code >= 500:
                response.raise_for_status()
        return CheckResult(name="Z2M running", status=CheckStatus.OK,
                           message="Z2M is responding (authentication not checked)")
    except (httpx.HTTPError, OSError, RuntimeError) as exc:
        return CheckResult(name="Z2M running", status=CheckStatus.FAILED,
                           message=f"Cannot reach Zigbee2MQTT — {exc}")


main._ensure_config = ensure_managed_config
config._load_env = environment_only
check._check_z2m_running = check_z2m_without_ha_token
main.app()
