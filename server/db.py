import json
import os
import sqlite3
from datetime import datetime

SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

GRADE_NOTES = {"A": "Follow Con · Exit Plan or Plus", "B": "Follow Con · Can’t Exit Plan", "C": "Not follow · Can’t Exit Plan"}

DEFAULT_SETTINGS = {
    "shop_dividend_split_onn": "0.6",     # the shop's dividend: ออน gets this share of the pool, เบส the rest
    "journal_start_balance": "980",      # the journal sheet's Start cell (USDT)
    "journal_start_date": "2026-01-01",   # the day the journal's Start balance was in the account; CAGR counts from here
    "journal_risk_pct": "0.1",           # Risk Per Trade, as a share of Net Balance
    # what each Grade means, as in the journal sheet (S23:S25); Best can edit these from the Trading page
    "journal_grade_notes": json.dumps(GRADE_NOTES, ensure_ascii=False),
    # Monthly Return is only stated from this month on; earlier months are "Flows unknown".
    "flows_recorded_from": "",
}

# (name, bucket, currency, counts_in_total, source, allocation)
DEFAULT_ACCOUNTS = [
    ("Stocks", "investment", "THB", 1, "manual", None),
    ("OKX Trading", "trading", "USDT", 1, "manual", None),
    ("Bot Trading", "trading", "THB", 1, "manual", None),
    ("OKX Spot Crypto", "wealth", "USDT", 1, "manual", "saving"),
    ("EMC", "wealth", "THB", 1, "manual", "emc"),
    ("Saving", "wealth", "THB", 1, "manual", "saving"),
    # the family's joint account: Counted as emergency cash; its balance comes from the ledger file
    ("Family Statement", "wealth", "THB", 1, "family_statement", "emc"),
]


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")   # not WAL: Drive-synced file (shop app ADR 0001)
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# journal columns added after the first version of the trades table
TRADE_COLUMNS = [("pic_setup", "TEXT"), ("poi", "TEXT"), ("signal", "TEXT"), ("divergence", "TEXT"), ("confirm", "TEXT"),
                 ("fib_time", "TEXT"), ("fib", "TEXT"), ("pic_entry", "TEXT"), ("exit_a", "TEXT"), ("pic_exit", "TEXT"),
                 ("rr", "REAL")]


def _columns(conn, table):
    return [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]


def init(conn):
    # benchmarks gained an id (so its rows can be audited); rebuild a table made before that
    old_benchmarks = bool(_columns(conn, "benchmarks")) and "id" not in _columns(conn, "benchmarks")
    if old_benchmarks:
        conn.execute("ALTER TABLE benchmarks RENAME TO benchmarks_old")
    if _columns(conn, "accounts") and "allocation" not in _columns(conn, "accounts"):
        conn.execute("ALTER TABLE accounts ADD COLUMN allocation TEXT")
        conn.execute("UPDATE accounts SET allocation = CASE WHEN name IN ('EMC', 'Family Statement') THEN 'emc' "
                     "ELSE 'saving' END WHERE bucket = 'wealth'")
    if _columns(conn, "trades"):
        have = _columns(conn, "trades")
        for col, kind in TRADE_COLUMNS:
            if col not in have:
                conn.execute(f"ALTER TABLE trades ADD COLUMN {col} {kind}")
    if _columns(conn, "snapshots") and "holdings" not in _columns(conn, "snapshots"):
        conn.execute("ALTER TABLE snapshots ADD COLUMN holdings TEXT")
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        conn.executescript(f.read())
    if old_benchmarks:
        conn.execute("INSERT INTO benchmarks(name, as_of, value) SELECT name, as_of, value FROM benchmarks_old")
        conn.execute("DROP TABLE benchmarks_old")
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
    if conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO accounts(name, bucket, currency, counts_in_total, source, allocation, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            [(*a, now()) for a in DEFAULT_ACCOUNTS])
    for name in ("Discord", "Telegram"):
        conn.execute("INSERT OR IGNORE INTO links(name, url, updated_at) VALUES (?, '', ?)", (name, now()))
    for name in ("Discord", "Telegram"):
        conn.execute("INSERT OR IGNORE INTO links(name, url, updated_at) VALUES (?, '', ?)", (name, now()))
    for name in ("Discord", "Telegram"):
        conn.execute("INSERT OR IGNORE INTO links(name, url, updated_at) VALUES (?, '', ?)", (name, now()))
    conn.commit()


def integrity_ok(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        conn.close()


def get_setting(conn, key):
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else DEFAULT_SETTINGS.get(key)


def set_setting(conn, key, value):
    conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
