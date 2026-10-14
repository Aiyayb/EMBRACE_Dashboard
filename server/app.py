"""EMBRACE Dashboard back end. Stdlib only (openpyxl is needed only to read the family ledger).

    python server/app.py        ->  http://127.0.0.1:8770

This system reads figures and records them. It holds no credential that can
trade, transfer or withdraw, and has no route that moves money (ADR 0002).
"""
import calendar
import json
import mimetypes
import os
import re
import sqlite3
import sys
import traceback
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import audit  # noqa: E402
import auth  # noqa: E402
import backup  # noqa: E402
import config  # noqa: E402
import db  # noqa: E402
import lock  # noqa: E402
import metrics  # noqa: E402
from sources import family, journal as journal_file, shop  # noqa: E402

CFG = config.load()
LOCAL_HOSTS = ("localhost", "127.0.0.1")


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- helpers
def rows(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def as_date(value, field):
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        raise ApiError(f"{field} must be a date in YYYY-MM-DD form")


def as_num(value, field):
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ApiError(f"{field} must be a number")


def picker(body, old):
    """Value from the request, else from the existing row, else the default."""
    def pick(key, default=None):
        if key in body:
            # a blank field in a form arrives as null: fall back to the default where one exists
            return default if body[key] is None and default is not None else body[key]
        return old[key] if old else default
    return pick


def text(value, field, required=False):
    value = (str(value).strip() if value is not None else "")
    if required and not value:
        raise ApiError(f"{field} is required")
    return value or None


def account(conn, account_id):
    try:
        acc = conn.execute("SELECT * FROM accounts WHERE id=?", (int(account_id),)).fetchone()
    except (TypeError, ValueError):
        acc = None
    if acc is None:
        raise ApiError("account_id does not name an Account")
    return acc


# ---------------------------------------------------------------- field rules per resource
# each: (conn, body, old_row_or_None, actor) -> column values to write
def clean_holdings(value):
    """[{market, stock, qty, value_thb}] -> normalised list. Market may be blank (no breakdown); value is THB."""
    if not isinstance(value, list) or not value:
        raise ApiError("holdings must be a list with at least one row")
    out = []
    for n, h in enumerate(value, 1):
        if not isinstance(h, dict):
            raise ApiError(f"holdings row {n} must be an object")
        market = text(h.get("market"), "market") or ""
        if len(market) > 12:
            raise ApiError(f"holdings row {n}: market is too long")
        v = as_num(h.get("value_thb"), f"holdings row {n} value")
        if v <= 0:
            raise ApiError(f"holdings row {n}: value must be above zero")
        qty = h.get("qty")
        out.append({"market": market.upper(), "stock": text(h.get("stock"), "stock") or "",
                    "qty": None if qty in (None, "") else as_num(qty, f"holdings row {n} qty"), "value_thb": round(v, 2)})
    return out


def clean_snapshot(conn, body, old, actor):
    pick = picker(body, old)
    acc = account(conn, pick("account_id"))
    if acc["source"] != "manual":
        raise ApiError(f"{acc['name']} takes its value from its own source and has no Snapshots")
    holdings = None
    if body.get("holdings") is not None:
        if acc["currency"] != "THB":
            raise ApiError(f"holdings are entered in THB; {acc['name']} is in {acc['currency']}")
        holdings = clean_holdings(body["holdings"])
        body = dict(body, value_native=round(sum(h["value_thb"] for h in holdings), 2))
        pick = picker(body, old)
    value = as_num(pick("value_native"), "value_native")
    if acc["currency"] == "THB":
        fx = 1.0
    else:
        fx = as_num(pick("fx_rate"), f"fx_rate (THB per 1 {acc['currency']})")
        if fx <= 0:
            raise ApiError("fx_rate must be above zero")
    vals = {"account_id": acc["id"], "as_of": as_date(pick("as_of"), "as_of"), "value_native": value,
            "fx_rate": fx, "value_thb": round(value * fx, 2), "note": text(pick("note"), "note")}
    if holdings is not None:
        vals["holdings"] = json.dumps(holdings, ensure_ascii=False)
    elif old is not None and old["holdings"] and "value_native" in body:
        vals["holdings"] = None                      # a new total with no breakdown: the old breakdown no longer adds up
    if old is None:
        vals.update(entered_by=actor, created_at=db.now())
    return vals


def clean_flow(conn, body, old, actor):
    pick = picker(body, old)
    acc = account(conn, pick("account_id"))
    amount = as_num(pick("amount_thb"), "amount_thb")
    if amount == 0:
        raise ApiError("amount_thb cannot be zero (use + for a deposit, - for a withdrawal)")
    kind = "opening" if pick("kind") == "opening" else ("deposit" if amount > 0 else "withdrawal")
    vals = {"account_id": acc["id"], "on_date": as_date(pick("on_date"), "on_date"), "amount_thb": amount,
            "kind": kind, "note": text(pick("note"), "note")}
    if old is None:
        vals.update(entered_by=actor, created_at=db.now())
    return vals


def clean_account(conn, body, old, actor):
    pick = picker(body, old)
    bucket = pick("bucket")
    if bucket not in metrics.BUCKETS:
        raise ApiError("bucket must be investment, trading or wealth")
    allocation = pick("allocation") or "saving"
    if allocation not in ("saving", "emc"):
        raise ApiError("allocation must be saving or emc")
    vals = {"name": text(pick("name"), "name", required=True), "bucket": bucket,
            "currency": (text(pick("currency", "THB"), "currency") or "THB").upper(),
            "counts_in_total": 1 if pick("counts_in_total", 1) else 0,
            "allocation": allocation if bucket == "wealth" else None,
            "note": text(pick("note"), "note"), "active": 1 if pick("active", 1) else 0}
    if old is None:
        vals.update(source="manual", created_at=db.now())
    return vals


def optional_num(value, field):
    return None if value in (None, "") else as_num(value, field)


def clean_trade(conn, body, old, actor):
    pick = picker(body, old)
    outcome = pick("outcome") or None
    if outcome not in (None, "win", "loss", "be"):
        raise ApiError("outcome must be win, loss, be or empty")
    vals = {"traded_on": as_date(pick("traded_on"), "traded_on"), "outcome": outcome}
    for k in ("session", "pair", "side", "setup", "exit_plan", "exit_actual", "grade", "note",
              "poi", "signal", "divergence", "confirm", "fib_time", "fib", "exit_a"):
        vals[k] = text(pick(k), k)
    for k in ("pic_setup", "pic_entry", "pic_exit"):
        link = text(pick(k), k)
        if link and not link.lower().startswith(("https://", "http://")):
            raise ApiError(f"{k} must be a link starting with https://")
        vals[k] = link
    for k in ("pnl", "balance", "risk", "rr"):
        vals[k] = optional_num(pick(k), k)
    return vals


def clean_benchmark(conn, body, old, actor):
    pick = picker(body, old)
    value = as_num(pick("value"), "value")
    if value <= 0:
        raise ApiError("value must be above zero")
    return {"name": text(pick("name"), "name", required=True).upper(), "as_of": as_date(pick("as_of"), "as_of"),
            "value": value}


def clean_cashflow(conn, body, old, actor):
    pick = picker(body, old)
    month = str(pick("month") or "")
    if not re.match(r"^[0-9]{4}-(0[1-9]|1[0-2])$", month):
        raise ApiError("month must be in YYYY-MM form")
    if pick("section") not in ("income", "fixed_cost", "expense", "allocation"):
        raise ApiError("section must be income, fixed_cost, expense or allocation")
    vals = {"month": month, "section": pick("section"), "line": text(pick("line"), "line", required=True),
            "amount_thb": as_num(pick("amount_thb"), "amount_thb"), "note": text(pick("note"), "note")}
    if old is None:
        vals.update(entered_by=actor, created_at=db.now())
    return vals


def clean_asset(conn, body, old, actor):
    pick = picker(body, old)
    return {"name": text(pick("name"), "name", required=True),
            "asset_class": text(pick("asset_class"), "asset_class", required=True),
            "value_thb": as_num(pick("value_thb", 0), "value_thb"),
            "valued_on": as_date(pick("valued_on", date.today().isoformat()), "valued_on"),
            "debt_thb": as_num(pick("debt_thb", 0) or 0, "debt_thb"),
            "monthly_income_thb": optional_num(pick("monthly_income_thb"), "monthly_income_thb"),
            "monthly_cost_thb": optional_num(pick("monthly_cost_thb"), "monthly_cost_thb"),
            "note": text(pick("note"), "note"), "entered_by": actor, "updated_at": db.now()}


def clean_goal(conn, body, old, actor):
    pick = picker(body, old)
    bucket = pick("bucket")
    if bucket is not None and bucket not in metrics.BUCKETS:
        raise ApiError("bucket must be investment, trading, wealth or null")
    try:
        year = int(pick("year"))
    except (TypeError, ValueError):
        raise ApiError("year must be a whole number")
    optional = lambda key: None if pick(key) in (None, "") else as_num(pick(key), key)   # noqa: E731
    growth = optional("growth_pct")
    if growth is not None and not -1 <= growth <= 10:
        raise ApiError("growth_pct is a share: 0.15 means 15%")
    return {"year": year, "name": text(pick("name"), "name", required=True), "bucket": bucket or None,
            "goal_thb": as_num(pick("goal_thb"), "goal_thb"), "monthly_thb": optional("monthly_thb"),
            "growth_pct": growth, "note": text(pick("note"), "note")}


def clean_upcoming(conn, body, old, actor):
    pick = picker(body, old)
    amount = pick("amount_thb")
    vals = {"due_date": as_date(pick("due_date"), "due_date"), "item": text(pick("item"), "item", required=True),
            "kind": text(pick("kind", "Bill"), "kind") or "Bill",
            "amount_thb": None if amount in (None, "") else as_num(amount, "amount_thb"),
            "done": 1 if pick("done", 0) else 0}
    if old is None:
        vals.update(entered_by=actor, created_at=db.now())
    return vals


def clean_project(conn, body, old, actor):
    pick = picker(body, old)
    progress = as_num(pick("progress", 0), "progress")
    if not 0 <= progress <= 1:
        raise ApiError("progress must be between 0 and 1")
    return {"name": text(pick("name"), "name", required=True), "track": text(pick("track"), "track"),
            "status": text(pick("status"), "status"), "progress": progress,
            "next_step": text(pick("next_step"), "next_step"), "entered_by": actor, "updated_at": db.now()}


def clean_advice(conn, body, old, actor):
    pick = picker(body, old)
    refs = pick("refs")
    if isinstance(refs, str) and old is not None and "refs" not in body:
        refs_json = refs                      # unchanged stored JSON
    else:
        refs_json = None if refs is None else json.dumps(refs, ensure_ascii=False)
    vals = {"noted_on": as_date(pick("noted_on", date.today().isoformat()), "noted_on"),
            "topic": text(pick("topic"), "topic", required=True),
            "body": text(pick("body"), "body", required=True), "refs": refs_json}
    if old is None:
        vals.update(entered_by=actor, created_at=db.now())
    return vals


def clean_link(conn, body, old, actor):
    pick = picker(body, old)
    url = (text(pick("url"), "url") or "")
    if url and not re.match(r"^(https://|tg://)", url):
        raise ApiError("url must start with https:// (or tg://)")
    return {"name": text(pick("name"), "name", required=True), "url": url, "updated_at": db.now()}


# name -> table, rule, whether Maki may write it, list order
RESOURCES = {
    "snapshots": ("snapshots", clean_snapshot, True, "as_of DESC, id DESC"),
    "flows": ("flows", clean_flow, True, "on_date DESC, id DESC"),
    "upcoming": ("upcoming_items", clean_upcoming, True, "done, due_date, id"),
    "projects": ("projects", clean_project, True, "name"),
    "advice": ("advice_notes", clean_advice, True, "noted_on DESC, id DESC"),
    "trades": ("trades", clean_trade, True, "traded_on DESC, id DESC"),
    "benchmarks": ("benchmarks", clean_benchmark, True, "name, as_of DESC"),
    "cashflow": ("cashflow_lines", clean_cashflow, True, "month DESC, section, line"),
    "assets": ("assets", clean_asset, True, "asset_class, name"),
    "links": ("links", clean_link, False, "id"),
    "goals": ("goals", clean_goal, False, "year, name"),
    "accounts": ("accounts", clean_account, False, "bucket, name"),
}


def may_write(who, resource):
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST and not RESOURCES[resource][2]:
        raise ApiError(f"{who} may not change {resource}; only Best can, from the dashboard", 403)


# ---------------------------------------------------------------- handlers
# each handler: (conn, body, query, who, *path_args) -> JSON-able
def h_whoami(conn, body, q, who):
    return {"actor": who, "can_write": who is not None,
            "writable": [r for r, spec in RESOURCES.items() if who == auth.BEST or (who and spec[2])]}


def shop_rows(conn):
    """The shop's monthly P&L entries typed in the dashboard: {(year, month): [{section, line, amount}]}."""
    return {(r["year"], r["month"]): json.loads(r["entries"]) for r in conn.execute("SELECT year, month, entries FROM shop_months")}


def shop_months(conn):
    return {"available": True, "reason": None, "months": shop.revenue_months(shop_rows(conn))}


def seed_shop_months(conn, shop_db_path):
    """One-time copy of the shop app's typed monthly P&L into shop_months (ADR 0003). Does nothing once any month exists,
    so Best's edits are never overwritten, and nothing when the shop database is missing."""
    if conn.execute("SELECT 1 FROM shop_months LIMIT 1").fetchone():
        return 0
    legacy = shop.legacy_months(shop_db_path)
    for (year, month), entries in sorted(legacy.items()):
        conn.execute("INSERT INTO shop_months(year, month, entries, entered_by, created_at) VALUES (?,?,?,?,?)",
                     (year, month, json.dumps(entries, ensure_ascii=False), "import", db.now()))
    conn.commit()
    return len(legacy)


def monthly_rows(conn):
    """metrics.monthly with the Family Statement balance taken from its ledger."""
    fam = family.ledger(CFG["family_xlsx_path"])
    points = [(t["date"], t["balance"]) for t in fam["transactions"]]
    derived = {a["id"]: points for a in conn.execute("SELECT id FROM accounts WHERE source='family_statement'")}
    return metrics.monthly(conn, derived if points else None)


def finished_rows(conn):
    """monthly_rows up to the last month that has ended. A month still in progress has only some of its
    values entered, so its total and return would mislead; it appears once the month is over."""
    months = monthly_rows(conn)
    this_month = date.today().strftime("%Y-%m")
    return [m for m in months if m["month"] < this_month] or months


def live_rows(conn):
    """finished_rows plus one row for the month in progress as it stands now (metrics.live_row): every counted Account at its latest
    Snapshot, the Family Statement at its ledger balance, Trading at the journal figure the Trading Portfolio tile shows. Used for
    the figures that say where things stand today (Total Portfolio Value, Allocation, the year's target, Net Worth); the charts and
    returns keep to finished months."""
    finished = finished_rows(conn)
    this_month = date.today().strftime("%Y-%m")
    if not finished or finished[-1]["month"] >= this_month:
        return finished
    accounts = metrics.latest_values(conn)
    values = {a["id"]: a["snapshot"]["value_thb"] for a in accounts if a["snapshot"] and a["source"] == "manual"}
    fam = family.ledger(CFG["family_xlsx_path"])
    if fam.get("available") and fam.get("balance") is not None:
        values.update({a["id"]: fam["balance"] for a in accounts if a["source"] == "family_statement"})
    live = live_values(conn).get("trading")
    in_progress = next((m for m in monthly_rows(conn) if m["month"] == this_month), None)
    return finished + [metrics.live_row(finished[-1], this_month, accounts, values, live[0] if live else None,
                                        in_progress["net_flow"] if in_progress else 0.0)]


def h_home(conn, body, q, who):
    months = finished_rows(conn)
    now = live_rows(conn)           # the same months plus the one in progress, for the figures that say where things stand today
    shop_data = shop_months(conn)
    year = int(months[-1]["month"][:4]) if months else date.today().year
    kpis = metrics.kpis(now, shop_data["months"])
    if kpis and now is not months:  # the shop's revenue is a monthly figure: keep the last finished month's
        kpis.update({k: v for k, v in metrics.kpis(months, shop_data["months"]).items() if k.startswith("shop_")})
    return {
        "kpis": kpis,
        "monthly": months,
        "performance": metrics.performance(conn, months),
        "growth": metrics.value_growth_vs_benchmark(conn, months),
        # this year's growth in Total Portfolio Value, deposits included, from the previous December's close
        "growth_year": metrics.value_growth_vs_benchmark(conn, months, start=f"{int(months[-1]['month'][:4]) - 1}-12") if months else [],
        "allocation": metrics.allocation(now),
        "goals": metrics.goal_progress(conn, now, year),
        "upcoming": rows(conn, "SELECT * FROM upcoming_items WHERE done=0 ORDER BY due_date, id LIMIT 8"),
        "projects": rows(conn, "SELECT * FROM projects ORDER BY name"),
        "shop": {"available": shop_data["available"], "reason": shop_data["reason"]},
        "flows_recorded_from": db.get_setting(conn, "flows_recorded_from") or None,
        "trading_journal": journal_view(conn).get("stats"),      # the figure the Trading page's Trading Portfolio tile shows
    }


def h_plan(conn, body, q, who):
    """The Plan page: this year's Goals, the road to the last Goal year, and Maki's notes about the plan."""
    income = {}
    try:        # OnTheWall's Goal is the shop's profit for dividend in the year
        years = shop.build_finance(shop_rows(conn), {}, float(db.get_setting(conn, "shop_dividend_split_onn")))
        income["OnTheWall"] = {y["year"]: round(sum(m["dividend_pool"] or 0 for m in y["months"]), 2) for y in years}
    except Exception:           # the shop figures are a comparison, never a reason for the Plan not to load
        traceback.print_exc()
    out = metrics.plan_view(conn, live_rows(conn), income) or {}
    if out.get("this_year"):
        live = live_values(conn)
        for item in out["this_year"]["items"]:
            now = live.get(item["group"])
            if now is not None and item["goal_thb"]:
                item.update(actual_thb=round(now[0], 2), progress=now[0] / item["goal_thb"], gap_thb=round(item["goal_thb"] - now[0], 2), as_of=now[1])
    out["advice"] = rows(conn, "SELECT * FROM advice_notes WHERE lower(topic) LIKE '%plan%' ORDER BY noted_on DESC, id DESC LIMIT 8")
    out["flow"] = metrics.finance_flow(conn, finished_rows(conn), plan_yields(conn), out.get("roadmap"), plan_flow(conn),
                                       plan_debts(conn), plan_reinvest(conn))
    return out


def live_values(conn):
    """Where each Allocation Group stands now, not at the last month end, so a figure entered this month moves the Goal bars the
    moment it is saved. {group: (value_thb, as_of)}; a group with nothing to read is left out.
    Stock: the latest Snapshot of its Accounts, this month's included. Trading: the same figure as the Trading Portfolio tile (the
    journal's Net Balance at the latest USDT rate), else the latest Snapshots. Saving Cash is the Family Statement ledger's
    balance and Saving Bitcoin the Bitcoin card's latest value."""
    fam = family.ledger(CFG["family_xlsx_path"])
    live = {}
    if fam.get("available") and fam.get("balance") is not None:
        live["emc"] = (fam["balance"], fam["last_date"])
    accounts = metrics.latest_values(conn)
    coin = next((a for a in accounts if a["bucket"] == "wealth" and a["name"] in ("Bitcoin", "BTC")), None)
    if coin:
        live["saving"] = (coin["snapshot"]["value_thb"], coin["snapshot"]["as_of"]) if coin["snapshot"] else (0.0, None)
    for group in ("investment", "trading"):
        snaps = [a["snapshot"] for a in accounts if a["bucket"] == group and a["snapshot"]]
        if snaps:
            live[group] = (sum(x["value_thb"] for x in snaps), max(x["as_of"] for x in snaps))
    stats = journal_view(conn).get("stats")
    if stats and stats.get("fx"):
        last = conn.execute("SELECT MAX(traded_on) FROM trades").fetchone()[0]
        live["trading"] = (stats["value"] * stats["fx"], last)
    return live


GOAL_GROUP = {"Stock": "investment", "Trading": "trading", "Saving Cash": "emc", "Saving Bitcoin": "saving"}


def h_goal_bars(conn, body, q, who):
    """Progress of one year's Goals for the bars at the top of the Stock, Trading, Online Shop and Saving pages:
    {name: {goal_thb, actual_thb, as_of}}. A year's actual is the value at its December (or the latest finished month for the
    current year); Saving Cash and Saving Bitcoin use the live card values for the current year. OnTheWall is the shop's profit
    for dividend in the year, with the latest month against its monthly aim. A year with no Goal returns nothing."""
    finished = finished_rows(conn)
    if not finished:
        return {"year": None, "bars": {}}
    latest = finished[-1]
    asked = (q.get("year") or [None])[0]
    year = int(asked) if asked and asked.isdigit() else int(latest["month"][:4])
    by = {r["month"]: r for r in finished}
    ref = by.get(f"{year}-12") or (latest if latest["month"][:4] == str(year) else None)
    values = metrics.group_values(ref) if ref else {}
    live = live_values(conn) if ref is latest else {}
    bars = {}
    for g in conn.execute("SELECT * FROM goals WHERE year=?", (year,)):
        name = g["name"]
        if name in GOAL_GROUP and ref:
            group = GOAL_GROUP[name]
            now = live.get(group)
            value, as_of = (now if now is not None else (values.get(group, 0.0), ref["month"]))
            bars[name] = {"goal_thb": round(g["goal_thb"], 2), "actual_thb": round(value, 2), "as_of": as_of}
        elif name == "OnTheWall":
            try:
                months = [m for y in shop.build_finance(shop_rows(conn), {}, 0.6) if y["year"] == year for m in y["months"] if m["dividend_pool"] is not None]
            except Exception:
                traceback.print_exc()
                months = []
            bar = {"goal_thb": round(g["goal_thb"], 2), "actual_thb": round(sum(m["dividend_pool"] for m in months), 2), "as_of": None}
            if g["monthly_thb"] and months:
                bar["month"] = {"month": months[-1]["month"], "actual_thb": months[-1]["dividend_pool"], "aim_thb": round(g["monthly_thb"], 2)}
            bars[name] = bar
    return {"year": year, "bars": bars}


def plan_yields(conn):
    return {"stock": float(db.get_setting(conn, "plan_yield_stock")), "trading": float(db.get_setting(conn, "plan_yield_trading"))}


def h_plan_yields(conn, body, q, who):
    """The yearly yields the plan counts on for Stock and Trading, as shares (0.15 = 15%). Best only."""
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST:
        raise ApiError(f"{who} may not change the plan's yields; only Best can, from the dashboard", 403)
    out = {}
    for key in ("stock", "trading"):
        value = as_num(body.get(key), key)
        if not 0 <= value <= 5:
            raise ApiError(f"{key} is a share of the value per year: 0.15 means 15%")
        out[key] = value
    for key, value in out.items():
        db.set_setting(conn, f"plan_yield_{key}", value)
    return out


def plan_flow(conn):
    """The rows Best typed into the Income and Spending tables of the Plan page, {"income": [{group, name, amount}], "spending": [...]};
    a box with no rows here shows the Cash flow log's average instead."""
    try:
        saved = json.loads(db.get_setting(conn, "plan_flow") or "{}")
    except ValueError:
        saved = {}
    return {k: v for k, v in saved.items() if k in metrics.FLOW_GROUPS and isinstance(v, list) and v} if isinstance(saved, dict) else {}


def h_plan_flow(conn, body, q, who):
    """Set the rows of the Plan page's Income or Spending table: {"box": "income", "rows": [{"group": "Active", "name": "Salary",
    "amount": 120000}]}. rows null puts back the Cash flow log's average. Best only; the log itself is not changed."""
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST:
        raise ApiError(f"{who} may not change the plan's figures; only Best can, from the dashboard", 403)
    box, rows_in = body.get("box"), body.get("rows")
    if box not in metrics.FLOW_GROUPS:
        raise ApiError("box: income or spending")
    saved = plan_flow(conn)
    if rows_in is None:
        saved.pop(box, None)
    else:
        if not isinstance(rows_in, list) or not rows_in:
            raise ApiError("rows: a list of {group, name, amount}, or null for the log's average")
        clean = []
        for r in rows_in:
            group, name = str((r or {}).get("group") or "").strip(), str((r or {}).get("name") or "").strip()
            if group not in metrics.FLOW_GROUPS[box]:
                raise ApiError(f"group for {box}: {', '.join(metrics.FLOW_GROUPS[box])}")
            if not name or len(name) > 60:
                raise ApiError("every row needs a name (up to 60 characters)")
            amount = as_num((r or {}).get("amount"), "amount")
            if amount < 0:
                raise ApiError("an amount cannot be negative")
            clean.append({"group": group, "name": name, "amount": amount})
        saved[box] = clean
    db.set_setting(conn, "plan_flow", json.dumps(saved))
    return saved


def best_only(who, what):
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST:
        raise ApiError(f"{who} may not change {what}; only Best can, from the dashboard", 403)


def setting_json(conn, key, kind):
    try:
        saved = json.loads(db.get_setting(conn, key) or "null")
    except ValueError:
        saved = None
    return saved if isinstance(saved, kind) else kind()


def plan_debts(conn):
    """The debts of the Plan page's model: [{name, line, balance, as_of, rate, payment}]. `balance` is what was owed in the month
    `as_of`; `rate` is the yearly interest as a share; `line` names the Fixed-cost line of the Cash flow log that is this payment."""
    return [d for d in setting_json(conn, "plan_debts", list) if isinstance(d, dict)]


def h_plan_debts(conn, body, q, who):
    """Replace the debts of the Plan page's model: {"debts": [{"name": "House debt", "balance": 2156326, "as_of": "2026-10",
    "rate": 0.031, "payment": 35000, "line": "House debt"}]}. An empty list removes them all. Best only."""
    best_only(who, "the plan's debts")
    items = body.get("debts")
    if not isinstance(items, list):
        raise ApiError("debts: a list of {name, balance, as_of, rate, payment, line}")
    clean, seen = [], set()
    for d in items:
        d = d if isinstance(d, dict) else {}
        name = str(d.get("name") or "").strip()
        if not name or len(name) > 60 or name.lower() in seen:
            raise ApiError("every debt needs its own name (up to 60 characters)")
        seen.add(name.lower())
        balance, rate, payment = as_num(d.get("balance"), "balance"), as_num(d.get("rate"), "rate"), as_num(d.get("payment"), "payment")
        if balance < 0:
            raise ApiError("a balance cannot be negative")
        if not 0 <= rate <= 1:
            raise ApiError("rate is the yearly interest as a share: 0.031 means 3.1%")
        if payment <= 0:
            raise ApiError("payment is what is paid each month, above 0")
        as_of = str(d.get("as_of") or date.today().strftime("%Y-%m"))
        if not re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])", as_of):
            raise ApiError("as_of is the month the balance is for, like 2026-10")
        clean.append({"name": name, "line": str(d.get("line") or "").strip()[:60], "balance": balance, "as_of": as_of, "rate": rate, "payment": payment})
    db.set_setting(conn, "plan_debts", json.dumps(clean))
    return clean


