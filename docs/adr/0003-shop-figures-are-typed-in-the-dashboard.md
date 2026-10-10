# Shop figures are typed in the dashboard, not read from the shop app

Best paused the shop app (the Inventory Management project) on 2026-10-11 and will keep the shop's monthly profit and loss by hand in the dashboard. This reverses the shop half of ADR 0001, which read shop figures live and read-only from the shop app's database.

The dashboard keeps one row per month in `shop_months` (revenue by platform, cost of goods, fees and interest or tax lines as JSON), written through `audit.py` like every other change, so a month can be undone from History. The first time the server starts after this change it copies the shop app's typed months (`finance_monthly`) in once, marked `entered_by = 'import'`; it never runs again once any month exists, so Best's edits are not overwritten. Home's SHOP Revenue tile and the EMBRACE Shop page read `shop_months`.

Still read from the shop app's database, read-only, only while it exists: the synced orders the Shop page compares typed revenue against. Nothing is written back to it. Only Best can change shop figures; Maki cannot.

Considered: keeping the shop app as the source and adding an edit link (what the page did before), and a Google Sheet as the source (a second place to keep in step, and credentials to store).
