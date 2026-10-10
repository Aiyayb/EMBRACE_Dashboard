"""Compare the imported history with the workbook's own quarterly totals.

    python scripts/reconcile.py

For every quarter in `Asset Allocation(Q)` it prints the Excel total beside the
dashboard's Total Portfolio Value for that quarter's last month. Exit code 1 if
any quarter differs by more than 1 THB. A difference is reported, never hidden:
it means two sheets of the workbook disagree, or a figure was entered since.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
import db  # noqa: E402
import metrics  # noqa: E402
from import_fund_management import parse  # noqa: E402

TOLERANCE = 1.0


def compare(conn, parsed):
    by_month = {m["month"]: m for m in metrics.monthly(conn)}
    out = []
    for q in parsed["quarters"]:
        m = by_month.get(q["as_of"][:7])
        ours = m["total"] if m else None
        diff = None if ours is None else round(ours - q["total"], 2)
        stock_diff = None if m is None or q["stock"] is None else round(m["investment"] - q["stock"], 2)
        out.append({"label": q["label"], "excel": q["total"], "dashboard": ours, "diff": diff,
                    "stock_diff": stock_diff, "ok": diff is not None and abs(diff) <= TOLERANCE})
    return out


def main():
    cfg = config.load()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--workbook", default=cfg["fund_workbook_path"])
    args = ap.parse_args()
    conn = db.connect(cfg["db_path"])
    db.init(conn)
    result = compare(conn, parse(args.workbook))
    conn.close()

    fmt = lambda v: "-" if v is None else f"{v:,.2f}"  # noqa: E731
    print(f"{'quarter':<10} {'Excel total':>15} {'dashboard':>15} {'diff':>13} {'of which stock':>15}")
    for r in result:
        flag = "" if r["ok"] else "   <-- MISMATCH"
        print(f"{r['label']:<10} {fmt(r['excel']):>15} {fmt(r['dashboard']):>15} {fmt(r['diff']):>13} "
              f"{fmt(r['stock_diff']):>15}{flag}")
    bad = [r for r in result if not r["ok"]]
    print(f"\n{len(result) - len(bad)} of {len(result)} quarters match within {TOLERANCE:.0f} THB.")
    if bad:
        print("Mismatched:", ", ".join(r["label"] for r in bad))
        sys.exit(1)


if __name__ == "__main__":
    main()
