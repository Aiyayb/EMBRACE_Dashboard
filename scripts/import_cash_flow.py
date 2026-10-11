"""Bring Best's fixed costs and expenses from the sheet "Cash Flow M." of `4. Fund Management.xlsx` into the Expense page.

    python scripts/import_cash_flow.py --dry-run     # show what would be added and check it against the sheet's totals
    python scripts/import_cash_flow.py               # write it

Each month is a block that starts at a date in column B. From it this reads
  * Fix cost: the house debt (column G, "Dept") and the Fix Expense lines (amounts in I, names in J)  -> section fixed_cost
  * Expense: the "Others" lines (amounts in T, names in U)                                            -> section expense
  * Income: the four sources in the block's CFO1 / CFO2 / CFO3 / CFI cells (columns C to F)  -> section income:
    Salary (Working), Online Shop (On The Wall), Trading, Stock dividend (Stock)
The split into Buckets is not imported. A line with no amount is skipped; two lines of the same name in one
month are added into one (the note keeps both amounts). The month's fixed cost total (H) and expense total (T) are checked
against what the sheet itself adds up, and nothing is written if any month disagrees. A line the dashboard already has for
that month is never changed. A backup of the database is made before writing.
"""
import argparse
import os
import shutil
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import config  # noqa: E402
import db  # noqa: E402

SHEET = "Cash Flow M."
HOUSE_LINE = "House debt"
INCOME_LINES = ("Salary", "Online Shop", "Trading", "Stock dividend")       # columns C, D, E, F of the block's income row


def amount(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def parse(ws):
    """{'YYYY-MM': {'lines': [(section, line, amount, note)], 'problems': [...]}} for every month block in the sheet."""
    out = {}
    starts = [r for r in range(1, ws.max_row + 1) if isinstance(ws.cell(r, 2).value, datetime)]
    for r in starts:
        d = ws.cell(r, 2).value
        month = f"{d.year}-{d.month:02d}"
        lines, problems = [], []
        for k, name in enumerate(INCOME_LINES):
            v = amount(ws.cell(r + 4, 3 + k).value)
            if v:
                lines.append(("income", name, v, None))
        house = amount(ws.cell(r + 5, 7).value)
        if house:
            lines.append(("fixed_cost", HOUSE_LINE, house, "Dept in the sheet"))
        row = r + 5
        while ws.cell(row, 10).value is not None:                       # Fix Expense lines: name in J, amount in I
            v = amount(ws.cell(row, 9).value)
            if v:
                lines.append(("fixed_cost", str(ws.cell(row, 10).value).strip(), v, None))
            row += 1
        fixed_total = amount(ws.cell(r + 13, 8).value)
        got = sum(a for s, _, a, _ in lines if s == "fixed_cost")
        if fixed_total is not None and abs(got - fixed_total) > 0.5:
            problems.append(f"fixed cost lines add to {got:,.2f}, the sheet says {fixed_total:,.2f}")
        spent = {}
        for row in range(r + 4, r + 13):                                  # Expense lines: amount in T, name in U
            v, name = amount(ws.cell(row, 20).value), ws.cell(row, 21).value
            if v and name is not None:
                spent.setdefault(str(name).strip(), []).append(v)
        for name, values in spent.items():
            lines.append(("expense", name, sum(values), " + ".join(f"{x:,.0f}" for x in values) if len(values) > 1 else None))
        expense_total = amount(ws.cell(r + 13, 20).value) or 0.0
        got = sum(a for s, _, a, _ in lines if s == "expense")
        if abs(got - expense_total) > 0.5:
            problems.append(f"expense lines add to {got:,.2f}, the sheet says {expense_total:,.2f}")
        out[month] = {"lines": lines, "problems": problems}
    return out


def main():
    cfg = config.load()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--workbook", default=cfg["fund_workbook_path"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    from openpyxl import load_workbook
    wb = load_workbook(args.workbook, data_only=True)
    months = parse(wb[SHEET])
    wb.close()
    bad = 0
    for month, m in sorted(months.items()):
        fixed = sum(a for s, _, a, _ in m["lines"] if s == "fixed_cost")
        spent = sum(a for s, _, a, _ in m["lines"] if s == "expense")
        earned = sum(a for s, _, a, _ in m["lines"] if s == "income")
        print(f"{month}  income {earned:>10,.2f}   fixed {fixed:>10,.2f}   expense {spent:>10,.2f}   {len(m['lines'])} lines" + (f"   MISMATCH: {'; '.join(m['problems'])}" if m["problems"] else ""))
        bad += bool(m["problems"])
    if bad:
        print("stopping: fix the disagreement first (nothing written)")
        sys.exit(1)

    conn = db.connect(cfg["db_path"])
    db.init(conn)
    have = {(r["month"], r["section"], r["line"]) for r in conn.execute("SELECT month, section, line FROM cashflow_lines")}
    new = [(month, s, line, a, note) for month, m in sorted(months.items()) for s, line, a, note in m["lines"] if (month, s, line) not in have]
    print(f"{len(new)} lines to add ({sum(len(m['lines']) for m in months.values()) - len(new)} already there)")
    if args.dry_run or not new:
        print("dry run: nothing written" if args.dry_run else "nothing to do")
        return
    os.makedirs(cfg["backup_dir"], exist_ok=True)
    conn.commit()
    keep = os.path.join(cfg["backup_dir"], f"dashboard-{datetime.now():%Y%m%d-%H%M%S}-pre-cashflow-import.db")
    shutil.copyfile(cfg["db_path"], keep)
    print("backup:", keep)
    for month, s, line, a, note in new:
        conn.execute("INSERT INTO cashflow_lines(month, section, line, amount_thb, note, entered_by, created_at) VALUES (?,?,?,?,?,?,?)",
                     (month, s, line, a, note, "import", db.now()))
    conn.commit()
    conn.close()
    print(f"wrote {len(new)} lines")


if __name__ == "__main__":
    main()