def plan_reinvest(conn):
    """What the Plan page's model puts into Stock and Trading each month: {"stock", "trading", "freed"}. A missing or null amount
    means the Cash flow log's average; `freed` also reinvests the payment of a debt once it is paid off."""
    return setting_json(conn, "plan_reinvest", dict)


def h_plan_reinvest(conn, body, q, who):
    """Set the model's monthly reinvestment: {"stock": 15000, "trading": null, "freed": true}. null = the log's average. Best only."""
    best_only(who, "the plan's reinvestment")
    out = {"freed": bool(body.get("freed"))}
    for key in ("stock", "trading"):
        if body.get(key) is not None:
            out[key] = as_num(body[key], key)
            if out[key] < 0:
                raise ApiError(f"{key} cannot be negative")
    db.set_setting(conn, "plan_reinvest", json.dumps(out))
    return out


def h_monthly(conn, body, q, who):
    return monthly_rows(conn)


def h_networth(conn, body, q, who):
    return metrics.net_worth(conn, live_rows(conn))


def bucket_view(conn, bucket):
    accounts = [a for a in metrics.latest_values(conn) if a["bucket"] == bucket]
    months = [{k: m[k] for k in ("month", bucket, "flows_known", "stale")} for m in monthly_rows(conn)]
    return accounts, months


