# EMBRACE Dashboard

One place where Best sees his portfolio, shops, cash flow, plans and assets, with figures that Maki can read and update. Trading rule vocabulary (Setup, Position, Unit) lives in `Trading Strategy/CONTEXT.md` and is not repeated here.

## Language

### Buckets and accounts

**Bucket**:
One of the three purposes Best holds money for: Investment, Trading or Wealth. Every Account belongs to exactly one.
_Avoid_: asset class, category, portfolio

**Account**:
One place where money sits and is valued as a single figure, such as a brokerage account, an OKX sub-account or a Wealth Card.
_Avoid_: portfolio, wallet, port

**Investment**:
The Bucket of stock Accounts held for the long term.

**Trading**:
The Bucket of Accounts traded under a Setup from the trading plan, including the bot Account.

**Wealth**:
The Bucket made of Wealth Cards.
_Avoid_: net worth, savings

**Wealth Card**:
An Account in Wealth that Best adds and values by hand, such as OKX Spot Crypto, EMC or Saving.

**Counted / Display-only**:
Whether an Account's value is included in Total Portfolio Value. A Display-only Account is shown but never added to any of Best's totals.

**EMC**:
Best's emergency cash.

**Allocation Group**:
One of the four parts Asset Allocation is shown in: Investment, Trading, Saving or EMC. Every Counted Account falls in exactly one; a Wealth Card is either Saving or EMC.
_Avoid_: asset class, Bucket

### Figures

**Total Portfolio Value**:
The sum, in THB, of every Counted Account across the three Buckets.
_Avoid_: net worth, total wealth, total asset

**Snapshot**:
The value of one Account on one date, in the Account's own currency, with the FX rate used to state it in THB.

**Flow**:
Money Best moves into or out of an Account (a deposit or a withdrawal), as opposed to a gain or loss.
_Avoid_: transfer, top-up, contribution

**Monthly Return**:
The change in Total Portfolio Value over the month, in THB and as a percentage, **with Flows counted** (Best's decision, 2026-10-10: deposits come from dividends and reinvestment, so they are part of the portfolio's growth). It excludes shop profit. The Home chart uses the same definition.
_Avoid_: profit, PNL

**Return after Flows**:
Monthly Return with net Flows taken out: month-end value minus month-start value minus net Flows. The fair figure to compare with a Benchmark. In the API as `return_thb` / `return_pct` and kpis `return_after_flows`; null for a month whose Flows were not recorded.

**Flows unknown**:
The label on a month whose Flows were not recorded, so no Return after Flows and no Trading P&L can be stated for it.

**Benchmark**:
A market series Total Portfolio Value is compared against. VT (Vanguard Total World Stock ETF) is the one shown on Home.

**Finished month**:
The last calendar month that has ended. Home reports this month, never the month still in progress.
_Avoid_: current month, latest month

**Goal**:
The planned value of a Bucket for a year, compared with its actual value.
_Avoid_: target, plan

### Assets beyond the portfolio

**All Asset Class**:
The register of everything Best owns and owes: every Account plus property, his shop stake and his debts.
_Avoid_: asset allocation, Wealth

**Asset**:
One entry in All Asset Class, valued by Best's own estimate on a stated valuation date.

**Net Worth**:
Everything in All Asset Class minus the debts in it.
_Avoid_: Total Portfolio Value, Wealth

### Household

**Family Statement**:
The extended family's joint-account ledger, kept by Best and นีออน. Its balance is Counted under EMC, and every change in it is a Flow, so it moves Total Portfolio Value and Monthly Return but never Return after Flows.
_Avoid_: Expense, family balance sheet

**Cash Flow**:
Best's own income by source, fixed costs and allocation to Buckets for one month. It is what the Expense page shows.
_Avoid_: Family Statement, budget

### Shops

**EMBRACE SHOP**:
The umbrella over Best's online shops. ONTHEWALL is the first shop under it.
_Avoid_: ONTHEWALL (when meaning all shops)

**Shop Revenue**:
Whole-shop sales for a month, before platform fees and cost of goods. It is not profit and not Best's share.
_Avoid_: income, profit, yield

### Maki and the things she writes

**Maki**:
Best's Hermes agent, who reads the dashboard and records data in it.
_Avoid_: Hermes (in the UI), AI, bot

**Actor**:
Who made a change: Best or Maki.

**Advice Note**:
An observation Maki records that compares actual figures with Best's own plan and rules. It is never a call to buy or sell something.
_Avoid_: recommendation, signal, tip

**Upcoming Item**:
A dated thing Best must act on or expects, such as a bill, a dividend, a restock or a rebalance.
_Avoid_: reminder, task

**Project**:
An ongoing piece of work Best is tracking on Home.
