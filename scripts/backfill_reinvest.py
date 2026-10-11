"""Turn the deposits and withdrawals already recorded for Stock, Trading and Bitcoin into Reinvest lines of the Cash flow log.

    python scripts/backfill_reinvest.py --dry-run     # show what would be added
    python scripts/backfill_reinvest.py               # write it

Each such Flow becomes the Reinvest line of its month (Stock, Trading or Saving Bitcoin; a withdrawal is a negative line) and
the line is linked to the Flow, so editing or deleting the line later keeps the two in step. An opening value is not a deposit and
is skipped. A Flow that is already linked, or that came from a Reinvest line, is skipped. When a month already has a line for that
destination, or has several Flows for it (a line holds one Flow), the Flow is left alone and listed. Safe to run again.
A backup of the database is made before writing.
"""
import argparse
import os
import shutil
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import config  # noqa: E402
import db  # noqa: E402

NOTE = "from Deposits and withdrawals"


def destination(acc):
    if acc["source"] != "manual":
        return None
    if acc["bucket"] in ("investment", "trading"):
        return "Stock" if acc["bucket"] == "investment" else "Trading"
    return "Saving Bitcoin" if acc["name"] in ("Bitcoin", "BTC") else None


def plan(conn):
    accounts = {a["id"]: a for a in conn.execute("SELECT * FROM accounts")}
    linked = {r["flow_id"] for r in conn.execute("SELECT flow_id FROM cashflow_lines WHERE flow_id IS NOT NULL")}
    taken = {(r["month"], r["line"]) for r in conn.execute("SELECT month, line FROM cashflow_lines WHERE section='allocation'")}
    groups, skipped = {}, []
    for f in conn.execute("SELECT * FROM flows ORDER BY on_date, id"):
        dest = destination(accounts[f["account_id"]])
        if dest is None or f["kind"] == "opening" or f["id"] in linked or (f["note"] or "").startswith("Cash flow log"):
            continue
        groups.setdefault((f["on_date"][:7], dest), []).append(f)
    add = []
    for (month, dest), flows in sorted(groups.items()):
        total = sum(f["amount_thb"] for f in flows)
        if (month, dest) in taken:
            skipped.append(f"{month} {dest}: a Reinvest line already exists, so the Flow of {total:,.0f} was not imported")
        elif len(flows) > 1:
            skipped.append(f"{month} {dest}: {len(flows)} Flows ({total:,.0f}) but a line holds one; left alone")
        else:
            add.append((month, dest, flows[0]["amount_thb"], flows[0]["id"]))
    return add, skipped


def main():
    cfg = config.load()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    conn = db.connect(cfg["db_path"])
    db.init(conn)
    add, skipped = plan(conn)
    for month, dest, amount, _ in add:
        print(f"{month}  Reinvest › {dest:<14} {amount:>12,.0f}")
    for line in skipped:
        print("skipped:", line)
    print(f"{len(add)} lines to add" + (f", {len(skipped)} skipped" if skipped else ""))
    if args.dry_run or not add:
        print("dry run: nothing written" if args.dry_run else "nothing to do")
        return
    os.makedirs(cfg["backup_dir"], exist_ok=True)
    conn.commit()
    keep = os.path.join(cfg["backup_dir"], f"dashboard-{datetime.now():%Y%m%d-%H%M%S}-pre-reinvest-backfill.db")
    shutil.copyfile(cfg["db_path"], keep)
    print("backup:", keep)
    for month, dest, amount, flow_id in add:
        conn.execute("INSERT INTO cashflow_lines(month, section, line, amount_thb, note, flow_id, entered_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
                     (month, "allocation", dest, amount, NOTE, flow_id, "import", db.now()))
    conn.commit()
    conn.close()
    print(f"wrote {len(add)} lines")


if __name__ == "__main__":
    main()
