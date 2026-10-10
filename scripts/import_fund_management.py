"""One-time import of history from `4. Fund Management.xlsx` (ADR 0001).

    python scripts/import_fund_management.py --dry-run
    python scripts/import_fund_management.py

The workbook's sheets are free-form blocks, so rows are found by what they
contain (a quarter label, a date) rather than by fixed row numbers. Re-running
only replaces rows this script wrote before (entered_by = 'import'); anything
entered in the dashboard is left alone. Run scripts/reconcile.py afterwards.
"""
import argparse
import os
import re
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import backup  # noqa: E402
import config  # noqa: E402
import db  # noqa: E402

QUARTER_END = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}
FLOW_ACCOUNTS = {"Stock": "Stocks", "Trading": "OKX Trading"}
GOAL_COLUMNS = {"OnTheWall": (8, None), "Stock": (10, "investment"), "Trading": (12, "trading"),
                "Saving": (14, "wealth"), "EMC": (16, "wealth")}


def num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def iso(v):
    return v.strftime("%Y-%m-%d")


def year_start(label):
    """'Year 2026' -> '2025-12-31': the row that opens a year holds the previous year-end market level."""
    m = re.match(r"^Year (\d{4})$", str(label or "").strip())
    return f"{int(m.group(1)) - 1}-12-31" if m else None


def parse(path):
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    out = {"stock": [], "trading": [], "quarters": [], "flows": [], "goals": [], "benchmarks": [], "warnings": []}

    # Stock Portfolio: G = date, H = SET, J = portfolio value. "Year 20xx" rows repeat the previous December,
    # so only their market level is taken, as the Benchmark's year-end point.
    for r in wb["Stock Portfolio"].iter_rows(min_row=2, max_col=10, values_only=True):
        when, set_index, value = r[6], num(r[7]), num(r[9])
        if year_start(when) and set_index:
            out["benchmarks"].append(("SET", year_start(when), set_index))
        if isinstance(when, datetime) and value:
            out["stock"].append({"as_of": iso(when), "value": value})
            if set_index:
                out["benchmarks"].append(("SET", iso(when), set_index))

    # Trading Portfolio: G = date, H = BTC, J = USDT, K = THB.
    for r in wb["Trading Portfolio"].iter_rows(min_row=2, max_col=11, values_only=True):
        when, btc, usdt, thb = r[6], num(r[7]), num(r[9]), num(r[10])
        if year_start(when) and btc:
            out["benchmarks"].append(("BTC", year_start(when), btc))
        if year_start(when) and usdt and thb:
            # the year-opening balance is the previous year-end balance; it overrides the quarterly
            # figure for that date (Best confirmed 8,250 THB for the end of 2025, not the 32,000 in Asset Allocation)
            out["trading"].append({"as_of": year_start(when), "usdt": usdt, "fx": thb / usdt, "thb": thb})
        if isinstance(when, datetime) and usdt and thb:
            out["trading"].append({"as_of": iso(when), "usdt": usdt, "fx": thb / usdt, "thb": thb})
            if btc:
                out["benchmarks"].append(("BTC", iso(when), btc))

    # Asset Allocation(Q): B = "Q3 - 2026", C = total, E = EMC, J = stock, L = Saving, N = Trading, P = Bot.
    for r in wb["Asset Allocation(Q)"].iter_rows(min_row=1, max_col=16, values_only=True):
        m = re.match(r"^Q([1-4]) - (\d{4})$", str(r[1] or "").strip())
        total = num(r[2])
        if m and total:
            out["quarters"].append({"label": r[1].strip(), "as_of": f"{m.group(2)}-{QUARTER_END[int(m.group(1))]}",
                                    "total": total, "emc": num(r[4]), "stock": num(r[9]), "saving": num(r[11]),
                                    "trading": num(r[13]), "bot": num(r[15])})

    # Fin Plan(Y): one row of month dates in H..S, then actual contributions per bucket underneath.
    plan = list(wb["Fin Plan(Y)"].iter_rows(min_row=1, max_col=19, values_only=True))
    last_stock_month = out["stock"][-1]["as_of"][:7] if out["stock"] else ""
    for i, r in enumerate(plan):
        dates = {c: r[c] for c in range(7, 19) if isinstance(r[c], datetime)}
        if len(dates) < 6:
            continue
        for under in plan[i + 1:i + 6]:
            label = str(under[5] or "").strip()
            amounts = {c: num(under[c]) for c in dates if num(under[c]) and iso(dates[c])[:7] <= last_stock_month}
            if label in FLOW_ACCOUNTS:
                out["flows"] += [{"account": FLOW_ACCOUNTS[label], "on_date": iso(dates[c]), "amount": a}
                                 for c, a in amounts.items()]
            elif label and amounts:
                out["warnings"].append(
                    f"Fin Plan(Y) lists {label} contributions totalling {sum(amounts.values()):,.0f} THB, not imported: "
                    f"the {label} balance in Asset Allocation(Q) does not move with them.")
        break

    # Fin Plan(Y) TARGET block: G = year, then a Plan column per bucket.
    for i, r in enumerate(plan):
        if str(r[2] or "").strip() == "TARGET":
            for g in plan[i + 2:i + 20]:
                if not isinstance(g[6], int):
                    break
                for name, (col, bucket) in GOAL_COLUMNS.items():
                    if num(g[col - 1]) is not None:
                        out["goals"].append({"year": g[6], "name": name, "bucket": bucket, "goal": num(g[col - 1])})
            break
    wb.close()

    first_trading = out["trading"][0]["as_of"][:7] if out["trading"] else "9999-99"
    for q in out["quarters"]:
        q["use_trading"] = q["as_of"][:7] < first_trading      # the Trading Portfolio sheet takes over from there
    return out