def h_investment(conn, body, q, who):
    accounts, months = bucket_view(conn, "investment")
    finished = finished_rows(conn)
    years = sorted({m["month"][:4] for m in finished if m["investment"]}, reverse=True)
    asked = (q.get("year") or [None])[0]
    year = int(asked if asked in years else years[0] if years else (finished[-1]["month"][:4] if finished else date.today().year))
    return {"accounts": accounts, "monthly": months,
            "benchmark": rows(conn, "SELECT as_of, value FROM benchmarks WHERE name='SET' ORDER BY as_of"),
            "benchmarks": rows(conn, "SELECT id, name, as_of, value FROM benchmarks WHERE name IN ('SET', 'BTC') ORDER BY as_of, name"),
            "stats": metrics.bucket_stats(finished, "investment"),
            "years": years, "year": str(year),
            "growth_year": metrics.value_growth_vs_benchmark(conn, finished, start=f"{year - 1}-12", end=f"{year}-12", field="investment"),
            "growth": metrics.value_growth_vs_benchmark(conn, finished, field="investment"),
            "markets": metrics.market_breakdown(conn),
            "flows_recorded_from": db.get_setting(conn, "flows_recorded_from") or None}


def journal_view(conn, year=None):
    """The trade journal's stats and rows (the chart rows cover `year`); stats carry the latest THB-per-USDT rate, so its balance can be shown in THB."""
    stats = metrics.journal_stats(conn, float(db.get_setting(conn, "journal_start_balance")), year=year,
                                  start_date=db.get_setting(conn, "journal_start_date"))
    journal = {"stats": {k: v for k, v in stats.items() if k != "rows"}, "rows": stats["rows"]} if stats else {}
    if stats:
        fx = conn.execute("SELECT s.fx_rate, s.as_of FROM snapshots s JOIN accounts a ON a.id = s.account_id "
                          "WHERE a.bucket='trading' AND a.currency='USDT' ORDER BY s.as_of DESC, s.id DESC LIMIT 1").fetchone()
        journal["stats"].update(fx=fx["fx_rate"] if fx else None, fx_as_of=fx["as_of"] if fx else None)
    return journal


