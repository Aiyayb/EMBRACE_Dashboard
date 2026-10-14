# EMBRACE Dashboard

Local web app for Best (single user) plus Maki, his Hermes agent: portfolio, shops, cash flow, plans and assets in one place. Vocabulary is in `GLOSSARY.md`; the two hard-to-reverse decisions are in `docs/adr/`. Root rules in `../../CLAUDE.md` apply (accuracy over speed, honest, short answers, brutally honest about anything touching trading money).

## Run
```
start.bat                                  # or: python server/app.py  -> http://127.0.0.1:8770
python scripts/import_fund_management.py   # one-time history import (use --dry-run first)
python scripts/import_trade_journal.py     # trade journal: the trades table is made to match the workbook (what the Sync Excel button does)
python scripts/import_shop_finance.py      # shop P&L, Payout % and 2026 Shopee Fees from ONTHEWALL SHOP BS.xlsx (--dry-run first; never changes other lines Best typed)
python scripts/import_cash_flow.py          # fixed costs and expenses from the sheet "Cash Flow M." (--dry-run first; never changes a line already there)
python scripts/import_plan_actions.py       # the year's action plan from "Fin Plan(Y)" onto its Goals: monthly reinvestment, planned growth, note (--dry-run first; only fills empty fields)
python scripts/backfill_reinvest.py        # Deposits/withdrawals of Stock, Trading and Bitcoin as linked Reinvest lines of the Cash flow log (--dry-run first; safe to re-run)
python scripts/reconcile.py                # imported totals vs the workbook, exit 1 on any mismatch
python scripts/make_token.py maki          # token Maki uses to write; printed once
python -m unittest discover tests
```
Python 3.10+ stdlib only; `openpyxl` is needed by the importers and to read the family ledger. Use `127.0.0.1`, not `localhost`. Run the server on the main machine only.

## Conventions
- **This system never moves money.** No route, script or credential may place an order, transfer or withdraw. An OKX key used here must be read-only. Do not add a "start/stop bot" control.
- **Total Portfolio Value and Monthly Return are computed only in `server/metrics.py`.** Nothing else adds up Account values.
- **Every API write goes through `server/audit.py`** (`insert`/`update`/`delete`), which logs the Actor and the before/after row. Do not write to those tables with raw SQL from a handler. The importers are the one exception and mark their rows `entered_by = 'import'`.
- **Maki may write** Snapshots, Flows, trades, Benchmark prices, Cash Flow lines, Assets, Upcoming Items, Projects and Advice Notes. Only Best (the page's own session) may change Accounts, counting rules and Goals.
- **Every sidebar page lets Best add and edit its data**, except the Family Statement ledger (edited in the ledger file Maki keeps).
- **The trade journal's source is the Excel workbook** (`1.1 Trade Journal2.xlsx`, Best's decision 2026-10-11): trades are added and edited there, and Sync Excel (or the script) mirrors it into `trades`, removing what the sheet no longer has. The page shows the trades read-only; Open Excel opens the file.
- **The dashboard database is the source of truth** for the rest of Best's figures. The shop's monthly profit and loss is typed in the dashboard (`shop_months`, ADR 0003, Best only); the shop app is paused and its database is only read for the one-time copy and the orders comparison. The Family Statement is read from the ledger file Maki maintains and is not copied.
- **Monthly Return counts deposits** (Best's decision, 2026-10-10); **Return after Flows** does not. Never state a Return after Flows, or a Trading P&L, for a month whose Flows are unknown. `flows_recorded_from` in `settings` marks where they start; a value carried forward from an earlier month is reported in `stale`.
- **Family Statement is Counted under EMC** (Best's decision, 2026-10-10) and takes no Snapshots: its balance comes from the ledger, and `metrics.monthly` turns every change in it into a Flow so it never produces Return after Flows (it does move Monthly Return, which counts deposits).
- **Asset Allocation has four Allocation Groups**: Stock, Trading, Saving, EMC. A Wealth Card is Saving unless its `allocation` is `emc`. (Best's decision 2026-10-11: the page shows the `emc` group as **Cash** (Family Statement) and the `saving` group as **Bitcoin** (Crypto); the stored group names and `allocation` values are unchanged.)
- **A year's portfolio target is the sum of its Goals that have a Bucket.** A Goal with no Bucket (OnTheWall) is a yearly income target, measured by the shop's profit for dividend, and is never added to it (the plan sheet's own "Total Asset" adds it from 2026 on; the dashboard does not). Plan figures are computed in `metrics.plan_view`.
- **The Plan page's Finance plan is a model, not a record** (`metrics.finance_flow`). Its inputs are Best-only settings and never change the Cash flow log: `plan_flow` (Income and Spending rows), `plan_debts` (reducing-balance loans), `plan_reinvest`, `plan_yield_*`. Investment has to pay Spending less the income that goes on without the job (everything except Salary and the Investment rows). Its yields are assumptions: never present its dates or amounts as results.
- **Home's tiles, Allocation, Plan's target and Net Worth report where things stand now** (`live_rows` in `server/app.py`: the last finished month plus a live row for the month in progress, summed by `metrics.live_row`). The charts, Monthly Return and every return after flows keep to finished months (`finished_rows`), because a month in progress has only some values and Flows entered. The Goal bars use the same live figures (`live_values`); Trading is the journal's Net Balance at the latest USDT rate.
- **The page is always light.** Best wants white as the main tone, like his reference mockup; do not add a dark theme that follows the system.
- Per-machine settings and the hashed agent tokens live in `%LOCALAPPDATA%\EmbraceDashboard\config.json`, not in Drive and not in git. Never commit `data/`, `backups/`, workbooks or tokens.
- UI labels are English; notes and ledger content stay in Thai. Code and comments are English.

## Known gaps
- No OKX account sync yet: Trading figures come from monthly balances and the manual journal.
- No live prices: Account values are monthly figures entered by Best or Maki, with the FX rate entered beside a foreign-currency value.
- Shop Revenue is not profit; cost of goods is only as complete as Best has typed it.
- No VT prices are recorded yet, so Home draws only the portfolio line until month-end VT closes are added (Stock › Benchmark prices, or `POST /api/benchmarks`). VT is in USD, so the comparison ignores the THB exchange rate.
- The workbook's own sheets disagree in three quarters (`scripts/reconcile.py` lists them, and will keep doing so). Accepted by Best: Q3-2025 stock value stays at the monthly sheet's 971,486 (the quarter summary says 948,815); Q2-2026 stays at the monthly sheet's 867,747.36 (summary 868,139.23); Q4-2025 uses the 8,250 THB trading balance he confirmed, not the 32,000 in `Asset Allocation(Q)`.
