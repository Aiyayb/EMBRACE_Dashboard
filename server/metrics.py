"""The only place Total Portfolio Value and Monthly Return are computed.

Rules (GLOSSARY.md):
- An Account's value in a month is its latest Snapshot on or before that month's
  end. A value carried forward from an earlier month is reported as stale.
- Total Portfolio Value sums Counted Accounts only.
- Monthly Return = end value - start value - net Flows. It is only stated for
  months from `flows_recorded_from` on; earlier months are "Flows unknown".
- A derived Account (the Family Statement) takes its balance from its own
  source. Every change in that balance is a Flow, so it moves Total Portfolio
  Value but never Monthly Return.
"""
import datetime
from collections import defaultdict

import db

BUCKETS = ("investment", "trading", "wealth")
GROUPS = ("investment", "trading", "saving", "emc")      # the four parts of Asset Allocation


def group_of(acc):
    """Allocation Group of an Account: its Bucket, except Wealth splits into Saving and EMC."""
    if acc["bucket"] != "wealth":
        return acc["bucket"]
    return acc["allocation"] if acc["allocation"] in ("saving", "emc") else "saving"


def _month_range(first, last):
    y, m = int(first[:4]), int(first[5:7])
    out = []
    while f"{y:04d}-{m:02d}" <= last:
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def _r(v):
    return None if v is None else round(v, 2)


def monthly(conn, derived=None):
    """One row per month from the first Snapshot to the last.

    derived: {account_id: [(as_of, balance_thb), ...]} for Accounts valued by their own source.
    """
    accounts = {a["id"]: dict(a) for a in conn.execute("SELECT * FROM accounts")}
    snaps = [(s["as_of"], s["account_id"], s["value_thb"]) for s in conn.execute(
        "SELECT s.account_id, s.as_of, s.value_thb FROM snapshots s JOIN accounts a ON a.id = s.account_id "
        "WHERE a.source = 'manual' ORDER BY s.as_of, s.id")]
    if not snaps:
        return []
    months = _month_range(snaps[0][0][:7], snaps[-1][0][:7])
    flows = defaultdict(float)
    for f in conn.execute("SELECT account_id, substr(on_date, 1, 7) AS month, SUM(amount_thb) AS amount "
                          "FROM flows GROUP BY account_id, month"):
        flows[(f["account_id"], f["month"])] = f["amount"]
    for acc_id, points in (derived or {}).items():
        if acc_id not in accounts or accounts[acc_id]["source"] == "manual":
            continue
        ends = {}
        for as_of, value in sorted(points):
            ends[as_of[:7]] = (as_of, value)
        prev = 0.0
        for month in sorted(ends):
            as_of, value = ends[month]
            flows[(acc_id, month)] += value - prev
            prev = value
            snaps.append((as_of, acc_id, value))
    snaps.sort(key=lambda s: s[0])
    known_from = db.get_setting(conn, "flows_recorded_from") or ""

    rows, latest, i = [], {}, 0
    for month in months:
        while i < len(snaps) and snaps[i][0][:7] <= month:
            latest[snaps[i][1]] = snaps[i]
            i += 1
        row = {"month": month, "investment": 0.0, "trading": 0.0, "wealth": 0.0, "total": 0.0,
               "net_flow": 0.0, "trading_flow": 0.0, "stale": [], "by_account": []}
        for acc_id, acc in accounts.items():
            if not acc["counts_in_total"]:
                continue
            flow = flows.get((acc_id, month), 0.0)
            row["net_flow"] += flow
            if acc["bucket"] == "trading":
                row["trading_flow"] += flow
            snap = latest.get(acc_id)
            if snap is None:
                continue
            as_of, _, value = snap
            row[acc["bucket"]] += value
            row["total"] += value
            stale = as_of[:7] < month
            if stale:
                row["stale"].append(acc["name"])
            row["by_account"].append({"account_id": acc_id, "account": acc["name"], "bucket": acc["bucket"],
                                      "group": group_of(acc), "value_thb": _r(value), "as_of": as_of, "stale": stale})
        rows.append(row)

    for n, row in enumerate(rows):
        prev = rows[n - 1] if n else None
        row["flows_known"] = bool(known_from) and row["month"] >= known_from
        # Monthly Return (Best's definition): change in Total Portfolio Value, deposits and withdrawals counted
        row["growth_thb"] = row["total"] - prev["total"] if prev is not None else None
        row["growth_pct"] = row["growth_thb"] / prev["total"] if prev is not None and prev["total"] else None
        if prev is not None and row["flows_known"]:
            row["return_thb"] = row["total"] - prev["total"] - row["net_flow"]
            row["return_pct"] = row["return_thb"] / prev["total"] if prev["total"] else None
            row["trading_pnl"] = row["trading"] - prev["trading"] - row["trading_flow"]
            row["trading_pnl_pct"] = row["trading_pnl"] / prev["trading"] if prev["trading"] else None
        else:
            row["return_thb"] = row["return_pct"] = row["trading_pnl"] = row["trading_pnl_pct"] = None
    for row in rows:
        for k in ("investment", "trading", "wealth", "total", "net_flow", "trading_flow", "return_thb", "growth_thb", "trading_pnl"):
            row[k] = _r(row[k])
    return rows


