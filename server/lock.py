"""Single-instance lock for a Drive-synced database (same guard as the shop app).

The lock file records which machine has the app open and a heartbeat. A second
instance refuses to start while the heartbeat is fresh; a stale lock (crash,
PC switched off) is taken over.
"""
import atexit
import json
import os
import socket
import threading
import time

STALE_SECONDS = 120
BEAT_SECONDS = 30


class LockHeld(Exception):
    pass


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _alive(pid):
    """Is this process still running on this machine?"""
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, int(pid))       # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return kernel32.GetLastError() == 5                      # access denied: it exists, under another user
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259                        # STILL_ACTIVE
    try:
        os.kill(int(pid), 0)
    except OSError:
        return False
    return True


class InstanceLock:
    def __init__(self, path):
        self.path = path
        self.me = {"host": socket.gethostname(), "pid": os.getpid()}
        self._stop = threading.Event()

    def acquire(self):
        existing = _read(self.path)
        if existing and (time.time() - existing.get("beat", 0)) < STALE_SECONDS:
            same_app = (existing.get("host"), existing.get("pid")) == (self.me["host"], self.me["pid"])
            # a lock left by a process that died on this same machine (window closed, crash) is taken over at once
            dead_here = existing.get("host") == self.me["host"] and not _alive(existing.get("pid") or 0)
            if not same_app and not dead_here:
                raise LockHeld(
                    f"แอปถูกเปิดอยู่แล้วที่เครื่อง {existing.get('host')} (pid {existing.get('pid')}) "
                    f"— ปิดเครื่องนั้นก่อน หรือรอ {STALE_SECONDS} วินาทีหลังมันปิดไป")
        self._beat()
        threading.Thread(target=self._loop, daemon=True).start()
        atexit.register(self.release)

    def _beat(self):
        _write(self.path, dict(self.me, beat=time.time()))

    def _loop(self):
        while not self._stop.wait(BEAT_SECONDS):
            try:
                self._beat()
            except OSError:
                pass

    def release(self):
        self._stop.set()
        cur = _read(self.path)
        if cur and (cur.get("host"), cur.get("pid")) == (self.me["host"], self.me["pid"]):
            try:
                os.remove(self.path)
            except OSError:
                pass
