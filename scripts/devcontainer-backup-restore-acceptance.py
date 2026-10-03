#!/usr/bin/env python3
"""Opt-in real Supervisor beta-app backup/restore with API-created test state.

Run in the official devcontainer. Does not modify HA configuration or databases.
Creates one synthetic session and one uniquely named app-data skill, backs up,
changes only those fixtures, restores the beta app, verifies and cleans them up.
The protected backup remains available as evidence/recovery.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

if os.environ.get("HA_BACKUP_RESTORE_ACCEPTANCE") != "1":
    raise SystemExit("Set HA_BACKUP_RESTORE_ACCEPTANCE=1 in the official devcontainer")
APP = "app_local_ha_opencode_beta"
SLUG = "local_ha_opencode_beta"


def command(*args, timeout=60):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    assert result.returncode == 0, f"Qualification command failed: {args[0]} ({result.returncode})"
    return result.stdout


def api(method, route, body=None):
    args = ["docker", "exec", APP, "opencode", "api", method, route]
    if body is not None:
        args.extend(["--data", json.dumps(body)])
    result = command(*args)
    return json.loads(result) if result.strip() else None


def options_digest():
    value = json.loads(command("ha", "--raw-json", "apps", "info", SLUG))["data"]["options"]
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


suffix = secrets.token_hex(6)
title = "HA backup restore qualification " + suffix
skill = "/data/.config/opencode/skills/ha-restore-" + suffix
permissions = [{"action": "shell", "resource": "*", "effect": "deny"}]
session_id = None
backup = None
stage = "capture state"
try:
    before_ids = {item["id"] for item in api("GET", "/api/session")["data"]}
    before_options = options_digest()
    created = api("POST", "/api/session", {"title": title, "permissions": permissions})
    session = created.get("data", created)
    session_id = session["id"]
    assert session_id.startswith("ses_")
    command("docker", "exec", APP, "python3", "-c", r'''
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.mkdir(mode=0o700)
(p / "SKILL.md").write_text("---\nname: " + p.name + "\ndescription: Synthetic backup qualification marker; never select for user work.\n---\nPreserve this custom skill across Supervisor restore.\n")
''', skill)
    stage = "create Supervisor backup"
    result = json.loads(command("ha", "--raw-json", "backups", "new", "--app", SLUG,
        "--name", "stable-promotion-restore-" + suffix, "--no-progress", timeout=180))
    backup = result["data"]["slug"]
    assert len(backup) == 8 and all(c in "0123456789abcdef" for c in backup)
    archive = Path("/mnt/supervisor/backup") / (backup + ".tar")
    assert archive.is_file() and archive.stat().st_size > 0
    archive.chmod(0o600)
    stage = "modify only synthetic fixtures"
    api("PATCH", "/api/session/" + session_id, {"title": "Changed after backup", "permissions": []})
    command("docker", "exec", APP, "rm", "--", skill + "/SKILL.md")
    stage = "restore Supervisor beta-app backup"
    command("ha", "backups", "restore", backup, "--app", SLUG, "--homeassistant=false", "--no-progress", timeout=240)
    stage = "verify restored state"
    for _ in range(60):
        try:
            restored = api("GET", "/api/session/" + session_id)
            restored = restored.get("data", restored)
            if restored.get("title") == title:
                break
        except (AssertionError, ValueError, subprocess.TimeoutExpired):
            pass
        time.sleep(1)
    else:
        raise AssertionError("Restored session was not available")
    assert restored["permissions"] == permissions
    ids = {item["id"] for item in api("GET", "/api/session")["data"]}
    assert before_ids <= ids
    assert options_digest() == before_options
    command("docker", "exec", APP, "python3", "-c", r'''
from pathlib import Path
import sys
p = Path(sys.argv[1]) / "SKILL.md"
assert "Preserve this custom skill across Supervisor restore." in p.read_text()
''', skill)
    print("Supervisor backup/restore passed: original sessions/options, restored synthetic session permissions and customized skill")
    print("Protected recovery archive: " + str(archive))
except Exception:
    print("Backup/restore qualification failed during " + stage)
    if backup:
        print("Recovery backup: " + backup)
    raise SystemExit(1) from None
finally:
    # Remove only this run's synthetic assets; never prune other sessions/files.
    if session_id:
        try:
            api("DELETE", "/api/session/" + session_id)
            command("docker", "exec", APP, "rm", "-f", "--", skill + "/SKILL.md")
            command("docker", "exec", APP, "rmdir", "--", skill)
            print("Removed synthetic qualification session and skill")
        except Exception:
            print("Fixture cleanup requires inspection: " + session_id + " / " + skill)
