"""Import the manual trade journal from `1.1 Trade Journal2.xlsx`.

    python scripts/import_trade_journal.py --dry-run
    python scripts/import_trade_journal.py

Reads the visible journal sheet. A trade is a row with a date in column B and a
pair in column E. The workbook is the source: the trades table is made to match it, so a
trade removed from the sheet is removed here too (the dashboard's Sync Excel button does the same).
Amounts stay in the journal's own currency (USDT).
"""
import argparse
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import config  # noqa: E402
import db  # noqa: E402
from sources.journal import DEFAULT_SHEET, mirror, parse  # noqa: E402


def main():
    cfg = config.load()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--workbook", default=cfg["journal_workbook_path"])
    ap.add_argument("--sheet", default=DEFAULT_SHEET)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    trades = parse(args.workbook, args.sheet)
    graded = [t for t in trades if t["outcome"]]
    print(f"{len(trades)} trades ({len(graded)} with an outcome), "
          f"{trades[0]['traded_on'] if trades else '-'} .. {trades[-1]['traded_on'] if trades else '-'}")
    print("  win {win}  loss {loss}  be {be}  pnl {pnl:,.2f}".format(
        win=sum(t["outcome"] == "win" for t in trades), loss=sum(t["outcome"] == "loss" for t in trades),
        be=sum(t["outcome"] == "be" for t in trades), pnl=sum(t["pnl"] or 0 for t in trades)))
    if args.dry_run:
        print("dry run: nothing written")
        return
    conn = db.connect(cfg["db_path"])
    db.init(conn)
    added, removed = mirror(conn, trades)
    print(f"{added} new, {removed} removed")
    conn.close()
    print("imported.")


if __name__ == "__main__":
    main()
