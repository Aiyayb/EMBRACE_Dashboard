# Agent API — how Maki reads and writes the dashboard

Base URL: `http://127.0.0.1:8770` (main machine only). All bodies and replies are JSON. Terms are defined in `GLOSSARY.md`.

## Identity
- **Reading needs no token.** Any `GET` from this PC works.
- **Writing needs** `Authorization: Bearer <token>`. Best creates the token with `python scripts/make_token.py maki`; it is shown once. Keep it in Hermes's own secrets, never in Drive or git.
- Every write is recorded in the audit log under the token's name, with the row before and after.
- `GET /api/whoami` returns who the server thinks you are and which resources you may write.

## Hard rules
- There is no route that trades, transfers or withdraws, and there never will be. Do not ask for one.
- An Advice Note compares actual figures with Best's own plan and rules. It is never a call to buy or sell something.
- Do not record a Monthly Return yourself. Record Snapshots and Flows; the dashboard computes the rest.
- A deposit or withdrawal must be recorded as a Flow in the same month, or that month's return is wrong.

## Read
| Route | Returns |
|---|---|
| `GET /api/home` | Home tiles (`kpis`), `monthly` rows, `performance`, `allocation`, `goals`, `upcoming`, `projects` |
| `GET /api/monthly` | One row per month: bucket values, `total`, `net_flow`, `growth_thb`, `growth_pct`, `return_thb`, `return_pct`, `trading_pnl`, `flows_known`, `stale` |
| `GET /api/accounts` | Every Account with its latest Snapshot |
| `GET /api/investment`, `/api/trading`, `/api/wealth` | Bucket pages; `/api/trading` includes the journal summary |
| `GET /api/family` | Family Statement ledger (read from the ledger file; its balance is Counted under EMC) |
| `GET /api/networth` | Total Portfolio Value, other Assets, debts and Net Worth |
| `GET /api/trades`, `/api/benchmarks?name=VT`, `/api/cashflow?month=YYYY-MM`, `/api/assets` | Lists |
| `GET /api/shop` | Shop Revenue by month and platform (typed in the dashboard; Best only changes it, `PUT /api/shop/month`) |
| `GET /api/snapshots?account_id=N`, `/api/flows?account_id=N` | Recorded values and Flows |
| `GET /api/upcoming?open=1`, `/api/projects`, `/api/advice`, `/api/goals?year=YYYY` | Lists |
| `GET /api/audit?limit=N` | Latest changes, newest first |

A trade (`/api/trades`) has the journal sheet's columns: `traded_on`, `session`, `pair`, `side`, `setup`, `pic_setup`, `poi`, `signal`, `divergence`, `confirm`, `fib_time`, `fib`, `pic_entry`, `exit_plan`, `exit_actual`, `exit_a` (the sheet's "100 of A?"), `pic_exit`, `note`, `grade`, `outcome` (win, loss, be), `pnl` (+ profit, - loss, USDT) and `rr`. The three `pic_*` fields must be https links. Do not send Balance or Risk / Trade: `GET /api/trading` returns them in `sheet.trades`, worked out from the Start balance, with the summary block in `sheet.summary`.

A Snapshot for an Investment Account may carry `holdings`: `[{market, stock, qty, value_thb}]` (THB only). When you send it, the Snapshot's value is their sum and `value_native` is ignored; `market` is SET, US, HK, JP, KR, CN or OTHER (blank = no breakdown). Sending a new `value_native` without `holdings` clears the old breakdown.

`growth_thb` / `growth_pct` are the Monthly Return (change in value, deposits counted; `null` for the first month). `return_thb` / `return_pct` are the Return after Flows and are `null` when `flows_known` is false or there is no earlier month; quote them, not Monthly Return, when comparing with a Benchmark. `stale` names Accounts whose value was carried forward from an earlier month: say so when you quote the total. `/api/home` reports the last finished month, not the month in progress.

Once a month, after the month ends, record the month-end VT close with `POST /api/benchmarks`; Home compares Total Portfolio Value against it. Do not post Snapshots for the Family Statement: its balance is read from the ledger you already keep.

## Write (allowed for Maki)
Each write returns `{"id": ..., "audit_id": ...}`.

| Route | Body |
|---|---|
| `POST /api/snapshots` | `account_id`, `as_of` (YYYY-MM-DD), `value_native`; `fx_rate` (THB per 1 unit) when the Account is not in THB; `note` |
| `POST /api/flows` | `account_id`, `on_date`, `amount_thb` (+ deposit, − withdrawal), `note` |
| `POST /api/upcoming` | `due_date`, `item`, `kind` (Bill, Dividend, Restock, Rebalance, Entry), `amount_thb`, `done` |
| `POST /api/projects` | `name`, `track`, `status`, `progress` (0 to 1), `next_step` |
| `POST /api/advice` | `topic`, `body`, `noted_on` (default today), `refs` (the figures the note refers to). A note whose `topic` contains “Plan” also shows in the Maki Advise box of the Plan page; `GET /api/plan` gives the figures to base it on |
| `POST /api/benchmarks` | `name` (`VT`), `as_of`, `value` (month-end close in USD) |
| `POST /api/trades` | `traded_on`, `pair`, `side` (L or S), `setup`, `grade`, `exit_plan`, `exit_actual`, `outcome` (win, loss, be), `pnl`, `balance`, `risk`, `note` |
| `POST /api/cashflow` | `month` (YYYY-MM), `section` (income, fixed_cost, expense, allocation — shown as Reinvest, with the destination such as Investment, Trading, BTC or Saving as `line`), `line`, `amount_thb`, `note` |
| `POST /api/assets` | `name`, `asset_class`, `value_thb`, `valued_on`, `debt_thb`, `monthly_income_thb`, `monthly_cost_thb`, `note` |
| `PUT /api/<resource>/<id>` | Any of the fields above; fields left out keep their value |
| `DELETE /api/<resource>/<id>` | Removes the row (logged, can be undone) |
| `POST /api/audit/<audit_id>/undo` | Reverses one of your own changes |

A second Snapshot for the same Account and date is refused with `409` and the existing id: update that one with `PUT`.

## Not allowed for Maki
`accounts` (including the Counted / Display-only switch) and `goals` return `403`. The Family Statement card takes no Snapshots. Only Best changes those, from the dashboard page.

## Errors
`400` bad input (the message says which field), `401` missing or unknown token on a write, `403` not allowed, `404` no such row or route, `409` duplicate Snapshot.

## Example
```
curl -s http://127.0.0.1:8770/api/home

curl -s -X POST http://127.0.0.1:8770/api/advice \
  -H "Authorization: Bearer $EMBRACE_DASHBOARD_TOKEN" -H "Content-Type: application/json" \
  -d '{"topic": "Trading risk", "body": "3 trades this month risked more than the plan allows.", "refs": {"month": "2026-09"}}'
```
