"""Shop figures (ADR 0003): the monthly P&L is typed in the dashboard and kept in its own database. This module only reads
the shop app's old database, read-only: once, to copy its typed months in, and to compare typed revenue with synced orders.
Revenue is whole-shop sales before fees and cost of goods, so it is not profit and not Best's share.
"""
import os
import sqlite3

SHOP_NAME = "ONTHEWALL"     # the only shop in that database today


FIN_SECTIONS = ("revenue", "cogs", "sga", "tax")
ALL_SECTIONS = FIN_SECTIONS + ("dividend",)      # dividend holds one line, "Payout %", typed as a percentage (38 = 38%)
PAYOUT_LINE = "Payout %"
COUNTED = "o.status NOT IN ('cancelled','returned')"    # same rule as the shop app's own reports


def _open(shop_db_path):
    uri = "file:" + shop_db_path.replace("\\", "/") + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5)


def legacy_months(shop_db_path):
    """The shop app's hand-typed finance_monthly as {(year, month): [{section, line, amount}]}, for the one-time copy.
    {} when the shop database is missing or unreadable."""
    if not os.path.exists(shop_db_path):
        return {}
    try:
        conn = _open(shop_db_path)
        try:
            rows = conn.execute("SELECT year, month, section, line, amount FROM finance_monthly ORDER BY year, month, line").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return {}
    out = {}
    for year, month, section, line, amount in rows:
        if section in FIN_SECTIONS:
            out.setdefault((year, month), []).append({"section": section, "line": line, "amount": amount})
    return out


def orders_by_month(shop_db_path):
    """What the synced orders add up to per (year, month), for comparing with what was typed. {} when unavailable."""
    if not os.path.exists(shop_db_path):
        return {}
    try:
        conn = _open(shop_db_path)
        try:
            rows = conn.execute(
                f"SELECT CAST(substr(o.ordered_at,1,4) AS INTEGER), CAST(substr(o.ordered_at,6,2) AS INTEGER), lower(o.platform), "
                f"SUM(l.amount), SUM(CASE WHEN l.amount_is_estimate=1 THEN l.amount ELSE 0 END), COUNT(DISTINCT o.id) "
                f"FROM orders o JOIN order_lines l ON l.order_id=o.id WHERE {COUNTED} GROUP BY 1, 2, 3").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return {}
    out = {}
    for y, m, platform, rev, est, n in rows:
        if y is None or m is None:
            continue
        d = out.setdefault((y, m), {"lazada": 0.0, "shopee": 0.0, "other": 0.0, "estimated": 0.0, "orders": 0})
        d[platform if platform in ("lazada", "shopee") else "other"] += rev or 0.0
        d["estimated"] += est or 0.0
        d["orders"] += n
    return out


def build_finance(months, orders_m, split_onn=0.6):
    """The monthly P&L in the shape the Shop page draws. months: {(year, month): [{section, line, amount}]}.

    Net profit is revenue - cost of goods - fees - interest and tax, as the shop sheet works it out, so a month with no cost of
    goods typed counts it as 0 (`has_cogs` says whether any was). A month with only interest or tax lines is not a month of data.
    Dividend, as the sheet works it: (revenue - fees) x the month's Payout %, split ออน `split_onn` and เบส the rest; cost of
    goods is not taken off. None where no Payout % was typed."""
    data = {}
    for (year, month), entries in months.items():
        m = data.setdefault(year, {}).setdefault(month, {k: {} for k in ALL_SECTIONS})
        for e in entries:
            m[e["section"]][e["line"]] = e["amount"]
    years = []
    for y in sorted(set(data) | {k[0] for k in orders_m}, reverse=True):
        out = []
        for mo in range(1, 13):
            m, o = data.get(y, {}).get(mo), orders_m.get((y, mo))
            if not m and not o:
                continue
            m = m or {k: {} for k in ALL_SECTIONS}
            manual = any(m[k] for k in ("revenue", "cogs", "sga"))
            rev, cogs, sga, tax = (sum(m[k].values()) for k in FIN_SECTIONS)
            has_cogs = cogs > 0
            pct = m["dividend"].get(PAYOUT_LINE)
            pool = round((rev - sga) * pct / 100, 2) if manual and pct is not None else None
            out.append({"month": mo, "manual": manual, "revenue": rev, "revenue_lines": m["revenue"], "cogs": cogs,
                        "cogs_lines": m["cogs"], "sga": sga, "sga_lines": m["sga"], "tax": tax, "tax_lines": m["tax"],
                        "has_cogs": has_cogs, "after_fees": rev - sga,
                        "net_profit": (rev - cogs - sga - tax) if manual else None,
                        "payout_pct": pct, "dividend_pool": pool,
                        "dividend_onn": round(pool * split_onn, 2) if pool is not None else None,
                        "dividend_bes": round(pool - round(pool * split_onn, 2), 2) if pool is not None else None, "orders": o})
        if out:
            years.append({"year": y, "months": out})
    return years


def revenue_months(months):
    """[{month: 'YYYY-MM', shop, revenue, by_platform}] from {(year, month): entries}, the shape Home's SHOP tile reads."""
    out = []
    for (year, month), entries in sorted(months.items()):
        lines = {e["line"]: e["amount"] for e in entries if e["section"] == "revenue"}
        if lines:
            out.append({"month": f"{year:04d}-{month:02d}", "shop": SHOP_NAME, "revenue": round(sum(lines.values()), 2), "by_platform": lines})
    return out
