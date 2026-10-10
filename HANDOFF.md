# Handoff — EMBRACE Dashboard (written 2026-10-10)

Read `CLAUDE.md` first (rules), then `GLOSSARY.md` (terms). This file is only where things stand.

## What exists
- **Back end and data** (`server/`, `scripts/`, `tests/`): working. 27 tests pass (`python -m unittest discover tests`). History imported from `4. Fund Management.xlsx` and `1.1 Trade Journal2.xlsx` into `data/dashboard.db`.
- **Real web app** (`web/`): every sidebar page exists and lets Best add, edit and delete its data, plus a History page with Undo. Run `start.bat`, open `http://127.0.0.1:8770`.
- **Prototype** (Dashboard artifact, Best approved the layout): https://claude.ai/artifact/KdTJVqdpy6vGy2HZrFUyRR — sample data only. Its page code was written from scratch and is not saved in this folder; read it with the Artifact tool (`action: "read"`, `path: "index.html"` is the page, files are under `files/`).
- **Docs**: `docs/AGENT_API.md` (how Maki reads and writes), `docs/adr/0001` and `0002`.

## Done 2026-10-10 (later)
- Prototype look moved into `web/` (nav icons and black pill, serif numbers, delta pills, area under the line, softer cards with hover lift, avatar and "end of <month>" line, tan gradient goal bars). Checked in the browser; 27 tests pass. `git add -n .` lists only code and docs. Note: this PC (hostname `EMBRACE`) is the main PC, so the Hermes test can run here if Hermes is installed.

