"""Install the image's companion, preserving manual or locally edited copies.

Linux renameat2 publishes whole directories atomically, including upgrades. There
is deliberately no copy-in-place fallback and no network or HA restart operation.
"""

import argparse
import ctypes
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile


DOMAIN = "opencode_assist"
MARKER = ".opencode-assist-managed.json"
OWNER = "ha_opencode"
SOURCE = Path(__file__).resolve().parent / "custom_components" / DOMAIN


class InstallError(Exception):
    """Installation stopped without overwriting conflicting files."""

    def __init__(self, message, reason="installation_failed"):
        super().__init__(message)
        self.reason = reason


def directory(path):
    # Reject links at every path component, not just the destination leaf.
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise InstallError(f"Not an ordinary directory: {part}")
    return path


def read_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024:
            raise InstallError(f"Not a bounded ordinary file: {path}")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read(4 * 1024 * 1024 + 1)
    finally:
        os.close(fd)


def files_in(root, *, installed=False):
    directory(root)
    files = {}
    for current, dirs, names in os.walk(root, followlinks=False):
        for name in dirs:
            directory(Path(current) / name)
        for name in names:
            path = Path(current) / name
            relative = path.relative_to(root).as_posix()
            content = read_file(path)  # Even ignored Python caches must not be links.
            if installed and (relative == MARKER or ("__pycache__" in path.relative_to(root).parts and name.endswith(".pyc"))):
                continue
            files[relative] = content
    return files


def hashes(files):
    return {name: hashlib.sha256(content).hexdigest() for name, content in sorted(files.items())}


def managed(root):
    try:
        marker = json.loads(read_file(root / MARKER))
        if marker.get("owner") != OWNER or marker.get("format") != 1:
            raise ValueError()
        if not isinstance(marker.get("version"), str) or not isinstance(marker.get("installed_at"), str):
            raise ValueError()
        current = hashes(files_in(root, installed=True))
        if not current or marker.get("files") != current:
            raise InstallError("App-managed companion has local edits or extra files; preserving it", "modified")
        for path, dirs, _ in os.walk(root):
            for name in dirs:
                relative = (Path(path) / name).relative_to(root)
                if "__pycache__" not in relative.parts and not any(key.startswith(relative.as_posix() + "/") for key in current):
                    raise InstallError("App-managed companion has extra directories; preserving it", "modified")
        return marker
    except (FileNotFoundError, ValueError, TypeError, AttributeError) as error:
        raise InstallError("Existing companion is user-managed or has no valid ownership record; preserving it", "unmanaged") from error


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_rename(parent_fd, source, destination, flags):
    # RENAME_NOREPLACE=1 for first install; RENAME_EXCHANGE=2 for managed updates.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise InstallError("Atomic directory installation is not supported on this system")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(parent_fd, os.fsencode(source), parent_fd, os.fsencode(destination), flags) != 0:
        error = ctypes.get_errno()
        raise InstallError(f"Atomic companion installation failed: {os.strerror(error)}")


def install(config, source=SOURCE):
    config = directory(config)
    source = directory(source)
    contents = files_in(source)
    manifest = json.loads(contents["manifest.json"])
    if manifest.get("domain") != DOMAIN or not isinstance(manifest.get("version"), str) or not manifest["version"]:
        raise InstallError("Bundled companion manifest is invalid")
    if not {"__init__.py", "config_flow.py", "strings.json", "translations/en.json"} <= contents.keys() or MARKER in contents:
        raise InstallError("Bundled companion is incomplete or contains an ownership record")
    expected = hashes(contents)
    parent = config / "custom_components"
    try:
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)  # The service's private umask must not hide HA code.
    except FileExistsError:
        pass
    directory(parent)
    lock_fd = os.open(parent / ".opencode-assist-install.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(lock_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise InstallError("Unsafe companion install lock")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        target = parent / DOMAIN
        previous = None
        identity = None
        if os.path.lexists(target):
            directory(target)
            previous = managed(target)
            identity = target.stat()
            if previous["files"] == expected:
                return {"action": "unchanged", "version": manifest["version"], "installed_at": previous["installed_at"]}
        stage = Path(tempfile.mkdtemp(prefix=".opencode-assist-staging-", dir=parent))
        published = False
        try:
            for name, content in contents.items():
                path = stage / name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with path.open("xb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fchmod(stream.fileno(), 0o644)
                    os.fsync(stream.fileno())
            marker = {"owner": OWNER, "format": 1, "version": manifest["version"],
                      "installed_at": datetime.now(timezone.utc).isoformat(), "files": expected}
            with (stage / MARKER).open("x") as stream:
                json.dump(marker, stream, sort_keys=True)
                stream.flush()
                os.fchmod(stream.fileno(), 0o644)
                os.fsync(stream.fileno())
            stage.chmod(0o755)
            for current, _, _ in os.walk(stage, topdown=False):
                os.chmod(current, 0o755)
                sync_directory(current)
            if previous:
                now = target.stat(follow_symlinks=False)
                if (now.st_dev, now.st_ino) != (identity.st_dev, identity.st_ino) or managed(target) != previous:
                    raise InstallError("Companion changed during installation; preserving it")
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                atomic_rename(parent_fd, stage.name, DOMAIN, 2 if previous else 1)
                published = True
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
            return {"action": "updated" if previous else "installed", "version": manifest["version"], "installed_at": marker["installed_at"]}
        finally:
            # After exchange this is the verified old managed tree, never a
            # user-managed destination. A hard crash may leave a hidden stage.
            if stage.exists():
                try:
                    shutil.rmtree(stage)
                except OSError:
                    if not published:
                        raise
                    print("OpenCode Assist: installed, but old staging files need cleanup", file=sys.stderr)
    finally:
        os.close(lock_fd)


def status_file(path, result):
    parent = directory(path.parent)
    fd, temporary = tempfile.mkstemp(prefix=".ha-assist-status-", dir=parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(result, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/homeassistant"))
    parser.add_argument("--status-file", type=Path, default=Path("/run/ha-assist-install.json"))
    args = parser.parse_args()
    try:
        result = install(args.config)
        status_file(args.status_file, result)
        print(f"OpenCode Assist companion {result['version']}: {result['action']}", flush=True)
        print("Restart Home Assistant (Core), not only this app, after installing or updating the companion. "
              "If you already restarted HA after this installation, configure OpenCode Assist in Settings → Devices & services. "
              "HA is never restarted automatically.", flush=True)
    except (InstallError, OSError, ValueError, KeyError) as error:
        # The Ingress fallback can explain a blocked install without exposing raw
        # exception text or requiring the pairing worker to be running.
        try:
            status_file(args.status_file, {"action": "blocked", "reason": getattr(error, "reason", "installation_failed")})
        except OSError:
            print("OpenCode Assist: could not write installation status; check the app log", file=sys.stderr)
        print(f"OpenCode Assist installation stopped: {error}. Assist will not start. "
              "Check custom_components/opencode_assist; back up and move a manual/edited copy out of "
              "custom_components before retrying app management. Restart this app after resolving the problem.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
