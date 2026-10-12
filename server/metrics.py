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


def _diff(cur, prev):
    """Baht difference to the month before; None when either month has no value."""
    return None if cur is None or prev is None else round(cur - prev, 2)


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
        "investment_change": _diff(cur["investment"], prev and prev["investment"]),
        "saving": cur["wealth"],
        "saving_mom": _change(cur["wealth"], prev and prev["wealth"]),
        "saving_change": _diff(cur["wealth"], prev and prev["wealth"]),
        "trading": cur["trading"],
        "trading_mom": _change(cur["trading"], prev and prev["trading"]),
        "trading_pnl": cur["trading_pnl"],
        "trading_pnl_pct": cur["trading_pnl_pct"],
        "shop_revenue": shop.get(cur["month"]),
        "shop_mom": _change(shop.get(cur["month"]), shop.get(prev_month)),
        "shop_change": _diff(shop.get(cur["month"]), shop.get(prev_month)),
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


def value_growth_vs_benchmark(conn, rows, benchmark="SET", start="2023-01", field="total", end=None):
    """Growth of Total Portfolio Value since `start`, beside one Benchmark rebased to the same month.

    This is value growth, NOT return: it includes every deposit and withdrawal, and Flows are only recorded
    from `flows_recorded_from`, so before that no return can be stated. `stale` lists Accounts whose value
    for the month is carried forward. Benchmark value is the latest recorded within the month.
    """
    window = [r for r in rows if r["month"] >= start and (end is None or r["month"] <= end)]
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
    """Stock-page tiles for one Bucket, from the last finished month: Monthly Return, year to date and CAGR.
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
    # Max Drawdown: the worst fall from the running peak of the journal balance (trade by trade, peak carried across
    # months) inside the month; `mdd_prev` is the same for the month before, so the tile can show the change.
    bal, peak, mdd = start, start, {}
    for t in trades:
        bal += t["pnl"]
        peak = max(peak, bal)
        m = t["traded_on"][:7]
        mdd[m] = min(mdd.get(m, 0.0), bal / peak - 1 if peak else 0.0)
    stats["mdd"] = mdd.get(last, 0.0)
    stats["mdd_prev"] = mdd.get(prev_month, 0.0)
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
    """Stock value by market, from each Stock Account's latest Snapshot that carries holdings."""
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
    # top 10 stocks by value; Cash is not a stock. Share is of the whole Stock value, cash included.
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


def goal_group(goal):
    """The Allocation Group a Goal is measured against: its Bucket, with Wealth split into Saving and EMC by the Goal's name.
    None for a Goal outside Total Portfolio Value (such as OnTheWall, which is a yearly income target)."""
    if goal["bucket"] in ("investment", "trading"):
        return goal["bucket"]
    if goal["bucket"] == "wealth":
        return "emc" if goal["name"].strip().lower() in ("emc", "saving cash") else "saving"
    return None


def group_values(row):
    out = dict.fromkeys(GROUPS, 0.0)
    for a in row["by_account"]:
        out[a["group"]] += a["value_thb"]
    return out