def latest_values(conn):
    """Every Account with its most recent Snapshot (or None)."""
    out = []
    for a in conn.execute("SELECT * FROM accounts ORDER BY bucket, name"):
        s = conn.execute("SELECT * FROM snapshots WHERE account_id=? ORDER BY as_of DESC, id DESC LIMIT 1",
                         (a["id"],)).fetchone()
        acc = dict(a)
        acc["group"] = group_of(acc)
        acc["snapshot"] = dict(s) if s else None
        out.append(acc)
    return out


def allocation(rows):
    """Total Portfolio Value in the latest month, split into the four Allocation Groups."""
    if not rows:
        return []
    cur = rows[-1]
    out = []
    for group in GROUPS:
        members = [a for a in cur["by_account"] if a["group"] == group]
        value = sum(a["value_thb"] for a in members)
        out.append({"group": group, "value_thb": _r(value), "share": value / cur["total"] if cur["total"] else None,
                    "accounts": [a["account"] for a in members if a["value_thb"]]})
    return out


def _change(cur, prev):
    return None if cur is None or not prev else cur / prev - 1


def kpis(rows, shop_months):
    """Home tiles: the latest month against the month before it."""
    if not rows:
        return None
    cur = rows[-1]
    prev = rows[-2] if len(rows) > 1 else None
    shop = {r["month"]: r["revenue"] for r in (shop_months or [])}
    prev_month = prev["month"] if prev else None
    return {
        "month": cur["month"],
        "prev_month": prev_month,
        "total": cur["total"],
        "total_mom": _change(cur["total"], prev and prev["total"]),
        "monthly_return": cur["growth_thb"],           # Monthly Return: change in value, deposits counted
        "monthly_return_pct": cur["growth_pct"],
        "return_after_flows": cur["return_thb"],       # the same month with deposits and withdrawals taken out
        "return_after_flows_pct": cur["return_pct"],
        "net_flow": cur["net_flow"],
        "flows_known": cur["flows_known"],
        "stale": cur["stale"],
        "investment": cur["investment"],
        "investment_mom": _change(cur["investment"], prev and prev["investment"]),
        "trading_pnl": cur["trading_pnl"],
        "trading_pnl_pct": cur["trading_pnl_pct"],
        "shop_revenue": shop.get(cur["month"]),
        "shop_mom": _change(shop.get(cur["month"]), shop.get(prev_month)),
    }


def performance(conn, rows):
    """Cumulative return since the month before the first stated Monthly Return, beside each Benchmark."""
    first = next((n for n, r in enumerate(rows) if r["return_pct"] is not None), None)
    if first is None:
        return []
    window = rows[first - 1:]
    bench = defaultdict(dict)
    for b in conn.execute("SELECT name, as_of, value FROM benchmarks ORDER BY as_of"):
        bench[b["name"]][b["as_of"][:7]] = b["value"]      # latest value within a month wins
    base = window[0]["month"]
    out, growth = [], 1.0
    for n, r in enumerate(window):
        if n and r["return_pct"] is not None:
            growth *= 1 + r["return_pct"]
        point = {"month": r["month"], "portfolio": growth - 1}
        for name, series in bench.items():
            start, here = series.get(base), series.get(r["month"])
            point[name.lower()] = here / start - 1 if start and here else None
        out.append(point)
    return out


