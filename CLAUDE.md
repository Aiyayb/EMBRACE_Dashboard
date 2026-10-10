# EMBRACE Dashboard

Local web app for Best (single user) plus Maki, his Hermes agent: portfolio, shops, cash flow, plans and assets in one place. Vocabulary is in `GLOSSARY.md`; the two hard-to-reverse decisions are in `docs/adr/`. Root rules in `../../CLAUDE.md` apply (accuracy over speed, honest, short answers, brutally honest about anything touching trading money).

## Run
```
start.bat                                  # or: python server/app.py  -> http://127.0.0.1:8770
python scripts/import_fund_management.py   # one-time history import (use --dry-run first)
python scripts/import_trade_journal.py     # manual trade journal (safe to re-run)
python scripts/import_shop_finance.py      # shop P&L, Payout % and 2026 Shopee Fees from ONTHEWALL SHOP BS.xlsx (--dry-run first; never changes other lines Best typed)
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
- **The dashboard database is the source of truth** for Best's figures. The shop's monthly profit and loss is typed in the dashboard (`shop_months`, ADR 0003, Best only); the shop app is paused and its database is only read for the one-time copy and the orders comparison. The Family Statement is read from the ledger file Maki maintains and is not copied.
- **Monthly Return counts deposits** (Best's decision, 2026-10-10); **Return after Flows** does not. Never state a Return after Flows, or a Trading P&L, for a month whose Flows are unknown. `flows_recorded_from` in `settings` marks where they start; a value carried forward from an earlier month is reported in `stale`.
- **Family Statement is Counted under EMC** (Best's decision, 2026-10-10) and takes no Snapshots: its balance comes from the ledger, and `metrics.monthly` turns every change in it into a Flow so it never produces Return after Flows (it does move Monthly Return, which counts deposits).
- **Asset Allocation has four Allocation Groups**: Investment, Trading, Saving, EMC. A Wealth Card is Saving unless its `allocation` is `emc`.
- **Home, Plan and Net Worth report the last finished month** (`finished_rows` in `server/app.py`). A month in progress has only some values entered.
- **The page is always light.** Best wants white as the main tone, like his reference mockup; do not add a dark theme that follows the system.
- Per-machine settings and the hashed agent tokens live in `%LOCALAPPDATA%\EmbraceDashboard\config.json`, not in Drive and not in git. Never commit `data/`, `backups/`, workbooks or tokens.
- UI labels are English; notes and ledger content stay in Thai. Code and comments are English.

## Known gaps
- No OKX account sync yet: Trading figures come from monthly balances and the manual journal.
- No live prices: Account values are monthly figures entered by Best or Maki, with the FX rate entered beside a foreign-currency value.
- Shop Revenue is not profit; cost of goods is only as complete as Best has typed it.
- No VT prices are recorded yet, so Home draws only the portfolio line until month-end VT closes are added (Investment › Benchmark prices, or `POST /api/benchmarks`). VT is in USD, so the comparison ignores the THB exchange rate.
- The workbook's own sheets disagree in three quarters (`scripts/reconcile.py` lists them): Q3-2025 and Q2-2026 stock value, and Q4-2025 where Best confirmed the trading balance was 8,250 THB, not the 32,000 in `Asset Allocation(Q)`.
