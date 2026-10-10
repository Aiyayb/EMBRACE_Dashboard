import glob
import os
import sqlite3
from datetime import datetime

KEEP = 30


def make_backup(db_path, backup_dir, reason="auto"):
    """Consistent copy via SQLite's online backup API. Returns the new path."""
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(backup_dir, f"dashboard-{stamp}-{reason}.db")
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    _prune(backup_dir)
    return dest


def _prune(backup_dir):
    files = sorted(glob.glob(os.path.join(backup_dir, "dashboard-*.db")))
    for old in files[:-KEEP]:
        try:
            os.remove(old)
        except OSError:
            pass


def has_backup_today(backup_dir):
    today = datetime.now().strftime("%Y%m%d")
    return bool(glob.glob(os.path.join(backup_dir, f"dashboard-{today}-*.db")))
