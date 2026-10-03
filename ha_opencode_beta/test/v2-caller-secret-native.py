"""Runs inside the native beta image with its actual one-shot credential broker.

Only fixture credentials are used. The authenticated process retains the secret;
fork/exec descendants cannot retrieve it, and an unrelated socket at FD 3 stays
open and unread across repeated native copies.
"""
import ctypes
import errno
import os
from pathlib import Path
import socket
import subprocess
import sys

LIBRARY = "/usr/local/lib/opencode-v2-non-dumpable.so"


def copier():
    library = ctypes.CDLL(LIBRARY)
    copy = library.opencode_v2_copy_caller_secret
    copy.argtypes = [ctypes.c_void_p, ctypes.c_int]
    copy.restype = ctypes.c_int
    return copy


def probe():
    copy = copier()
    buffer = ctypes.create_string_buffer(64)
    for _ in range(3):
        assert copy(buffer, 64) == 64
        assert buffer.raw == b"0" * 64
        ctypes.memset(buffer, 0, 64)
    assert copy(buffer, 63) == 0
    assert buffer.raw == b"\0" * 64
    assert "OPENCODE_V2_CREDENTIAL_SOCKET" not in os.environ
    assert "LD_PRELOAD" not in os.environ
    # No module may mistake this unrelated nonblocking socket for a secret pipe.
    try:
        os.read(3, 1)
        raise AssertionError("FD 3 should still be an idle socket")
    except BlockingIOError as error:
        assert error.errno == errno.EAGAIN
    child = os.fork()
    if child == 0:
        os._exit(0 if copy(buffer, 64) == 0 and buffer.raw == b"\0" * 64 else 1)
    assert os.waitpid(child, 0)[1] == 0
    # A fresh exec with the library but without a broker handoff has no secret.
    subprocess.run([sys.executable, __file__, "unseeded"],
                   env={"PATH": "/usr/bin:/bin", "LD_PRELOAD": LIBRARY}, check=True, timeout=10)
    print("V2 native caller credential ownership regression passed")


def launch(runtime_root):
    reader, peer = socket.socketpair()
    reader.setblocking(False)
    child = os.fork()
    if child == 0:
        fields = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
        identity = Path(runtime_root) / "v2.pid"
        identity.write_text(f"{os.getpid()} {fields[19]}\n")
        identity.chmod(0o600)
        peer.close()
        os.dup2(reader.fileno(), 3, inheritable=True)
        # dup2(fd, fd) is a no-op on Linux and can retain FD_CLOEXEC.
        os.set_inheritable(3, True)
        if reader.fileno() != 3:
            reader.close()
        os.execve(sys.executable, [sys.executable, __file__, "probe"], {
            "PATH": "/usr/bin:/bin", "LD_PRELOAD": LIBRARY,
            "OPENCODE_V2_CREDENTIAL_SOCKET": str(Path(runtime_root) / "credential.sock"),
        })
    reader.close()
    try:
        assert os.waitpid(child, 0)[1] == 0
        assert not (Path(runtime_root) / "v2.pid").exists(), "Broker handoff must stay one-shot"
        with socket.socket(socket.AF_UNIX) as denied:
            denied.settimeout(3)
            denied.connect(str(Path(runtime_root) / "credential.sock"))
            assert denied.recv(1) == b"", "An unregistered process received credentials"
    finally:
        peer.close()


if __name__ == "__main__":
    if sys.argv[1] == "probe":
        probe()
    elif sys.argv[1] == "unseeded":
        buffer = ctypes.create_string_buffer(64)
        assert copier()(buffer, 64) == 0 and buffer.raw == b"\0" * 64
    else:
        launch(sys.argv[1])