def h_trading(conn, body, q, who):
    accounts, _ = bucket_view(conn, "trading")
    months = [{k: m[k] for k in ("month", "trading", "trading_flow", "trading_pnl", "trading_pnl_pct",
                                 "flows_known", "stale")} for m in monthly_rows(conn)]
    journal = journal_view(conn, journal_year(conn, q))
    return {"accounts": accounts, "monthly": months, "journal": metrics.trade_stats(conn),
            "stats": journal.get("stats"),
            "journal_source": journal_source(conn),
            "benchmarks": rows(conn, "SELECT id, name, as_of, value FROM benchmarks WHERE name IN ('SET', 'BTC') ORDER BY as_of, name"),
            "trades": rows(conn, "SELECT * FROM trades ORDER BY traded_on DESC, id DESC LIMIT 200"),
            "sheet": metrics.journal_sheet(conn, float(db.get_setting(conn, "journal_start_balance")),
                                           float(db.get_setting(conn, "journal_risk_pct")), journal_year(conn, q)),
            "journal_months": metrics.journal_months(conn, float(db.get_setting(conn, "journal_start_balance")),
                                                     db.get_setting(conn, "journal_start_date")),
            "journal_start_date": db.get_setting(conn, "journal_start_date"),
            "grades": json.loads(db.get_setting(conn, "journal_grade_notes")),
            "growth_year": journal.get("rows", []),
            "growth": []}       # the journal starts in 2026, so there is no longer history to draw