def value_growth_vs_benchmark(conn, rows, benchmark="SET", start="2023-01", field="total"):
    """Growth of Total Portfolio Value since `start`, beside one Benchmark rebased to the same month.

    This is value growth, NOT return: it includes every deposit and withdrawal, and Flows are only recorded
    from `flows_recorded_from`, so before that no return can be stated. `stale` lists Accounts whose value
    for the month is carried forward. Benchmark value is the latest recorded within the month.
    """
    window = [r for r in rows if r["month"] >= start]
    while window and not window[0][field]:           # a Bucket that starts later: measure from its first month with a value
        window = window[1:]
    if not window:
        return []
    levels = {}
    for b in conn.execute("SELECT as_of, value FROM benchmarks WHERE name=? ORDER BY as_of", (benchmark,)):
        levels[b["as_of"][:7]] = b["value"]            # latest value within a month wins
    base_total, base_level = window[0][field], levels.get(window[0]["month"])
    key = benchmark.lower()
    return [{"month": r["month"], "total": r[field], "portfolio": r[field] / base_total - 1,
             key: levels[r["month"]] / base_level - 1 if base_level and r["month"] in levels else None,
             f"{key}_level": levels.get(r["month"]), "stale": r["stale"]} for r in window]


def journal_sheet(conn, start, risk_pct, year=None):
    """The trade journal laid out as its sheet is: every trade oldest first with the running Balance and Risk / Trade,
    and the summary block (Start, Return, Net Balance, Profit, Loss, PNL, Win, Loss, BE, PF Factor, Win Rate, Risk).
    Balance is Start plus the P&L so far; amounts are in the journal's own currency (USDT).
    With `year`, the sheet and the summary cover that year only: its Start is the balance at the end of the year before
    (the journal's Start for the first year), and the running Balance carries across years."""
    out, balance, profit, lost = [], start, 0.0, 0.0
    count = {"win": 0, "loss": 0, "be": 0}
    years = sorted({t["traded_on"][:4] for t in conn.execute("SELECT traded_on FROM trades")}, reverse=True)
    for t in conn.execute("SELECT * FROM trades ORDER BY traded_on, id"):
        t = dict(t)
        pnl = t["pnl"] or 0.0
        if year and t["traded_on"][:4] < year:
            start += pnl                          # an earlier year: it moves this year's Start, not its totals
            balance += pnl
            continue
        if year and t["traded_on"][:4] > year:
            continue
        profit += max(pnl, 0.0)
        lost += max(-pnl, 0.0)
        balance += pnl
        if t["outcome"] in count:
            count[t["outcome"]] += 1
        t["profit"] = _r(pnl) if pnl > 0 else None
        t["lost"] = _r(-pnl) if pnl < 0 else None
        t["balance"], t["risk"] = _r(balance), _r(balance * risk_pct)
        out.append(t)
    decided = count["win"] + count["loss"]
    net = start + profit - lost
    return {"trades": out, "years": years, "year": year,
            "summary": {"start": start, "net_balance": _r(net), "return": net / start - 1 if start else None,
                        "profit": _r(profit), "loss": _r(lost), "pnl": _r(profit - lost),
                        "win": count["win"], "loss_count": count["loss"], "be": count["be"],
                        "profit_factor": profit / lost if lost else None,
                        "win_rate": count["win"] / decided if decided else None,
                        "risk_pct": risk_pct, "risk_amount": _r(net * risk_pct)}}


def bucket_stats(rows, bucket):
    """Investment-page tiles for one Bucket, from the last finished month: Monthly Return, year to date and CAGR.
    All three are change in value with deposits counted (Best's definition), so CAGR is not an investment return."""
    if not rows:
        return None
    cur = rows[-1]
    prev = rows[-2] if len(rows) > 1 else None
    dec = next((r for r in rows if r["month"] == f"{int(cur['month'][:4]) - 1}-12"), None)
    first = next((r for r in rows if r[bucket] > 0), None)
    months = ((int(cur["month"][:4]) - int(first["month"][:4])) * 12 + int(cur["month"][5:]) - int(first["month"][5:])
              if first else 0)

    def change(base):
        if base is None or not base[bucket]:
            return None, None
        return cur[bucket] - base[bucket], cur[bucket] / base[bucket] - 1

    monthly_thb, monthly_pct = change(prev)
    ytd_thb, ytd_pct = change(dec)
    return {"month": cur["month"], "value": cur[bucket], "monthly_amount": _r(monthly_thb), "monthly_pct": monthly_pct,
            "ytd_amount": _r(ytd_thb), "ytd_pct": ytd_pct,
            "cagr": (cur[bucket] / first[bucket]) ** (12 / months) - 1 if first and months >= 12 else None,
            "cagr_since": first["month"] if first else None}