def plan_view(conn, rows, income_actual=None):
    """The Plan page: this year's Goals against the latest finished month, and the road to the last year that has Goals.

    rows: finished months (metrics.monthly). income_actual: {goal name: {year: amount}} for Goals outside Total Portfolio Value
    (OnTheWall is measured by the shop's profit for dividend). A year's portfolio target is the sum of its Goals that have a
    Bucket; the others are income targets and are never added to it. `expected_thb` is a straight line from the year's opening
    value to its target, a yardstick only. `deposits_ytd` is what the Flows record for the Goal's Accounts this year (an opening
    value of a new Account is not counted); it is not a return. `needed_growth` to the last target is growth in value per year
    with deposits counted, so it is not a return either."""
    goals = [dict(g) for g in conn.execute("SELECT * FROM goals ORDER BY year, id")]
    if not rows or not goals:
        return None
    cur = rows[-1]
    year, month_no = int(cur["month"][:4]), int(cur["month"][5:7])
    by_month = {r["month"]: r for r in rows}
    now = group_values(cur)
    opening_row = by_month.get(f"{year - 1}-12")
    birth = db.get_setting(conn, "plan_birth_year")
    birth = int(birth) if birth and str(birth).isdigit() else None
    age = (lambda y: y - birth) if birth else (lambda y: None)

    group_by_account = {a["id"]: group_of(dict(a)) for a in conn.execute("SELECT * FROM accounts")}
    deposits = defaultdict(float)
    for f in conn.execute("SELECT account_id, amount_thb FROM flows WHERE substr(on_date, 1, 7) BETWEEN ? AND ? AND kind != 'opening'",
                          (f"{year}-01", cur["month"])):
        deposits[group_by_account.get(f["account_id"])] += f["amount_thb"]

    def target_of(y):
        return sum(g["goal_thb"] for g in goals if g["year"] == y and g["bucket"])

    items = []
    for g in (g for g in goals if g["year"] == year):
        group = goal_group(g)
        actual = now[group] if group else (income_actual or {}).get(g["name"], {}).get(year)
        monthly_plan = g.get("monthly_thb")
        items.append({"id": g["id"], "name": g["name"], "group": group, "goal_thb": _r(g["goal_thb"]), "actual_thb": _r(actual),
                      "progress": actual / g["goal_thb"] if actual is not None and g["goal_thb"] else None,
                      "gap_thb": _r(g["goal_thb"] - actual) if actual is not None else None,
                      "monthly_thb": monthly_plan, "growth_pct": g.get("growth_pct"), "note": g.get("note"),
                      "deposits_ytd": _r(deposits.get(group, 0.0)) if group else None,
                      "deposits_plan_ytd": _r(monthly_plan * month_no) if group and monthly_plan else None})

    target = target_of(year)
    opening = opening_row["total"] if opening_row else None
    this_year = {"year": year, "month": cur["month"], "months_left": 12 - month_no, "target_thb": _r(target), "actual_thb": cur["total"],
                 "opening_thb": opening, "progress": cur["total"] / target if target else None, "gap_thb": _r(target - cur["total"]),
                 "expected_thb": _r(opening + (target - opening) * month_no / 12) if opening is not None and target else None,
                 "per_month_thb": _r((target - cur["total"]) / (12 - month_no)) if month_no < 12 and target else None,
                 "stale": cur["stale"], "items": items}

    years = sorted({g["year"] for g in goals})
    roadmap = []
    for y in years:
        plan = dict.fromkeys(GROUPS, 0.0)
        income = 0.0
        for g in (g for g in goals if g["year"] == y):
            if goal_group(g):
                plan[goal_group(g)] += g["goal_thb"]
            else:
                income += g["goal_thb"]
        end = by_month.get(f"{y}-12")
        actual = cur["total"] if y == year else end["total"] if end and y < year else None
        roadmap.append({"year": y, "age": age(y), "plan": {k: _r(v) for k, v in plan.items()}, "target_thb": _r(sum(plan.values())),
                        "income_thb": _r(income), "actual_thb": actual, "as_of": cur["month"] if y == year else f"{y}-12" if actual is not None else None,
                        "diff_thb": _r(actual - sum(plan.values())) if actual is not None and y < year else None})

    last = years[-1]
    big_target = target_of(last)
    months_left = (last - year) * 12 + (12 - month_no)
    big = {"year": last, "age": age(last), "target_thb": _r(big_target), "actual_thb": cur["total"],
           "progress": cur["total"] / big_target if big_target else None, "gap_thb": _r(big_target - cur["total"]), "months_left": months_left,
           "needed_growth": (big_target / cur["total"]) ** (12 / months_left) - 1 if months_left > 0 and cur["total"] > 0 and big_target else None}
    # year-end values before the first Goal year, for the chart
    history = [{"year": int(m[:4]), "actual_thb": r["total"]} for m, r in sorted(by_month.items()) if m.endswith("-12") and int(m[:4]) < years[0]]
    return {"this_year": this_year, "roadmap": roadmap, "big": big, "history": history, "years": years}