def journal_year(conn, q):
    """The year the journal view covers: ?year=YYYY, else the latest year with a trade, else this year."""
    asked = (q.get("year") or [None])[0]
    if asked and asked.isdigit() and len(asked) == 4:
        return asked
    latest = conn.execute("SELECT MAX(substr(traded_on, 1, 4)) FROM trades").fetchone()[0]
    return latest or str(date.today().year)


def h_journal_grades(conn, body, q, who):
    """What the Grades A, B and C mean in the trade journal. Best only."""
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST:
        raise ApiError(f"{who} may not change the journal's grade notes; only Best can, from the dashboard", 403)
    notes = {g: text(body.get(g), g) or "" for g in ("A", "B", "C")}
    if any(len(v) > 80 for v in notes.values()):
        raise ApiError("each grade note must be 80 characters or fewer")
    db.set_setting(conn, "journal_grade_notes", json.dumps(notes, ensure_ascii=False))
    return notes


def journal_source(conn):
    """The journal workbook the trades are mirrored from: when it was saved, when the dashboard last read it, and whether it changed since."""
    path = CFG["journal_workbook_path"]
    synced = db.get_setting(conn, "journal_synced_at") or None
    try:
        saved = datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d %H:%M:%S")
    except OSError:
        saved = None
    return {"file": os.path.basename(path), "exists": saved is not None, "saved_at": saved, "synced_at": synced,
            "stale": bool(saved and (not synced or saved > synced))}


def h_journal_sync(conn, body, q, who):
    """Read the journal workbook again and make the trades match it exactly (Excel is the source). Best only."""
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST:
        raise ApiError(f"{who} may not sync the journal; only Best can, from the dashboard", 403)
    path = CFG["journal_workbook_path"]
    if not os.path.exists(path):
        raise ApiError(f"the journal workbook was not found: {path}", 404)
    try:
        trades = journal_file.parse(path)
    except Exception as e:           # a locked, half-saved or renamed-sheet workbook; nothing is changed
        raise ApiError(f"could not read the journal workbook ({e}); nothing was changed") from e
    if not trades:
        raise ApiError("the journal sheet has no trades, so nothing was changed")
    conn.commit()
    if not backup.has_backup_today(CFG["backup_dir"]) or conn.execute("SELECT 1 FROM trades WHERE source_row IS NULL LIMIT 1").fetchone():
        backup.make_backup(CFG["db_path"], CFG["backup_dir"], "pre-journal-sync")      # the trades about to be replaced
    added, removed = journal_file.mirror(conn, trades)
    db.set_setting(conn, "journal_synced_at", db.now())
    conn.commit()
    return {"trades": len(trades), "added": added, "removed": removed, "source": journal_source(conn)}


def open_workbook(who, key, what):
    """Open a configured workbook in Excel on this machine. Best only; the path is the configured one, never a request value."""
    if who != auth.BEST:
        raise ApiError(f"only Best can open the {what}, from the dashboard", 403 if who else 401)
    path = CFG[key]
    if not os.path.exists(path):
        raise ApiError(f"the {what} was not found: {path}", 404)
    if not hasattr(os, "startfile"):
        raise ApiError("opening the workbook needs Windows", 400)
    os.startfile(path)
    return {"opened": os.path.basename(path)}