def journal_stats(conn, start, year=None, start_date=None):
    """Trading figures read from the trade journal, which is the source of truth for Trading.

    The journal balance is Start plus the P&L of the trades, so deposits and withdrawals are not in it and every
    figure here is a true trading result, in the journal's currency (USDT). Returns the same keys as bucket_stats
    (`*_amount` is USDT), plus `rows`: the balance by month from the December before `year`, with BTC rebased to that
    month, in the shape performanceCard draws. None when the journal has no trade with a P&L.

    `start_date` is the day the Start balance was in the account (before the first trade). CAGR counts from there; with under
    a year it is an annualised figure (`cagr_months` says from how many months) and with under 90 days it is not given."""
    trades = [t for t in conn.execute("SELECT traded_on, pnl FROM trades ORDER BY traded_on, id") if t["pnl"] is not None]
    if not trades:
        return None
    by_month = {}
    for t in trades:
        by_month[t["traded_on"][:7]] = by_month.get(t["traded_on"][:7], 0.0) + t["pnl"]
    last = max(by_month)
    first_day = min(start_date, trades[0]["traded_on"]) if start_date else trades[0]["traded_on"]
    year = year or last[:4]

    def balance_at(month):          # end of `month`; months with no trades carry the balance on
        return start + sum(p for m, p in by_month.items() if m <= month)

    net = balance_at(last)
    prev_month = f"{int(last[:4]) - (last[5:] == '01')}-{12 if last[5:] == '01' else int(last[5:]) - 1:02d}"
    opening = balance_at(prev_month)
    ytd_open = balance_at(f"{int(last[:4]) - 1}-12")
    days = (datetime.date.fromisoformat(trades[-1]["traded_on"]) - datetime.date.fromisoformat(first_day)).days
    stats = {"month": last, "value": _r(net),
             "monthly_amount": _r(by_month[last]), "monthly_pct": by_month[last] / opening if opening else None,
             "ytd_amount": _r(net - ytd_open), "ytd_pct": net / ytd_open - 1 if ytd_open else None,
             "cagr": (net / start) ** (365.25 / days) - 1 if start and days >= 90 else None,
             "cagr_months": round(days / 30.44) if days >= 90 else None, "cagr_since": first_day[:7]}
    levels = {}
    for b in conn.execute("SELECT as_of, value FROM benchmarks WHERE name='BTC' ORDER BY as_of"):
        levels[b["as_of"][:7]] = b["value"]
    base = f"{int(year) - 1}-12"
    months, m = [], base
    while m <= last and m[:4] <= year:
        months.append(m)
        m = f"{int(m[:4]) + (m[5:] == '12')}-{1 if m[5:] == '12' else int(m[5:]) + 1:02d}"
    base_balance, base_level = balance_at(base), levels.get(base)
    stats["rows"] = [{"month": m, "total": _r(balance_at(m)), "portfolio": balance_at(m) / base_balance - 1,
                      "btc": levels[m] / base_level - 1 if base_level and m in levels else None, "btc_level": levels.get(m), "stale": []}
                     for m in months] if base_balance else []
    return stats


def journal_months(conn, start, start_date=None):
    """The trade journal by month, from the first trade to the last, for the Trading page: number of trades, P&L, P&L as a
    share of the month's opening balance, and the balance at month end (Start plus P&L so far; no deposits). USDT."""
    pnl, count = {}, {}
    for t in conn.execute("SELECT traded_on, pnl FROM trades ORDER BY traded_on, id"):
        m = t["traded_on"][:7]
        count[m] = count.get(m, 0) + 1
        pnl[m] = pnl.get(m, 0.0) + (t["pnl"] or 0.0)
    if not count:
        return []
    out, balance, m = [], start, min(min(count), start_date[:7]) if start_date else min(count)
    while m <= max(count):
        month_pnl = pnl.get(m, 0.0)
        out.append({"month": m, "trades": count.get(m, 0), "pnl": _r(month_pnl),
                    "pnl_pct": month_pnl / balance if balance else None, "balance": _r(balance + month_pnl)})
        balance += month_pnl
        m = f"{int(m[:4]) + (m[5:] == '12')}-{1 if m[5:] == '12' else int(m[5:]) + 1:02d}"
    return out