INVESTMENT_INCOME = ("Trading", "Stock dividend")       # Cash flow log income lines that are a return on Investment
INVESTMENT_REINVEST = ("Stock", "Investment", "Trading")  # Reinvest destinations that are Investment (Stock + Trading)


FLOW_GROUPS = {"income": ("Active", "Investment", "Other"), "spending": ("Fixed costs", "Expenses")}


def flow_log_rows(lines, n):
    """The Cash flow log's average month as the rows the Plan page's Income and Spending tables start from:
    {"income": [{group, name, amount}], "spending": [...]}. Salary and Online Shop are Active; Stock dividend is Investment/Stock
    and Trading is Investment/Trading (the four are always listed); any other income line is Other; each Fixed cost and Expense
    line is its own row."""
    def total(section, name):
        return sum(l["amount_thb"] for l in lines if l["section"] == section and l["line"] == name) / n if n else 0.0

    standard = {"Salary": ("Active", "Salary"), "Online Shop": ("Active", "Online Shop"),
                "Stock dividend": ("Investment", "Stock"), "Trading": ("Investment", "Trading")}
    income = [{"group": g, "name": nm, "amount": _r(total("income", line))} for line, (g, nm) in standard.items()]
    for name in sorted({l["line"] for l in lines if l["section"] == "income"} - set(standard)):
        income.append({"group": "Other", "name": name, "amount": _r(total("income", name))})
    spending = []
    for section, group in (("fixed_cost", "Fixed costs"), ("expense", "Expenses")):
        for name in sorted({l["line"] for l in lines if l["section"] == section}):
            spending.append({"group": group, "name": name, "amount": _r(total(section, name))})
    return {"income": income, "spending": spending}


def _display(rows, merge):
    """Lines of an Income or Spending box: the groups in `merge` become one line naming their rows ("Active · Salary + Online Shop"),
    every other row is a line of its own ("Investment · Stock")."""
    out, seen = [], {}
    for r in rows:
        if r["group"] in merge:
            if r["group"] not in seen:
                seen[r["group"]] = {"label": r["group"], "detail": [], "amount": 0.0}
                out.append(seen[r["group"]])
            seen[r["group"]]["detail"].append(r["name"])
            seen[r["group"]]["amount"] += r["amount"]
        else:
            out.append({"label": r["group"], "detail": [r["name"]], "amount": r["amount"]})
    return [{"label": o["label"], "detail": " + ".join(o["detail"]), "amount": _r(o["amount"])} for o in out]


def _month_add(month, k):
    """'2026-09' + 4 -> '2027-01'"""
    n = int(month[:4]) * 12 + int(month[5:7]) - 1 + k
    return f"{n // 12}-{n % 12 + 1:02d}"


def debt_schedule(balance, rate, payment, first_month, limit=720):
    """A reducing-balance loan, month by month: the interest of a month is charged on what is still owed (rate / 12), and the
    rest of the payment pays the principal down, so the interest falls as the debt does. Returns [{month, interest, principal,
    payment, balance}] from `first_month` until nothing is owed. A payment that does not cover the interest never pays the loan
    off: the list is then empty."""
    out = []
    for k in range(limit):
        if balance <= 0.005:
            break
        interest = balance * rate / 12
        pay = min(payment, balance + interest)
        if pay <= interest:
            return []
        balance = max(0.0, balance - (pay - interest))
        out.append({"month": _month_add(first_month, k), "interest": interest, "principal": pay - interest, "payment": pay, "balance": balance})
    return out