def h_journal_open(conn, body, q, who):
    return open_workbook(who, "journal_workbook_path", "journal workbook")


def h_fund_open(conn, body, q, who):
    return open_workbook(who, "fund_workbook_path", "Fund Management workbook")


def h_journal_settings(conn, body, q, who):
    """Start balance and Risk Per Trade of the trade journal. Best only."""
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST:
        raise ApiError(f"{who} may not change the journal's settings; only Best can, from the dashboard", 403)
    start = as_num(body.get("start_balance"), "start_balance")
    risk = as_num(body.get("risk_pct"), "risk_pct")
    if start <= 0:
        raise ApiError("start_balance must be above zero")
    if not 0 < risk <= 1:
        raise ApiError("risk_pct is a share of the balance, between 0 and 1 (0.1 = 10%)")
    db.set_setting(conn, "journal_start_balance", str(start))
    db.set_setting(conn, "journal_risk_pct", str(risk))
    if body.get("start_date"):
        db.set_setting(conn, "journal_start_date", as_date(body["start_date"], "start_date"))
    return {"start_balance": start, "risk_pct": risk, "start_date": db.get_setting(conn, "journal_start_date")}


def h_wealth(conn, body, q, who):
    cards, months = bucket_view(conn, "wealth")
    fam = family.ledger(CFG["family_xlsx_path"])
    for c in cards:
        if c["source"] == "family_statement":
            c["live"] = {"available": fam["available"], "reason": fam["reason"],
                         "value_thb": fam.get("balance"), "as_of": fam.get("last_date")}
    return {"cards": cards, "monthly": months}


def h_family(conn, body, q, who):
    return family.ledger(CFG["family_xlsx_path"])


def h_shop(conn, body, q, who):
    return shop_months(conn)


AVATAR_MAX = 400_000        # bytes of the data URL; the page shrinks the photo to a small square first
AVATAR_RX = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")


def avatar_path():
    return os.path.join(CFG["data_dir"], "avatar.txt")


def h_avatar(conn, body, q, who):
    try:
        with open(avatar_path(), encoding="ascii") as f:
            return {"image": f.read()}
    except OSError:
        return {"image": None}


def h_avatar_set(conn, body, q, who):
    # a profile picture, not financial data, so it is a plain file and not in the audit log; still Best only
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST:
        raise ApiError("only Best can change the profile photo, from the dashboard", 403)
    image = body.get("image")
    if image is None:
        try:
            os.remove(avatar_path())
        except OSError:
            pass
        return {"image": None}
    if not isinstance(image, str) or len(image) > AVATAR_MAX or not AVATAR_RX.match(image):
        raise ApiError("the photo must be a small JPEG, PNG or WebP image")
    with open(avatar_path(), "w", encoding="ascii") as f:
        f.write(image)
    return {"image": image}


def h_shop_finance(conn, body, q, who):
    orders = shop.orders_by_month(CFG["shop_db_path"])
    split = float(db.get_setting(conn, "shop_dividend_split_onn"))
    years = shop.build_finance(shop_rows(conn), orders, split)
    paid = [m for y in years for m in y["months"] if m["dividend_pool"] is not None]
    return {"available": True, "reason": None, "years": years, "lines": SHOP_STANDARD_LINES, "split_onn": split,
            "dividend_total": {"onn": round(sum(m["dividend_onn"] for m in paid), 2), "bes": round(sum(m["dividend_bes"] for m in paid), 2)}}


SHOP_STANDARD_LINES = {"revenue": ["Lazada", "Shopee", "ขายตรง"], "cogs": ["Uneedcargo", "Alipay"],
                       "sga": ["Laz Fees", "Laz Marketing", "Laz Transport", "Shopee Fees"], "tax": ["ดอกเบี้ย", "ภาษี"],
                       "dividend": [shop.PAYOUT_LINE]}


def h_shop_month_save(conn, body, q, who):
    """Replace one month of the shop's P&L: entries = [{section, line, amount}]. A blank amount is dropped, so clearing a
    field removes the line; no entries at all removes the month. Best only (the shop figures are his own)."""
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    if who != auth.BEST:
        raise ApiError(f"{who} may not change the shop figures; only Best can, from the dashboard", 403)
    year, month = body.get("year"), body.get("month")
    if not (isinstance(year, int) and 2000 <= year <= 2100 and isinstance(month, int) and 1 <= month <= 12):
        raise ApiError("year and month must be a year and a month number")
    entries, seen = [], set()
    for e in body.get("entries") or []:
        amount = e.get("amount")
        if amount in (None, ""):
            continue
        section, line = e.get("section"), str(e.get("line") or "").strip()
        if section not in shop.ALL_SECTIONS:
            raise ApiError(f"section must be one of {', '.join(shop.ALL_SECTIONS)}")
        if not line:
            raise ApiError("a line with an amount needs a name")
        if len(line) > 40:
            raise ApiError(f"line name too long: {line[:20]}…")
        amount = as_num(amount, line)
        if abs(amount) > 1e9:
            raise ApiError(f"amount out of range: {line}")
        if section == "dividend" and not (line == shop.PAYOUT_LINE and 0 <= amount <= 100):
            raise ApiError(f"the dividend section takes only “{shop.PAYOUT_LINE}”, between 0 and 100")
        if (section, line) in seen:
            raise ApiError(f"the same line twice in one section: {line}")
        seen.add((section, line))
        entries.append({"section": section, "line": line, "amount": round(amount, 2)})
    old = conn.execute("SELECT id FROM shop_months WHERE year=? AND month=?", (year, month)).fetchone()
    if not entries:
        return {"deleted": bool(old), "audit_id": audit.delete(conn, who, "shop_months", old["id"]) if old else None}
    vals = {"year": year, "month": month, "entries": json.dumps(entries, ensure_ascii=False)}
    if old:
        return {"id": old["id"], "audit_id": audit.update(conn, who, "shop_months", old["id"], vals)}
    row_id, audit_id = audit.insert(conn, who, "shop_months", dict(vals, entered_by=who, created_at=db.now()))
    return {"id": row_id, "audit_id": audit_id}


def h_accounts(conn, body, q, who):
    out = metrics.latest_values(conn)
    fam = None
    for a in out:
        if a["source"] == "family_statement":
            fam = fam or family.ledger(CFG["family_xlsx_path"])
            a["live"] = {"available": fam["available"], "reason": fam["reason"],
                         "value_thb": fam.get("balance"), "as_of": fam.get("last_date")}
    return out


