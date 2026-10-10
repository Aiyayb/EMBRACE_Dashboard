# The dashboard database is the source of truth, not the Excel workbooks

Best's figures lived in `4. Fund Management.xlsx` and `1.1 Trade Journal2.xlsx`, whose sheets are free-form blocks rather than tables, so reading them live would break silently whenever a block moves, and Maki could not write to them through an audited path. We import the 2023–2026 history once, reconcile it to the Excel totals, and from then on monthly figures are entered in the dashboard; the Fund Management workbook is kept as an archive and no longer updated.

One source is deliberately not copied: the Family Statement is read from the ledger file Maki already maintains, because it already has one owner. (Shop figures were also read live from the Inventory Management database; ADR 0003 moved them into the dashboard.)

Considered: keeping Excel as the source and reading it on every load (no habit change, but fragile and not writable by Maki), and running both in parallel for a few months (safer, but double entry).