def finance_flow(conn, rows, yields, roadmap=None, planned=None, debts=None, reinvest=None):
    """The Plan page's money model: an average month, the debts, and how far Investment is from paying for the spending
    once Salary stops. Every figure follows from four inputs, so changing one moves the rest:

    - Income and Spending: rows of {group, name, amount} a month. By default the Cash flow log averaged over the months of the
      latest finished year that have entries; `planned` = {"income": rows, "spending": rows} replaces a box with Best's own.
    - Debts: `debts` = [{name, line, balance, as_of, rate, payment}], reducing-balance loans. A debt's payment is the Debt line of
      Spending (the Fixed-cost row named `line` is left out so it is not counted twice) and it ends when the loan is paid off.
    - Investment: Stock + Trading at the latest month end, the yearly `yields` the plan counts on, and the monthly reinvestment
      (`reinvest` = {"stock", "trading", "freed"}; None = the log's average; `freed` also reinvests a paid-off debt's payment).

    `gap_thb` is what Investment has to pay: Spending less the income that goes on without the job (every Income row except
    Salary and the Investment rows, which are the return itself). `expected_return_thb` is NOT a result: it is today's value at
    the plan's yields. `coverage` = that return / gap; `needed_thb` = the value whose return equals the gap (at today's mix);
    `needed_after_thb` the same once every debt is paid. `reach` is the first month a month-by-month projection (values growing
    at the yields, plus the reinvestment, less any return taken as income) returns the gap; `projection` is that run by year.
    `path` applies the yields to each year's Stock and Trading Goals instead, and `covered_year` is the first Goal year that
    covers the gap. `income.investment` is the return recorded as income; `actual_coverage` is it against Spending."""
    if not rows:
        return None
    cur = rows[-1]
    now, year = cur["month"], cur["month"][:4]
    lines = [dict(l) for l in conn.execute("SELECT month, section, line, amount_thb FROM cashflow_lines WHERE month BETWEEN ? AND ?",
                                           (f"{year}-01", now))]
    months = sorted({l["month"] for l in lines})
    n = len(months)
    birth = db.get_setting(conn, "plan_birth_year")
    birth = int(birth) if birth and str(birth).isdigit() else None
    age = (lambda y: y - birth) if birth else (lambda y: None)

    def avg(section, keep=lambda name: True):
        return sum(l["amount_thb"] for l in lines if l["section"] == section and keep(l["line"])) / n if n else 0.0

    # ---- debts: where each stands now, and its payments from next month on
    loans = []
    for d in debts or []:
        full = debt_schedule(d["balance"], d["rate"], d["payment"], _month_add(d["as_of"], 1))
        past = [e for e in full if e["month"] <= now]              # the balance was typed some months ago: roll it forward
        ahead = [e for e in full if e["month"] > now]
        owed = past[-1]["balance"] if past else d["balance"]
        never = owed > 0.005 and not full
        end = ahead[-1]["month"] if ahead else None
        loans.append({"d": d, "ahead": {e["month"]: e for e in ahead}, "never": never, "owed": owed, "view": {
            "name": d["name"], "line": d.get("line") or "", "typed_thb": _r(d["balance"]), "as_of": d["as_of"], "rate": d["rate"],
            "payment_thb": _r(d["payment"]), "balance_thb": _r(owed), "rolled": bool(past),
            "interest_thb": _r(ahead[0]["interest"]) if ahead else _r(owed * d["rate"] / 12),
            "principal_thb": _r(ahead[0]["principal"]) if ahead else None,
            "paid_off": end, "paid_off_age": age(int(end[:4])) if end else None, "months_left": len(ahead),
            "interest_left_thb": _r(sum(e["interest"] for e in ahead)) if ahead else None, "never": never,
            "years": [{"year": int(e["month"][:4]), "balance_thb": _r(e["balance"])} for e in ahead if e["month"].endswith("-12") or e["month"] == end]}})

    def still_paying(loan, month):
        # a loan that never ends, or a month before the date its balance was typed for: the payment simply goes on
        return loan["owed"] > 0.005 and (loan["never"] or month <= loan["d"]["as_of"])

    def pay_of(loan, month):
        return loan["ahead"][month]["payment"] if month in loan["ahead"] else loan["d"]["payment"] if still_paying(loan, month) else 0.0

    def debt_pay(month):
        return sum(pay_of(l, month) for l in loans)

    def debt_owed(month):
        return sum(l["ahead"][month]["balance"] if month in l["ahead"] else l["owed"] if still_paying(l, month) else 0.0 for l in loans)

    # ---- the average month
    logged = flow_log_rows(lines, n)
    planned = planned or {}
    debt_lines = {l["d"].get("line") for l in loans if l["d"].get("line")}

    def not_a_debt(r):
        return not (r["group"] == "Fixed costs" and r["name"] in debt_lines)

    fixed_lines = [r["name"] for r in logged["spending"] if r["group"] == "Fixed costs"]
    logged["spending"] = [r for r in logged["spending"] if not_a_debt(r)]
    box = {"income": planned.get("income") or logged["income"],            # Best's rows for a box replace the log's
           "spending": [r for r in planned.get("spending") or logged["spending"] if not_a_debt(r)]}
    debt_rows = [{"group": "Debt", "name": l["view"]["name"], "amount": _r(pay_of(l, _month_add(now, 1)))} for l in loans]
    debt_now = sum(r["amount"] for r in debt_rows)
    income = {"salary": 0.0, "investment": 0.0, "shop": 0.0, "other": 0.0}
    taken = {"stock": 0.0, "trading": 0.0}                                  # return taken out of Investment as income
    for r in box["income"]:
        name = r["name"].strip().lower()
        key = "investment" if r["group"] == "Investment" else "salary" if (r["group"], name) == ("Active", "salary") else \
            "shop" if (r["group"], name) == ("Active", "online shop") else "other"
        income[key] += r["amount"]
        if key == "investment":
            taken["trading" if name == "trading" else "stock"] += r["amount"]
    spending = {"fixed": sum(r["amount"] for r in box["spending"] if r["group"] == "Fixed costs"), "debt": debt_now,
                "expense": sum(r["amount"] for r in box["spending"] if r["group"] == "Expenses")}
    base = sum(r["amount"] for r in box["spending"])                        # spending that is not a debt payment
    spend = base + debt_now
    earned = sum(r["amount"] for r in box["income"])
    goes_on = income["shop"] + income["other"]                              # income that does not need the job
    gap = max(0.0, spend - goes_on)
    gap_after = max(0.0, base - goes_on)
    shown = [r for r in box["spending"] if r["group"] == "Fixed costs"] + debt_rows + [r for r in box["spending"] if r["group"] != "Fixed costs"]
    spending_lines = [dict(l, detail=l["detail"] if l["label"] == "Debt" else "") for l in _display(shown, ("Fixed costs", "Expenses"))]

    # ---- Investment
    reinvest = reinvest or {}
    log_in = {"stock": avg("allocation", lambda x: x in ("Stock", "Investment")), "trading": avg("allocation", lambda x: x == "Trading")}
    put = {k: log_in[k] if reinvest.get(k) is None else float(reinvest[k]) for k in ("stock", "trading")}
    freed = bool(reinvest.get("freed"))
    saved = avg("allocation", lambda x: x not in INVESTMENT_REINVEST)
    stock, trading = cur["investment"], cur["trading"]
    ys, yt = yields["stock"], yields["trading"]
    expected = (stock * ys + trading * yt) / 12
    blended = (stock * ys + trading * yt) / (stock + trading) if stock + trading else None

    def coverage_of(monthly, need):
        return (monthly / need if need else 1.0) if spend else None

    # ---- month by month from next month: when does the return reach the gap?
    s_val, t_val = stock, trading
    gs, gt = (1 + ys) ** (1 / 12) - 1, (1 + yt) ** (1 / 12) - 1             # so a year grows by exactly the yield
    share = put["stock"] / (put["stock"] + put["trading"]) if put["stock"] + put["trading"] > 0 else 1.0
    reach = {"month": now, "months": 0} if spend and expected >= gap else None
    last = max([int(year) + 1] + [int(l["view"]["paid_off"][:4]) + 1 for l in loans if l["view"]["paid_off"]])
    projection = []
    for k in range(1, 481):
        month = _month_add(now, k)
        pay = debt_pay(month)
        need = max(0.0, base + pay - goes_on)
        extra = max(0.0, debt_now - pay) if freed else 0.0
        s_val = max(0.0, s_val * (1 + gs) + put["stock"] + extra * share - taken["stock"])
        t_val = max(0.0, t_val * (1 + gt) + put["trading"] + extra * (1 - share) - taken["trading"])
        monthly = (s_val * ys + t_val * yt) / 12
        if reach is None and spend and monthly >= need:
            reach = {"month": month, "months": k}
        if month.endswith("-12"):
            y = int(month[:4])
            projection.append({"year": y, "age": age(y), "investment_thb": _r(s_val + t_val), "return_thb": _r(monthly), "gap_thb": _r(need),
                               "debt_thb": _r(debt_owed(month))})
            if reach is not None and y >= max(last, int(reach["month"][:4]) + 1):
                break
    if reach:
        reach.update(year=int(reach["month"][:4]), age=age(int(reach["month"][:4])))
    # the years worth drawing: to a year past the goal and past the last debt, or 15 years when the goal is out of reach
    projection = [p for p in projection if p["year"] <= max(last, reach["year"] + 1 if reach else int(year) + 15)]

    path = []
    for r in roadmap or []:
        monthly = (r["plan"]["investment"] * ys + r["plan"]["trading"] * yt) / 12
        need = max(0.0, base + debt_pay(f"{r['year']}-12") - goes_on)
        path.append({"year": r["year"], "age": r["age"], "return_thb": _r(monthly), "gap_thb": _r(need), "coverage": coverage_of(monthly, need)})
    reached = next((p for p in path if p["coverage"] is not None and p["coverage"] >= 1), None)
    offs = [l["view"]["paid_off"] for l in loans]
    debt_free = max(offs) if offs and all(offs) else None
    return {"year": int(year), "month": now, "months": n, "first_month": months[0] if months else None,
            "planned": sorted(k for k in ("income", "spending") if planned.get(k)), "logged": logged, "rows": box,
            "income_lines": _display(box["income"], ("Active",)), "spending_lines": spending_lines,
            "income": {k: _r(v) for k, v in income.items()}, "income_thb": _r(earned),
            "spending": {k: _r(v) for k, v in spending.items()}, "spending_thb": _r(spend),
            "goes_on_thb": _r(goes_on), "gap_thb": _r(gap), "gap_after_thb": _r(gap_after),
            "reinvest": {"stock": _r(put["stock"]), "trading": _r(put["trading"]), "freed": freed,
                         "planned": [k for k in ("stock", "trading") if reinvest.get(k) is not None], "logged": {k: _r(v) for k, v in log_in.items()}},
            "reinvest_thb": _r(put["stock"] + put["trading"]), "saved_thb": _r(saved),
            "free_thb": _r(earned - spend - put["stock"] - put["trading"] - saved),
            "investment": {"stock": stock, "trading": trading, "total": _r(stock + trading)},
            "yields": {"stock": ys, "trading": yt, "blended": blended},
            "expected_return_thb": _r(expected), "coverage": coverage_of(expected, gap),
            "actual_coverage": income["investment"] / spend if spend else None,
            "needed_thb": _r(gap * 12 / blended) if blended and spend else None,
            "needed_after_thb": _r(gap_after * 12 / blended) if blended and spend and loans else None,
            "fixed_lines": fixed_lines, "debts": [l["view"] for l in loans], "debt_thb": _r(sum(l["owed"] for l in loans)),
            "debt_free": {"month": debt_free, "age": age(int(debt_free[:4]))} if debt_free else None,
            "reach": reach, "projection": projection,
            "path": path, "covered_year": reached["year"] if reached else None, "covered_age": reached["age"] if reached else None}


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