def h_account_create(conn, body, q, who):
    """A new Account. An opening value is recorded as a Flow, so it never shows as return."""
    may_write(who, "accounts")
    acc_id, audit_id = audit.insert(conn, who, "accounts", clean_account(conn, body, None, who))
    out = {"id": acc_id, "audit_id": audit_id}
    if body.get("opening_value") not in (None, ""):
        snap = clean_snapshot(conn, {"account_id": acc_id, "as_of": body.get("opening_date") or date.today().isoformat(),
                                     "value_native": body["opening_value"], "fx_rate": body.get("opening_fx_rate"),
                                     "note": "opening value"}, None, who)
        out["snapshot_id"], _ = audit.insert(conn, who, "snapshots", snap)
        if snap["value_thb"]:
            flow = clean_flow(conn, {"account_id": acc_id, "on_date": snap["as_of"], "amount_thb": snap["value_thb"],
                                     "kind": "opening", "note": "opening value"}, None, who)
            out["flow_id"], _ = audit.insert(conn, who, "flows", flow)
    return out


def lister(resource):
    table, _, _, order = RESOURCES[resource]

    def handler(conn, body, q, who):
        where, args = [], []
        if "account_id" in q and table in ("snapshots", "flows"):
            where.append("account_id=?"); args.append(int(q["account_id"][0]))
        if q.get("open", [""])[0] == "1" and table == "upcoming_items":
            where.append("done=0")
        if "year" in q and table == "goals":
            where.append("year=?"); args.append(int(q["year"][0]))
        if "month" in q and table == "cashflow_lines":
            where.append("month=?"); args.append(q["month"][0])
        if "name" in q and table == "benchmarks":
            where.append("name=?"); args.append(q["name"][0].upper())
        sql = f"SELECT * FROM {table}" + (" WHERE " + " AND ".join(where) if where else "") + f" ORDER BY {order}"
        limit = min(int(q.get("limit", ["500"])[0]), 2000)
        return rows(conn, sql + " LIMIT ?", (*args, limit))
    return handler


# A Reinvest line in the Cash flow log (section allocation, the line names where the money went) is also the deposit into that
# place, so the tab it goes to shows it too. Saving Cash is the Family Statement ledger and Other has no Account: nothing to mirror.
def reinvest_account(conn, destination):
    if destination in ("Stock", "Investment"):                        # the old name still maps
        sql, args = "SELECT * FROM accounts WHERE bucket='investment' AND source='manual' ORDER BY id LIMIT 1", ()
    elif destination == "Trading":
        sql, args = "SELECT * FROM accounts WHERE bucket='trading' AND source='manual' ORDER BY (currency='USDT') DESC, id LIMIT 1", ()
    elif destination == "Saving Bitcoin":
        sql, args = "SELECT * FROM accounts WHERE bucket='wealth' AND source='manual' AND name IN ('Bitcoin', 'BTC') ORDER BY id LIMIT 1", ()
    else:
        return None
    return conn.execute(sql, args).fetchone()


def sync_reinvest(conn, who, line, gone=None):
    """Bring the Flow behind a Reinvest line in step with it. `line` is the line as it is now (None once deleted) and `gone` the
    deleted row. Returns the name of the Account that received the deposit, or None. Every change is logged and can be undone."""
    src = line or gone
    flow = audit.row(conn, "flows", src["flow_id"]) if src and src.get("flow_id") else None
    account = reinvest_account(conn, line["line"]) if line and line["section"] == "allocation" and line["amount_thb"] else None
    if account is None:
        if flow:
            audit.delete(conn, who, "flows", flow["id"])
        if line and line.get("flow_id"):
            conn.execute("UPDATE cashflow_lines SET flow_id=NULL WHERE id=?", (line["id"],))
        return None
    month = line["month"]
    year, mon = int(month[:4]), int(month[5:7])
    day = date.today().isoformat() if month == date.today().strftime("%Y-%m") else f"{month}-{calendar.monthrange(year, mon)[1]:02d}"
    vals = clean_flow(conn, {"account_id": account["id"], "on_date": day, "amount_thb": line["amount_thb"], "kind": None,
                             "note": "Cash flow log · Reinvest"}, flow, who)
    if flow:
        audit.update(conn, who, "flows", flow["id"], vals)
    else:
        flow_id, _ = audit.insert(conn, who, "flows", vals)
        conn.execute("UPDATE cashflow_lines SET flow_id=? WHERE id=?", (flow_id, line["id"]))
    return account["name"]


def creator(resource):
    table, clean, _, _ = RESOURCES[resource]

    def handler(conn, body, q, who):
        may_write(who, resource)
        vals = clean(conn, body, None, who)
        if table == "snapshots":
            dup = conn.execute("SELECT id FROM snapshots WHERE account_id=? AND as_of=?",
                               (vals["account_id"], vals["as_of"])).fetchone()
            if dup:
                raise ApiError(f"a Snapshot for this Account on {vals['as_of']} already exists "
                               f"(id {dup['id']}); update it with PUT /api/snapshots/{dup['id']}", 409)
        row_id, audit_id = audit.insert(conn, who, table, vals)
        out = {"id": row_id, "audit_id": audit_id}
        if table == "cashflow_lines":
            out["deposit_to"] = sync_reinvest(conn, who, audit.row(conn, table, row_id))
        return out
    return handler


def updater(resource):
    table, clean, _, _ = RESOURCES[resource]

    def handler(conn, body, q, who, row_id):
        may_write(who, resource)
        old = audit.row(conn, table, int(row_id))
        if old is None:
            raise ApiError(f"{resource} {row_id} not found", 404)
        out = {"id": int(row_id), "audit_id": audit.update(conn, who, table, int(row_id), clean(conn, body, old, who))}
        if table == "cashflow_lines":
            out["deposit_to"] = sync_reinvest(conn, who, audit.row(conn, table, int(row_id)))
        return out
    return handler


def deleter(resource):
    table = RESOURCES[resource][0]

    def handler(conn, body, q, who, row_id):
        may_write(who, resource)
        old = audit.row(conn, table, int(row_id))
        if old is None:
            raise ApiError(f"{resource} {row_id} not found", 404)
        out = {"id": int(row_id), "audit_id": audit.delete(conn, who, table, int(row_id))}
        if table == "cashflow_lines":
            sync_reinvest(conn, who, None, gone=old)
        return out
    return handler


def h_account_delete(conn, body, q, who, row_id):
    """Delete a Wealth Card: its Account with every Snapshot and Flow. Best only. Each row is logged, so History can undo it."""
    may_write(who, "accounts")
    acc = audit.row(conn, "accounts", int(row_id))
    if acc is None:
        raise ApiError(f"accounts {row_id} not found", 404)
    if acc["bucket"] != "wealth":
        raise ApiError("only a Wealth Card can be deleted here; set an Account inactive or keep it")
    removed = {"snapshots": 0, "flows": 0}
    for table in removed:
        for r in conn.execute(f"SELECT id FROM {table} WHERE account_id=?", (acc["id"],)).fetchall():
            audit.delete(conn, who, table, r["id"])
            removed[table] += 1
    return {"id": acc["id"], "audit_id": audit.delete(conn, who, "accounts", acc["id"]), "removed": removed}


