"""Paths and per-machine config.

Data and backups default to folders next to this project, so the app finds them
whatever drive letter Google Drive has on the machine (E: vs G:). Per-machine
settings and the hashed agent tokens live outside Drive and outside git, in
%LOCALAPPDATA%/EmbraceDashboard/config.json.
"""
import json
import os

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(PROJECT_DIR, "web")
FINANCIAL_OS_DIR = os.path.dirname(PROJECT_DIR)
EMBRACE_OS_DIR = os.path.dirname(FINANCIAL_OS_DIR)

_DEFAULTS = {
    "port": 8770,
    "data_dir": os.path.join(PROJECT_DIR, "data"),
    "backup_dir": os.path.join(PROJECT_DIR, "backups"),
    "shop_db_path": os.path.join(EMBRACE_OS_DIR, "EMBRACE SHOP", "Inventory Management", "data", "inventory.db"),
    "family_xlsx_path": os.path.join(EMBRACE_OS_DIR, "Family Statement", "Family_Statement.xlsx"),
    "fund_workbook_path": os.path.join(FINANCIAL_OS_DIR, "4. Fund Management.xlsx"),
    "journal_workbook_path": os.path.join(FINANCIAL_OS_DIR, "1.1 Trade Journal2.xlsx"),
    "agent_tokens": [],               # [{"name": "maki", "sha256": "..."}], written by scripts/make_token.py
}


def local_config_path():
    override = os.environ.get("EMBRACE_DASHBOARD_CONFIG")
    if override:
        return override
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "EmbraceDashboard", "config.json")


def read_local():
    path = local_config_path()
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_local(data):
    path = local_config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load():
    cfg = dict(_DEFAULTS)
    cfg.update(read_local())
    cfg["db_path"] = os.path.join(cfg["data_dir"], "dashboard.db")
    cfg["lock_path"] = os.path.join(cfg["data_dir"], "dashboard.lock")
    return cfg