- Home chart (Best's request): % axis, since Jan 2023, SET as benchmark. Two tabs: "Since 2023" = `growth` in `/api/home` (`metrics.value_growth_vs_benchmark`): value growth INCLUDING deposits (about +677% vs SET -7% at Sep 2026), labelled as not a return; "Return since Dec 2025" = `performance` (true chained return, SET rebased). Flows only exist from 2026-01, so a true 2023-2025 return needs Best to backfill deposits and withdrawals. Benchmarks table holds SET and BTC, no VT.
- Also done: EMBRACE SHOP page mirrors the shop app's Finance tab (read-only, `/api/shop/finance`), profile photo (`/api/avatar`, file `data/avatar.txt`), nav reorder, Inter font (`web/assets/inter-latin.woff2`).

- Investment page reworked (Best's 9-point request): shared Performance Vs Benchmarks card (`performanceCard` in app.js, Investment vs SET), tiles Monthly Return / YTD / CAGR (`metrics.bucket_stats`, deposits counted, so CAGR is not an investment return), Investment Portfolio list with a holdings editor (new `snapshots.holdings` JSON column, migrated in `db.init`), By market donut (`metrics.market_breakdown`), half-width Deposits and Benchmark lists. No holdings by Market exist yet: the donut stays empty until Best enters them. Older months show Market as a dash.

- Trading page reworked to mirror the sheet `Trading Journal Fianl Test`: title Trading Portfolio, summary block of sheet rows 23-25 (`metrics.journal_sheet`), Trading vs BTC chart (same `performanceCard`), and an in-place editable journal grid (`journalGrid` in app.js; Enter/Tab save, Esc cancels). New trade columns (`db.TRADE_COLUMNS`, migrated in `db.init`), settings `journal_start_balance` (980) and `journal_risk_pct` (0.1) via `PUT /api/journal/settings`. `scripts/import_trade_journal.py` now brings the extra columns and was re-run on the real database (backup: `backups/dashboard-before-journal-columns-2026-10-10.db`). The sheet's own Balance column starts at 1000 and ends 2,015.33; the dashboard runs it from Start 980 and ends 2,055.60, which is what the sheet's Net Balance cell says. BTC prices exist only from 2025-12, so the Since 2023 tab has no BTC line.

- Best's decision 2026-10-10: the **trade journal is the source of truth for Trading**. The Trading page tiles (Trading, Monthly Return, YTD, CAGR) and the Trading vs BTC chart come from `metrics.journal_stats` (USDT, trades only, no deposits). They no longer read the Snapshots. Monthly values and Deposits (Snapshots and Flows) remain, half-width side by side, and still feed Home's Total Portfolio Value and Asset Allocation, so they still have to be updated at month end. `bucket_stats` amount keys are now `monthly_amount` / `ytd_amount` (THB for Investment, USDT for the journal). The journal only starts 2026-06, so CAGR shows a dash until 12 months of trades.

- Journal start date (setting `journal_start_date`, default 2026-01-01, editable in Edit Start and Risk): Jan-May 2026 show the 980 USDT Start in Trading by month and CAGR counts from that date. With under 12 months CAGR is annualised and the tile says so (+168% from 9 months at the time of writing); under 90 days it shows a dash. Trade journal has one tab per month plus All. Every date on screen now uses an English month (Sep 26, 26 Sep 2026). Table rows highlight on hover like the sidebar tabs.

- Best's decision 2026-10-11 (ADR 0003): the Inventory Management shop app / Hermes shop project is paused and Best types the shop's monthly P&L in the dashboard. New table `shop_months` (copied once from the shop app's `finance_monthly` at server start, never again), `PUT /api/shop/month` (Best only, audited), `+ Add` and clickable month names on the EMBRACE Shop page. Home's SHOP tile reads `shop_months`. The orders comparison still reads the shop app's database while it exists. Hermes/Maki work (token test, VT closes) is on hold the same way.

- Shop P&L for 2024 and 2025 imported from `ONTHEWALL SHOP BS.xlsx` (sheets `OTW Finance 24` and `OTW Finance 25`) with `scripts/import_shop_finance.py`: 24 months, revenue/cost/fee totals all agree with the sheet's own totals. Numbered cost rows are added into one Uneedcargo and one Alipay line; "ETC…" is its own cost line. Blank cost cells are no data, so months with no cost entered (2024 Apr, Nov, Dec; 2025 Jul, Aug, Nov, Dec) show no net profit, while the sheet's own Net Profit treats them as cost 0. The sheet's 2023 block there has revenue only and was not imported (the dashboard already has 2023). Backup before the write: `backups/dashboard-20261011-011740-pre-shop-import.db`.

- Shop sheet re-read 2026-10-11 after Best filled Shopee Fees (row 38): 2026 Jan-Sep Shopee Fees set from `OTW Finance 26`, every other typed line left alone. Net profit now follows the sheet (revenue - COGS - fees - interest/tax, no COGS counts as 0) and months with no COGS typed are shown in grey italics with a tooltip. New Dividend box on the EMBRACE Shop page: (revenue - fees) x the month's `Payout %` (38 to Mar 2026, 33 from Apr 2026; the sheet's own rule, COGS not taken off), shared ออน 60% / เบส 40% (setting `shop_dividend_split_onn`). Payout % is a line in the month editor (section `dividend`) and was filled for 2023-2026 from the sheet; yearly dividend totals agree with the sheet's cumulative cells. Backup before the write: `backups/dashboard-20261011-012528-pre-shop-import.db`.

## Not done yet, in order
1. **GitHub.** `git init -b main` is done, nothing committed. Best creates an empty private repo `embrace-dashboard`, sends the URL, then commit and push. Run `git add -n .` first: only code and docs should be listed, never `data/`, `backups/`, workbooks or tokens. `gh` is not installed on the secondary PC.
2. **Test with Hermes on the main PC** (hostname `EMBRACE`, Drive `E:`). Run `python scripts/make_token.py maki`, give the token to Hermes, have it post one Advice Note and read `/api/home`. Never tested: Hermes is not installed on the secondary PC.
3. **Fill the empty data**: month-end VT closes (`POST /api/benchmarks`, so Home draws the comparison line), OKX Spot Crypto card, Upcoming, Projects, Expense, All Asset Class.
4. **Later**: read-only OKX sync (Best creates a read-only key himself), remote access behind a login.

## Open questions for Best
- Three quarters do not match the Excel (`python scripts/reconcile.py`): Q3-2025 stock value (22,671 THB apart), Q2-2026 stock value (392 THB), Q4-2025 (23,750 THB, caused by Best's correction that the end-2025 trading balance was 8,250 THB, not 32,000). Which figure is right in each?
- January 2026 Trading P&L is −19,950 THB and March 2026 Monthly Return is −80,667 THB. If money was withdrawn in March and not noted, March is overstated.
- The sidebar Discord and Telegram links need their addresses (click the button, or Edit).

## Gotchas
- Run the server on one machine at a time. The database is on Drive; a second instance is refused while the first one's heartbeat is fresh.
- Home, Plan and Net Worth report the last finished month, so October entries do not show on Home until November.
- Family Statement is Counted under EMC but takes no Snapshots; its balance is read from `Family Statement\Family_Statement.xlsx`.
- The Hermes token gives attribution, not security (ADR 0002). Separate issue, outside this project: `Maki\hermes-backup.zip` on Drive contains Hermes's `.env` and `auth.json` and should be moved off Drive.