def apply(conn, parsed):
    ids = {a["name"]: a["id"] for a in conn.execute("SELECT id, name FROM accounts")}
    now = db.now()

    def snapshot(name, as_of, native, fx, thb):
        conn.execute(
            "INSERT INTO snapshots(account_id, as_of, value_native, fx_rate, value_thb, note, entered_by, created_at) "
            "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id, as_of) DO UPDATE SET value_native=excluded.value_native, "
            "fx_rate=excluded.fx_rate, value_thb=excluded.value_thb WHERE snapshots.entered_by='import'",
            (ids[name], as_of, native, fx, round(thb, 2), "Fund Management.xlsx", "import", now))

    conn.execute("DELETE FROM snapshots WHERE entered_by='import'")
    conn.execute("DELETE FROM flows WHERE entered_by='import'")
    for s in parsed["stock"]:
        snapshot("Stocks", s["as_of"], s["value"], 1.0, s["value"])
    for t in parsed["trading"]:
        snapshot("OKX Trading", t["as_of"], t["usdt"], t["fx"], t["thb"])
    for q in parsed["quarters"]:
        for name, key in (("EMC", "emc"), ("Saving", "saving"), ("Bot Trading", "bot")):
            if q[key] is not None:
                snapshot(name, q["as_of"], q[key], 1.0, q[key])
        if q["use_trading"] and q["trading"] is not None:
            # no USDT figure exists for these quarters; the THB value is kept as recorded
            snapshot("OKX Trading", q["as_of"], q["trading"], 1.0, q["trading"])
    for f in parsed["flows"]:
        conn.execute("INSERT INTO flows(account_id, on_date, amount_thb, kind, note, entered_by, created_at) "
                     "VALUES (?,?,?,?,?,?,?)",
                     (ids[f["account"]], f["on_date"], f["amount"], "deposit" if f["amount"] > 0 else "withdrawal",
                      "Fin Plan(Y) monthly contribution", "import", now))
    for name, as_of, value in parsed["benchmarks"]:
        conn.execute("INSERT INTO benchmarks(name, as_of, value) VALUES (?,?,?) "
                     "ON CONFLICT(name, as_of) DO UPDATE SET value=excluded.value", (name, as_of, value))
    for g in parsed["goals"]:
        conn.execute("INSERT INTO goals(year, name, bucket, goal_thb) VALUES (?,?,?,?) "
                     "ON CONFLICT(year, name) DO UPDATE SET bucket=excluded.bucket, goal_thb=excluded.goal_thb",
                     (g["year"], g["name"], g["bucket"], g["goal"]))
    if parsed["flows"] and not db.get_setting(conn, "flows_recorded_from"):
        db.set_setting(conn, "flows_recorded_from", min(f["on_date"] for f in parsed["flows"])[:7])
    conn.commit()


def main():
    cfg = config.load()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--workbook", default=cfg["fund_workbook_path"])
    ap.add_argument("--dry-run", action="store_true", help="show what would be imported, write nothing")
    args = ap.parse_args()

    parsed = parse(args.workbook)
    print(f"workbook: {args.workbook}")
    for key, label in (("stock", "Stocks monthly Snapshots"), ("trading", "OKX Trading monthly Snapshots"),
                       ("quarters", "quarters (EMC, Saving, Bot Trading, early Trading)"),
                       ("flows", "Flows"), ("benchmarks", "Benchmark points"), ("goals", "Goals")):
        print(f"  {label}: {len(parsed[key])}")
    if parsed["stock"]:
        print(f"  Stocks: {parsed['stock'][0]['as_of']} .. {parsed['stock'][-1]['as_of']}")
    for w in parsed["warnings"]:
        print("  WARNING:", w)
    if args.dry_run:
        print("dry run: nothing written")
        return
    conn = db.connect(cfg["db_path"])
    db.init(conn)
    if conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]:
        print("pre-import backup:", backup.make_backup(cfg["db_path"], cfg["backup_dir"], "preimport"))
    apply(conn, parsed)
    print("flows_recorded_from:", db.get_setting(conn, "flows_recorded_from") or "(not set)")
    conn.close()
    print("imported. Now run: python scripts/reconcile.py")


if __name__ == "__main__":
    main()
