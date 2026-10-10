"""Audited writes (ADR 0002).

Every change made through the API goes through insert/update/delete here, which
record the Actor and the row before and after, so any change can be undone.
"""
import json

import db

# Tables that may be written through the API. Names are interpolated into SQL,
# so nothing outside this set is ever accepted.
TABLES = {"accounts", "snapshots", "flows", "goals", "upcoming_items", "projects", "advice_notes",
          "trades", "benchmarks", "cashflow_lines", "assets", "links", "shop_months"}


class AuditError(Exception):
    pass


def _check(table):
    if table not in TABLES:
        raise AuditError(f"table {table} is not writable")


def row(conn, table, row_id):
    _check(table)
    r = conn.execute(f"SELECT * FROM {table} WHERE id=?", (row_id,)).fetchone()
    return dict(r) if r else None


def _log(conn, actor, action, table, row_id, before, after):
    dump = lambda v: None if v is None else json.dumps(v, ensure_ascii=False)  # noqa: E731
    cur = conn.execute(
        "INSERT INTO audit_log(at, actor, action, tbl, row_id, before, after) VALUES (?,?,?,?,?,?,?)",
        (db.now(), actor, action, table, row_id, dump(before), dump(after)))
    return cur.lastrowid


def insert(conn, actor, table, values):
    _check(table)
    cols = list(values)
    cur = conn.execute(
        f"INSERT INTO {table}({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
        [values[c] for c in cols])
    row_id = cur.lastrowid
    return row_id, _log(conn, actor, "insert", table, row_id, None, row(conn, table, row_id))


def update(conn, actor, table, row_id, values):
    before = row(conn, table, row_id)
    if before is None:
        raise AuditError(f"{table} {row_id} not found")
    cols = [c for c in values if c != "id"]
    if cols:
        conn.execute(f"UPDATE {table} SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                     [values[c] for c in cols] + [row_id])
    return _log(conn, actor, "update", table, row_id, before, row(conn, table, row_id))


def delete(conn, actor, table, row_id):
    before = row(conn, table, row_id)
    if before is None:
        raise AuditError(f"{table} {row_id} not found")
    conn.execute(f"DELETE FROM {table} WHERE id=?", (row_id,))
    return _log(conn, actor, "delete", table, row_id, before, None)


def undo(conn, actor, audit_id):
    """Reverse one logged change. The reversal is itself logged, so it can be undone too."""
    e = conn.execute("SELECT * FROM audit_log WHERE id=?", (audit_id,)).fetchone()
    if e is None:
        raise AuditError(f"audit entry {audit_id} not found")
    if e["undone_by"]:
        raise AuditError(f"audit entry {audit_id} was already undone by entry {e['undone_by']}")
    table, row_id = e["tbl"], e["row_id"]
    if e["action"] == "insert":
        new_id = delete(conn, actor, table, row_id)
    elif e["action"] == "update":
        new_id = update(conn, actor, table, row_id, json.loads(e["before"]))
    else:
        before = json.loads(e["before"])
        if row(conn, table, row_id) is not None:
            raise AuditError(f"{table} {row_id} exists again; cannot restore the deleted row")
        cols = list(before)
        conn.execute(f"INSERT INTO {table}({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                     [before[c] for c in cols])
        new_id = _log(conn, actor, "insert", table, row_id, None, before)
    conn.execute("UPDATE audit_log SET undone_by=? WHERE id=?", (new_id, audit_id))
    return new_id