def market_breakdown(conn):
    """Investment value by stock market, from each Investment Account's latest Snapshot that carries holdings."""
    import json
    latest = conn.execute(
        "SELECT s.as_of, s.holdings FROM snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.bucket='investment' "
        "AND s.as_of = (SELECT MAX(as_of) FROM snapshots WHERE account_id = s.account_id)").fetchall()
    totals, stocks, as_of = {}, {}, None
    for s in latest:
        if not s["holdings"]:
            continue
        as_of = max(as_of or s["as_of"], s["as_of"])
        for h in json.loads(s["holdings"]):
            totals[h["market"]] = totals.get(h["market"], 0.0) + h["value_thb"]
            if h["market"] != "CASH" and h["stock"].strip().lower() != "cash":     # cash is not a stock, however it was entered
                key = (h["market"], h["stock"])
                stocks[key] = stocks.get(key, 0.0) + h["value_thb"]
    whole = sum(totals.values())
    # top 10 stocks by value; Cash is not a stock. Share is of the whole Investment value, cash included.
    top = [{"market": m, "stock": st, "value_thb": _r(v), "share": v / whole}
           for (m, st), v in sorted(stocks.items(), key=lambda kv: -kv[1])[:10]]
    return {"as_of": as_of, "top": top,
            "markets": [{"market": m, "value_thb": _r(v), "share": v / whole}
                        for m, v in sorted(totals.items(), key=lambda kv: -kv[1])]}


def goal_progress(conn, rows, year):
    """This year's Goal for each Bucket against its latest value."""
    if not rows:
        return []
    cur = rows[-1]
    out = []
    for g in conn.execute("SELECT bucket, SUM(goal_thb) AS goal FROM goals "
                          "WHERE year=? AND bucket IS NOT NULL GROUP BY bucket", (year,)):
        out.append({"bucket": g["bucket"], "year": year, "actual_thb": cur[g["bucket"]], "goal_thb": _r(g["goal"]),
                    "progress": cur[g["bucket"]] / g["goal"] if g["goal"] else None})
    return sorted(out, key=lambda r: BUCKETS.index(r["bucket"]))


def net_worth(conn, rows):
    """All Asset Class: Total Portfolio Value plus every other Asset, minus the debts against them."""
    assets = [dict(a) for a in conn.execute("SELECT * FROM assets ORDER BY asset_class, name")]
    portfolio = rows[-1]["total"] if rows else 0.0
    owned = sum(a["value_thb"] for a in assets)
    owed = sum(a["debt_thb"] for a in assets)
    return {"portfolio_thb": _r(portfolio), "other_assets_thb": _r(owned), "debt_thb": _r(owed),
            "net_worth_thb": _r(portfolio + owned - owed), "assets": assets}


def trade_stats(conn):
    """Journal summary overall and by Grade and Setup. Amounts are in the journal's own currency."""
    trades = [dict(t) for t in conn.execute("SELECT * FROM trades ORDER BY traded_on, id")]

    def summarise(items):
        wins = [t for t in items if t["outcome"] == "win"]
        losses = [t for t in items if t["outcome"] == "loss"]
        # gross profit and loss over every trade, as the journal's own summary does
        gain = sum(t["pnl"] for t in items if (t["pnl"] or 0) > 0)
        loss = -sum(t["pnl"] for t in items if (t["pnl"] or 0) < 0)
        decided = len(wins) + len(losses)
        return {"trades": len(items), "win": len(wins), "loss": len(losses),
                "be": sum(1 for t in items if t["outcome"] == "be"),
                "win_rate": len(wins) / decided if decided else None,
                "profit_factor": gain / loss if loss else None,
                "pnl": _r(gain - loss)}

    def by(key):
        groups = defaultdict(list)
        for t in trades:
            groups[t[key] or "(blank)"].append(t)
        return [dict(summarise(v), **{key: k}) for k, v in sorted(groups.items())]

    return {"overall": summarise(trades), "by_grade": by("grade"), "by_setup": by("setup")}