def h_audit(conn, body, q, who):
    limit = min(int(q.get("limit", ["100"])[0]), 1000)
    return rows(conn, "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))


def h_audit_undo(conn, body, q, who, audit_id):
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    entry = conn.execute("SELECT actor FROM audit_log WHERE id=?", (int(audit_id),)).fetchone()
    if entry is None:
        raise ApiError(f"audit entry {audit_id} not found", 404)
    if who != auth.BEST and entry["actor"] != who:
        raise ApiError(f"{who} may only undo their own changes", 403)
    return {"audit_id": audit.undo(conn, who, int(audit_id))}


def h_backup(conn, body, q, who):
    if who is None:
        raise ApiError("writes need Maki's token or the dashboard page's own session", 401)
    conn.commit()
    return {"path": backup.make_backup(CFG["db_path"], CFG["backup_dir"], "manual")}


ROUTES = [
    ("GET", r"/api/whoami", h_whoami),
    ("GET", r"/api/home", h_home),
    ("GET", r"/api/monthly", h_monthly),
    ("GET", r"/api/networth", h_networth),
    ("GET", r"/api/investment", h_investment),
    ("GET", r"/api/trading", h_trading),
    ("GET", r"/api/wealth", h_wealth),
    ("GET", r"/api/plan", h_plan),
    ("GET", r"/api/goal-bars", h_goal_bars),
    ("POST", r"/api/journal/sync", h_journal_sync),
    ("POST", r"/api/journal/open", h_journal_open),
    ("POST", r"/api/fund/open", h_fund_open),
    ("GET", r"/api/family", h_family),
    ("PUT", r"/api/plan/yields", h_plan_yields),
    ("PUT", r"/api/plan/flow", h_plan_flow),
    ("PUT", r"/api/plan/debts", h_plan_debts),
    ("PUT", r"/api/plan/reinvest", h_plan_reinvest),
    ("PUT", r"/api/journal/settings", h_journal_settings),
    ("PUT", r"/api/journal/grades", h_journal_grades),
    ("GET", r"/api/avatar", h_avatar),
    ("PUT", r"/api/avatar", h_avatar_set),
    ("GET", r"/api/shop", h_shop),
    ("GET", r"/api/shop/finance", h_shop_finance),
    ("PUT", r"/api/shop/month", h_shop_month_save),
    ("GET", r"/api/accounts", h_accounts),
    ("POST", r"/api/accounts", h_account_create),
    ("PUT", r"/api/accounts/(\d+)", updater("accounts")),
    ("DELETE", r"/api/accounts/(\d+)", h_account_delete),
    ("GET", r"/api/audit", h_audit),
    ("POST", r"/api/audit/(\d+)/undo", h_audit_undo),
    ("POST", r"/api/backup", h_backup),
]
for _name in ("snapshots", "flows", "upcoming", "projects", "advice", "goals",
              "trades", "benchmarks", "cashflow", "assets", "links"):
    ROUTES += [
        ("GET", rf"/api/{_name}", lister(_name)),
        ("POST", rf"/api/{_name}", creator(_name)),
        ("PUT", rf"/api/{_name}/(\d+)", updater(_name)),
        ("DELETE", rf"/api/{_name}/(\d+)", deleter(_name)),
    ]
ROUTES = [(m, re.compile("^" + p + "$"), fn) for m, p, fn in ROUTES]


class Handler(BaseHTTPRequestHandler):
    server_version = "EmbraceDashboard/1.0"

    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, status, payload, ctype="application/json; charset=utf-8", headers=()):
        data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self._api(method, url)
        if method != "GET":
            return self._send(405, {"error": "method not allowed"})
        return self._static(url.path)

    def _local(self):
        origin = self.headers.get("Origin")
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in LOCAL_HOSTS and not (origin and urlparse(origin).hostname not in LOCAL_HOSTS)

    def _api(self, method, url):
        if not self._local():
            return self._send(403, {"error": "forbidden origin"})
        who, problem = auth.actor(self.headers, CFG["agent_tokens"])
        if problem:
            return self._send(401, {"error": problem})
        for m, rx, fn in ROUTES:
            mt = rx.match(url.path)
            if m == method and mt:
                break
        else:
            return self._send(404, {"error": "no such API route"})
        body = {}
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except ValueError:
                return self._send(400, {"error": "body is not valid JSON"})
            if not isinstance(body, dict):
                return self._send(400, {"error": "body must be a JSON object"})
        conn = db.connect(CFG["db_path"])
        try:
            result = fn(conn, body, parse_qs(url.query), who, *mt.groups())
            conn.commit()
            self._send(200, result)
        except (ApiError, audit.AuditError, ValueError) as e:
            conn.rollback()
            self._send(getattr(e, "status", 400), {"error": str(e)})
        except sqlite3.IntegrityError as e:
            conn.rollback()
            self._send(400, {"error": f"duplicate or invalid data ({e})"})
        except Exception as e:  # noqa: BLE001
            conn.rollback()
            traceback.print_exc()
            self._send(500, {"error": f"server error: {e}"})
        finally:
            conn.close()

    def _static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(config.WEB_DIR, rel))
        if not full.startswith(config.WEB_DIR) or not os.path.isfile(full):
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        headers = []
        if rel == "index.html" and (self.headers.get("Host") or "").split(":")[0] in LOCAL_HOSTS:
            # the page's own session: lets the browser UI write as Best
            headers.append(("Set-Cookie", f"{auth.UI_COOKIE}={auth.UI_KEY}; HttpOnly; SameSite=Strict; Path=/"))
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype, headers)

    def do_GET(self): self._handle("GET")        # noqa: E704
    def do_POST(self): self._handle("POST")      # noqa: E704
    def do_PUT(self): self._handle("PUT")        # noqa: E704
    def do_DELETE(self): self._handle("DELETE")  # noqa: E704


def make_server(cfg, port=None):
    """Bind the server for `cfg` (tests pass a temp config and port 0)."""
    global CFG
    CFG = cfg
    conn = db.connect(cfg["db_path"])
    db.init(conn)
    seed_shop_months(conn, cfg["shop_db_path"])
    conn.close()
    # 127.0.0.1, not "localhost": on Windows "localhost" tries ::1 first and adds ~200ms per request
    return ThreadingHTTPServer(("127.0.0.1", int(cfg["port"] if port is None else port)), Handler)


def startup_checks(cfg):
    os.makedirs(cfg["data_dir"], exist_ok=True)
    inst = lock.InstanceLock(cfg["lock_path"])
    try:
        inst.acquire()
    except lock.LockHeld as e:
        print("ไม่สามารถเปิดแอปได้:", e)
        sys.exit(2)
    if os.path.exists(cfg["db_path"]) and not db.integrity_ok(cfg["db_path"]):
        inst.release()
        print("ไฟล์ฐานข้อมูลเสียหาย (integrity_check ไม่ผ่าน) — กู้จากไฟล์ใน", cfg["backup_dir"])
        sys.exit(3)
    return inst


def main():
    startup_checks(CFG)
    srv = make_server(CFG)
    if not backup.has_backup_today(CFG["backup_dir"]):
        print("สำรองข้อมูลรายวัน:", backup.make_backup(CFG["db_path"], CFG["backup_dir"], "daily"))
    print(f"EMBRACE Dashboard: http://127.0.0.1:{CFG['port']}  (db: {CFG['db_path']})")
    print("Maki tokens:", ", ".join(t.get("name", "?") for t in CFG["agent_tokens"]) or "none (run scripts/make_token.py)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
