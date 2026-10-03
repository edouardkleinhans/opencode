#!/usr/bin/env python3
"""Native image fixture: import legacy session data without installing V1."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--binary", default="/usr/local/libexec/opencode-v2")
parser.add_argument("--version", required=True)
args = parser.parse_args()


def prepare(root, source):
    subprocess.run([
        "python3", "/usr/local/bin/opencode-v2-migrate.py", "prepare",
        "--root", str(root), "--source-data", str(source),
        "--v2-bin", args.binary, "--runtime-user", "opencode-v2",
        "--target-version", args.version, "--timeout", "60",
    ], check=True, capture_output=True, timeout=90)
    generation = (root / "current").read_text().strip()
    return root / "generations" / generation / "data/opencode/opencode.db"


with tempfile.TemporaryDirectory(prefix="v2-forward-fixture-") as temporary:
    root = Path(temporary)
    root.chmod(0o711)
    empty = root / "empty"
    empty.mkdir(mode=0o700)
    seed = prepare(root / "seed", empty)
    source = root / "legacy"
    source.mkdir(mode=0o700)
    database = source / "opencode.db"
    shutil.copyfile(seed, database)
    connection = sqlite3.connect(database)
    connection.executescript("""
      CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      DELETE FROM kv WHERE key = 'migration.v1-v2';
      DELETE FROM migration WHERE id = '20260805200742_import_legacy_credentials';
    """)
    session_id = "ses_forward_fixture"
    message_id = "msg_000000000040aaaaaaaaaaaaaa"
    connection.execute("INSERT INTO session (id,project_id,slug,directory,title,version,permission,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?)", (
        session_id, "global", "forward-fixture", "/homeassistant", "Forward fixture", "1",
        json.dumps([{"permission": "bash", "pattern": "*", "action": "deny"}]), 1, 1,
    ))
    connection.execute("INSERT INTO message VALUES (?,?,?,?,?)", (
        message_id, session_id, 1, 1,
        json.dumps({"role": "user", "time": {"created": 1}, "agent": "build", "model": {"providerID": "fixture", "modelID": "fixture"}}),
    ))
    connection.execute("INSERT INTO part VALUES (?,?,?,?,?,?)", (
        "prt_forward_fixture", message_id, session_id, 1, 1,
        json.dumps({"type": "text", "text": "Preserve this legacy conversation"}),
    ))
    connection.commit()
    connection.close()
    auth = source / "auth.json"
    auth.write_text('{"fixture":{"type":"api","key":"synthetic-legacy-credential"}}')
    auth.chmod(0o600)
    before = [hashlib.sha256(path.read_bytes()).digest() for path in (database, auth)]
    migrated = prepare(root / "target", source)
    assert before == [hashlib.sha256(path.read_bytes()).digest() for path in (database, auth)]
    with sqlite3.connect(migrated) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT count(*) FROM session_v2").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM session_message").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM credential").fetchone()[0] == 0
        permission = json.loads(connection.execute("SELECT permission FROM session_v2").fetchone()[0])
        assert permission == [{"action": "shell", "resource": "*", "effect": "deny"}]
    assert subprocess.run(["runuser", "-u", "opencode-v2", "--", "test", "-r", str(database)]).returncode != 0
    assert subprocess.run(["runuser", "-u", "opencode-v2", "--", "test", "-r", str(migrated)]).returncode == 0
    print("Forward migration passed: session/message/permissions preserved, legacy credentials excluded, input unchanged")
