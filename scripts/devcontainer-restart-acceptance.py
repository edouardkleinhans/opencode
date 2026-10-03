#!/usr/bin/env python3
"""Opt-in beta restart/session-resume qualification in the official devcontainer.

Creates one disposable free-model session and one custom skill, restarts only the
beta app via Supervisor, verifies persistence and a resumed model reply, and
removes its own fixtures. Prints no credentials or pre-existing conversations.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

if os.environ.get("HA_RESTART_ACCEPTANCE") != "1":
    raise SystemExit("Set HA_RESTART_ACCEPTANCE=1 in the official devcontainer")
APP = "app_local_ha_opencode_beta"
SLUG = "local_ha_opencode_beta"


def command(*args, timeout=60):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    assert result.returncode == 0, f"Qualification command failed: {args[0]} (exit {result.returncode})"
    return result.stdout


def api(method, route, body=None):
    args = ["docker", "exec", APP, "opencode", "api", method, route]
    if body is not None:
        args.extend(["--data", json.dumps(body)])
    output = command(*args)
    return json.loads(output) if output.strip() else None


def reply(session_id, marker):
    api("POST", "/api/session/" + session_id + "/prompt", {
        "text": "Reply only with " + marker + ". Do not use tools or change any files.", "resume": True})
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        messages = api("GET", "/api/session/" + session_id + "/message")["data"]
        for message in messages:
            if message.get("type") == "assistant" and message.get("error"):
                known_free_rejection = "OpenCode's free tier can only be used from within OpenCode" in json.dumps(message["error"])
                raise AssertionError("Free tier rejected the customized request" if known_free_rejection else "Provider returned an error in the synthetic session")
            if message.get("type") == "assistant" and any(
                part.get("type") == "text" and marker in part.get("text", "")
                for part in message.get("content", [])
            ):
                return message["id"]
        time.sleep(0.5)
    raise AssertionError("Free-model reply was not available before the deadline")


suffix = secrets.token_hex(6)
skill = "/data/.config/opencode/skills/ha-restart-" + suffix
title = "HA restart qualification " + suffix
permissions = [{"action": "shell", "resource": "*", "effect": "deny"}]
root = Path("/var/tmp/ha-candidate")
root.mkdir(mode=0o700, exist_ok=True)
checkpoint = root / ("restart-" + suffix + ".json")
session_id = None
skill_created = False
stage = "identify candidate"
try:
    image = command("docker", "inspect", "--format", "{{.Image}}", APP).strip()
    before = command("docker", "inspect", "--format", "{{.State.StartedAt}}", APP).strip()
    options = json.loads(command("ha", "--raw-json", "apps", "info", SLUG))["data"]["options"]
    options_hash = hashlib.sha256(json.dumps(options, sort_keys=True).encode()).hexdigest()
    stage = "create synthetic session and custom skill"
    session_id = api("POST", "/api/session", {"title": title, "agent": "build",
        "location": {"directory": "/run/opencode-v2/workspace"},
        "model": {"providerID": "opencode", "id": "big-pickle"}})["data"]["id"]
    assert session_id.startswith("ses_")
    command("docker", "exec", APP, "python3", "-c", r'''
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.mkdir(mode=0o755)
(p / "SKILL.md").write_text("---\nname: " + p.name + "\ndescription: Synthetic restart qualification marker; never select for ordinary user work.\n---\n\n# Restart qualification\n\nPreserve this custom skill across Supervisor restart.\n")
''', skill)
    skill_created = True
    stage = "initial free-model reply"
    message_id = reply(session_id, "HA_BEFORE_RESTART_" + suffix)
    # Free-tier requests reject customized session permissions. Test persistence
    # while idle, then restore the synthetic session's defaults before resuming.
    api("PATCH", "/api/session/" + session_id, {"permissions": permissions})
    with os.fdopen(os.open(checkpoint, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        json.dump({"image": image, "session_id": session_id, "message_id": message_id,
            "skill": skill, "permissions": permissions, "stage": "before restart"}, stream)
    print("CHECK: checkpoint saved to " + str(checkpoint), flush=True)
    stage = "Supervisor beta restart"
    command("ha", "apps", "restart", SLUG, "--no-progress", timeout=120)
    for _ in range(60):
        status = subprocess.run(["docker", "exec", APP, "opencode", "status"], capture_output=True, timeout=10)
        if status.returncode == 0:
            break
        time.sleep(0.5)
    else:
        raise AssertionError("Managed backend did not become ready")
    assert command("docker", "inspect", "--format", "{{.State.StartedAt}}", APP).strip() != before
    assert command("docker", "inspect", "--format", "{{.Image}}", APP).strip() == image
    stage = "persistence and managed reconnection"
    restored = api("GET", "/api/session/" + session_id)["data"]
    assert restored["title"] == title and restored["permissions"] == permissions
    assert any(item["id"] == message_id for item in api("GET", "/api/session/" + session_id + "/message")["data"])
    after_options = json.loads(command("ha", "--raw-json", "apps", "info", SLUG))["data"]["options"]
    assert hashlib.sha256(json.dumps(after_options, sort_keys=True).encode()).hexdigest() == options_hash
    command("docker", "exec", APP, "python3", "-c", r'''
from pathlib import Path
import sys
assert "Preserve this custom skill across Supervisor restart." in (Path(sys.argv[1]) / "SKILL.md").read_text()
''', skill)
    skills = api("GET", "/api/skill")["data"]
    skill_discovered = any(item.get("id") == "ha-restart-" + suffix for item in skills)
    if not skill_discovered:
        print("FAIL: custom skill file survived but the native skill catalog did not discover it", flush=True)
    command("docker", "exec", APP, "opencode-v2-self-test", "--quiet")
    command("docker", "exec", "-e", "HA_LSP_ACCEPTANCE=1", APP, "node", "/local_apps/opencode/scripts/devcontainer-lsp-acceptance.mjs")
    stage = "resumed free-model reply"
    api("PATCH", "/api/session/" + session_id, {"permissions": []})
    reply(session_id, "HA_AFTER_RESTART_" + suffix)
    print("PASS: Supervisor restart retained session/message/permissions, custom skill file and options; MCP/LSP reconnected and free-model session resumed")
    print("Qualified image: " + image)
    stage = "custom skill catalog verification"
    assert skill_discovered, "Custom-skill discovery remains an unresolved qualification failure"
except Exception as error:
    print("Restart acceptance failed during " + stage + " (" + type(error).__name__ + ")")
    if isinstance(error, AssertionError):
        print(str(error))  # Only this harness's fixed diagnostic strings.
    raise SystemExit(1) from None
finally:
    try:
        if session_id:
            api("DELETE", "/api/session/" + session_id)
        if skill_created:
            command("docker", "exec", APP, "rm", "--", skill + "/SKILL.md")
            command("docker", "exec", APP, "rmdir", "--", skill)
        if checkpoint.exists():
            checkpoint.unlink()
        print("Removed this run's synthetic session, skill and checkpoint")
    except Exception:
        print("Fixture cleanup needs inspection; checkpoint: " + str(checkpoint))
