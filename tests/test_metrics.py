import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import db  # noqa: E402
import metrics  # noqa: E402


class MetricsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(os.path.join(self.tmp.name, "t.db"))
        db.init(self.conn)
        db.set_setting(self.conn, "flows_recorded_from", "2026-01")
        self.ids = {a["name"]: a["id"] for a in self.conn.execute("SELECT id, name FROM accounts")}

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def snap(self, name, as_of, value, fx=1.0):
        self.conn.execute(
            "INSERT INTO snapshots(account_id, as_of, value_native, fx_rate, value_thb, entered_by, created_at) "
            "VALUES (?,?,?,?,?,'test','now')", (self.ids[name], as_of, value, fx, value * fx))

    def flow(self, name, on_date, amount, kind="deposit"):
        self.conn.execute("INSERT INTO flows(account_id, on_date, amount_thb, kind, entered_by, created_at) "
                          "VALUES (?,?,?,?,'test','now')", (self.ids[name], on_date, amount, kind))

    def test_deposit_is_not_counted_as_return(self):
        # Best moves 50,000 THB into OKX mid-month; the Account gains only 2,000 on its own.
        self.snap("OKX Trading", "2026-01-31", 100000)
        self.snap("OKX Trading", "2026-02-28", 152000)
        self.flow("OKX Trading", "2026-02-15", 50000)
        feb = metrics.monthly(self.conn)[-1]
        self.assertEqual(feb["total"], 152000)
        self.assertEqual(feb["net_flow"], 50000)
        self.assertEqual(feb["return_thb"], 2000)
        self.assertAlmostEqual(feb["return_pct"], 0.02)
        self.assertEqual(feb["trading_pnl"], 2000)
        self.assertAlmostEqual(feb["trading_pnl_pct"], 0.02)

    def test_withdrawal_is_not_counted_as_loss(self):
        self.snap("Stocks", "2026-01-31", 500000)
        self.snap("Stocks", "2026-02-28", 480000)
        self.flow("Stocks", "2026-02-10", -30000, "withdrawal")
        self.assertEqual(metrics.monthly(self.conn)[-1]["return_thb"], 10000)

    def family(self, points):
        return {self.ids["Family Statement"]: points}

    def test_family_statement_moves_total_but_never_return(self):
        # the joint account is Counted, but money others put in or take out must not look like Best's return
        self.snap("Stocks", "2026-01-31", 500000)
        self.snap("Stocks", "2026-02-28", 510000)
        plain = metrics.monthly(self.conn)[-1]
        ledger = self.family([("2026-02-05", 21000.0), ("2026-02-20", 45000.0), ("2026-02-27", 18000.0)])
        feb = metrics.monthly(self.conn, ledger)[-1]
        self.assertEqual(feb["total"], plain["total"] + 18000)
        self.assertEqual(feb["net_flow"], 18000)
        self.assertEqual(feb["return_thb"], plain["return_thb"])
        self.assertAlmostEqual(feb["return_pct"], plain["return_pct"])

    def test_family_statement_balance_comes_only_from_its_ledger(self):
        self.snap("Stocks", "2026-01-31", 500000)
        self.snap("Stocks", "2026-02-28", 510000)
        before = metrics.monthly(self.conn)[-1]
        self.snap("Family Statement", "2026-02-28", 999999)      # a stray Snapshot is ignored
        self.assertEqual(metrics.monthly(self.conn)[-1]["total"], before["total"])
        # ledger entries after the last Snapshot month do not open a new month on their own
        rows = metrics.monthly(self.conn, self.family([("2026-02-27", 18000.0), ("2026-03-03", 17000.0)]))
        self.assertEqual(rows[-1]["month"], "2026-02")

    def test_display_only_account_is_left_out_of_total(self):
        self.snap("Stocks", "2026-01-31", 500000)
        self.snap("Stocks", "2026-02-28", 510000)
        self.conn.execute("UPDATE accounts SET counts_in_total=0 WHERE name='Family Statement'")
        feb = metrics.monthly(self.conn, self.family([("2026-02-27", 18000.0)]))[-1]
        self.assertEqual(feb["total"], 510000)
        self.assertEqual(feb["net_flow"], 0)

    def test_allocation_has_four_groups_that_sum_to_total(self):
        self.snap("Stocks", "2026-02-28", 600000)
        self.snap("OKX Trading", "2026-02-28", 1000, fx=33.0)
        self.snap("Bot Trading", "2026-02-28", 7000)
        self.snap("EMC", "2026-02-28", 50000)
        self.snap("Saving", "2026-02-28", 20000)
        self.snap("OKX Spot Crypto", "2026-02-28", 1000, fx=30.0)
        rows = metrics.monthly(self.conn, self.family([("2026-02-27", 18000.0)]))
        alloc = {a["group"]: a["value_thb"] for a in metrics.allocation(rows)}
        self.assertEqual(alloc, {"investment": 600000, "trading": 40000, "saving": 50000, "emc": 68000})
        self.assertEqual(sum(alloc.values()), rows[-1]["total"])
        self.assertAlmostEqual(sum(a["share"] for a in metrics.allocation(rows)), 1.0)

    def test_new_wealth_card_opening_value_is_a_flow(self):
        self.snap("Stocks", "2026-01-31", 500000)
        self.snap("Stocks", "2026-02-28", 500000)
        self.snap("OKX Spot Crypto", "2026-02-20", 2000, fx=33.0)
        self.flow("OKX Spot Crypto", "2026-02-20", 66000, "opening")
        feb = metrics.monthly(self.conn)[-1]
        self.assertEqual(feb["total"], 566000)
        self.assertEqual(feb["return_thb"], 0)

    def test_months_before_flows_were_recorded_have_no_return(self):
        self.snap("Stocks", "2025-11-30", 400000)
        self.snap("Stocks", "2025-12-31", 450000)
        self.snap("Stocks", "2026-01-31", 460000)
        rows = metrics.monthly(self.conn)
        self.assertIsNone(rows[1]["return_thb"])
        self.assertFalse(rows[1]["flows_known"])
        self.assertEqual(rows[2]["return_thb"], 10000)

    def test_missing_month_is_carried_forward_and_flagged_stale(self):
        self.snap("Stocks", "2026-01-31", 500000)
        self.snap("Stocks", "2026-02-28", 510000)
        self.snap("EMC", "2026-01-31", 50000)
        feb = metrics.monthly(self.conn)[-1]
        self.assertEqual(feb["total"], 560000)
        self.assertEqual(feb["stale"], ["EMC"])

    def test_performance_chains_returns_and_rebases_benchmarks(self):
        self.snap("Stocks", "2025-12-31", 100000)
        self.snap("Stocks", "2026-01-31", 110000)
        self.snap("Stocks", "2026-02-28", 121000)
        for as_of, value in (("2025-12-30", 1000), ("2026-01-30", 1050), ("2026-02-27", 1100)):
            self.conn.execute("INSERT INTO benchmarks(name, as_of, value) VALUES ('SET', ?, ?)", (as_of, value))
        perf = metrics.performance(self.conn, metrics.monthly(self.conn))
        self.assertEqual([p["month"] for p in perf], ["2025-12", "2026-01", "2026-02"])
        self.assertAlmostEqual(perf[-1]["portfolio"], 0.21)
        self.assertAlmostEqual(perf[-1]["set"], 0.10)

    def test_monthly_return_counts_deposits_and_return_after_flows_does_not(self):
        self.snap("Stocks", "2026-01-31", 100000)
        self.snap("Stocks", "2026-02-28", 112000)
        self.flow("Stocks", "2026-02-10", 10000)
        rows = metrics.monthly(self.conn)
        self.assertIsNone(rows[0]["growth_thb"])
        self.assertEqual(rows[1]["growth_thb"], 12000)                 # 112,000 - 100,000, deposit included
        self.assertAlmostEqual(rows[1]["growth_pct"], 0.12)
        self.assertEqual(rows[1]["return_thb"], 2000)                  # the deposit taken out
        k = metrics.kpis(rows, [])
        self.assertEqual((k["monthly_return"], k["return_after_flows"]), (12000, 2000))

    def test_bucket_stats_monthly_ytd_and_cagr_count_deposits(self):
        for as_of, v in (("2024-12-31", 100000), ("2025-12-31", 150000), ("2026-01-31", 160000), ("2026-02-28", 180000)):
            self.snap("Stocks", as_of, v)
        rows = [r for r in metrics.monthly(self.conn)]
        st = metrics.bucket_stats(rows, "investment")
        self.assertEqual(st["month"], "2026-02")
        self.assertEqual(st["monthly_amount"], 20000)
        self.assertAlmostEqual(st["monthly_pct"], 20000 / 160000)
        self.assertEqual(st["ytd_amount"], 30000)                         # against the 2025-12 close
        self.assertAlmostEqual(st["ytd_pct"], 0.2)
        self.assertEqual(st["cagr_since"], "2024-12")
        self.assertAlmostEqual(st["cagr"], (180000 / 100000) ** (12 / 14) - 1)
        short = metrics.bucket_stats(rows[-3:], "investment")
        self.assertIsNone(short["cagr"])                               # under a year of history: no CAGR
        self.assertIsNone(metrics.bucket_stats([], "investment"))

    def test_market_breakdown_uses_the_latest_snapshot_with_holdings(self):
        self.snap("Stocks", "2026-01-31", 1000)
        self.assertEqual(metrics.market_breakdown(self.conn)["markets"], [])      # no holdings recorded yet
        self.conn.execute("UPDATE snapshots SET holdings=? WHERE as_of='2026-01-31'",
                          ('[{"market":"US","stock":"VOO","qty":1,"value_thb":600},{"market":"SET","stock":"PTT","qty":10,"value_thb":400}]',))
        mb = metrics.market_breakdown(self.conn)
        self.assertEqual([(m["market"], m["value_thb"]) for m in mb["markets"]], [("US", 600.0), ("SET", 400.0)])
        self.assertAlmostEqual(mb["markets"][0]["share"], 0.6)
        self.assertEqual([(t["stock"], t["value_thb"]) for t in mb["top"]], [("VOO", 600.0), ("PTT", 400.0)])

    def test_top_holdings_leave_out_cash_and_stop_at_ten(self):
        self.snap("Stocks", "2026-01-31", 1000)
        stocks = [{"market": "US", "stock": f"S{n}", "qty": 1, "value_thb": 10 + n} for n in range(12)]
        stocks.append({"market": "CASH", "stock": "Cash", "qty": None, "value_thb": 5000})
        stocks.append({"market": "", "stock": "cash", "qty": 1, "value_thb": 7000})        # entered with no market
        self.conn.execute("UPDATE snapshots SET holdings=? WHERE as_of='2026-01-31'", (json.dumps(stocks),))
        top = metrics.market_breakdown(self.conn)["top"]
        self.assertEqual(len(top), 10)
        self.assertEqual(top[0]["stock"], "S11")
        self.assertNotIn("Cash", [t["stock"] for t in top])
        self.assertAlmostEqual(top[0]["share"], 21 / (sum(10 + n for n in range(12)) + 5000 + 7000))

    def test_journal_sheet_runs_the_balance_and_matches_the_sheet_summary(self):
        for on, outcome, pnl in (("2026-06-01", "win", 100.0), ("2026-06-02", "loss", -40.0), ("2026-06-03", "be", -5.0),
                                 ("2026-06-04", "be", 1.0), ("2026-06-05", None, None)):
            self.conn.execute("INSERT INTO trades(traded_on, outcome, pnl) VALUES (?,?,?)", (on, outcome, pnl))
        sheet = metrics.journal_sheet(self.conn, 1000.0, 0.1)
        self.assertEqual([t["balance"] for t in sheet["trades"]], [1100, 1060, 1055, 1056, 1056])
        self.assertEqual(sheet["trades"][1]["risk"], 106)
        self.assertEqual((sheet["trades"][0]["profit"], sheet["trades"][1]["lost"]), (100, 40))
        s = sheet["summary"]
        self.assertEqual((s["profit"], s["loss"], s["pnl"], s["net_balance"]), (101, 45, 56, 1056))
        self.assertEqual((s["win"], s["loss_count"], s["be"]), (1, 1, 2))
        self.assertAlmostEqual(s["return"], 0.056)
        self.assertAlmostEqual(s["profit_factor"], 101 / 45)
        self.assertEqual(s["win_rate"], 0.5)
        self.assertEqual(s["risk_amount"], 105.6)

    def test_journal_sheet_for_a_year_starts_from_the_balance_the_year_before_ended(self):
        for on, pnl in (("2025-12-30", 100.0), ("2026-01-05", 50.0), ("2026-01-06", -20.0)):
            self.conn.execute("INSERT INTO trades(traded_on, outcome, pnl) VALUES (?, 'win', ?)", (on, pnl))
        y = metrics.journal_sheet(self.conn, 1000.0, 0.1, "2026")
        self.assertEqual(y["years"], ["2026", "2025"])
        self.assertEqual([t["balance"] for t in y["trades"]], [1150, 1130])         # the balance carries across years
        self.assertEqual((y["summary"]["start"], y["summary"]["pnl"], y["summary"]["net_balance"]), (1100, 30, 1130))
        self.assertAlmostEqual(y["summary"]["return"], 30 / 1100)
        self.assertEqual(metrics.journal_sheet(self.conn, 1000.0, 0.1)["summary"]["net_balance"], 1130)

    def test_journal_stats_are_a_trading_result_without_deposits(self):
        for on, pnl in (("2025-12-30", 100.0), ("2026-01-10", 50.0), ("2026-03-05", -30.0), ("2026-03-20", 80.0)):
            self.conn.execute("INSERT INTO trades(traded_on, outcome, pnl) VALUES (?, 'win', ?)", (on, pnl))
        self.conn.execute("INSERT INTO trades(traded_on) VALUES ('2026-04-01')")            # a row with no P&L yet is left out
        for as_of, value in (("2025-12-26", 1000.0), ("2026-01-26", 1100.0), ("2026-03-26", 1210.0)):
            self.conn.execute("INSERT INTO benchmarks(name, as_of, value) VALUES ('BTC', ?, ?)", (as_of, value))
        st = metrics.journal_stats(self.conn, 1000.0)
        self.assertEqual((st["month"], st["value"]), ("2026-03", 1200))                    # 1000 + 100 + 50 - 30 + 80
        self.assertEqual(st["monthly_amount"], 50)
        self.assertAlmostEqual(st["monthly_pct"], 50 / 1150)                                # against the month's opening balance
        self.assertEqual(st["ytd_amount"], 100)                                             # against the end-2025 balance
        self.assertAlmostEqual(st["ytd_pct"], 100 / 1100)
        self.assertIsNone(st["cagr"])                                                       # 80 days of trades: too short to annualise
        dated = metrics.journal_stats(self.conn, 1000.0, start_date="2025-10-01")           # the Start was in the account since October
        self.assertEqual((dated["cagr_since"], dated["cagr_months"]), ("2025-10", 6))
        self.assertAlmostEqual(dated["cagr"], (1200 / 1000) ** (365.25 / 170) - 1)          # 2025-10-01 to 2026-03-20 is 170 days
        rows = st["rows"]
        self.assertEqual([r["month"] for r in rows], ["2025-12", "2026-01", "2026-02", "2026-03"])
        self.assertAlmostEqual(rows[-1]["portfolio"], 1200 / 1100 - 1)
        self.assertAlmostEqual(rows[-1]["btc"], 0.21)                                       # BTC rebased to the December base
        self.assertEqual(metrics.journal_stats(self.conn, 1000.0, "2026")["month"], "2026-03")
        self.conn.execute("DELETE FROM trades")
        self.assertIsNone(metrics.journal_stats(self.conn, 1000.0))

    def test_journal_months_run_the_balance_month_by_month(self):
        for on, pnl in (("2026-01-10", 100.0), ("2026-01-20", -50.0), ("2026-03-05", 150.0)):
            self.conn.execute("INSERT INTO trades(traded_on, pnl) VALUES (?, ?)", (on, pnl))
        months = metrics.journal_months(self.conn, 1000.0)
        self.assertEqual([m["month"] for m in months], ["2026-01", "2026-02", "2026-03"])     # a month with no trades is still a row
        self.assertEqual([m["trades"] for m in months], [2, 0, 1])
        self.assertEqual([m["balance"] for m in months], [1050, 1050, 1200])
        self.assertAlmostEqual(months[0]["pnl_pct"], 0.05)
        self.assertAlmostEqual(months[2]["pnl_pct"], 150 / 1050)
        self.assertEqual(metrics.journal_months(self.conn, 1000.0)[0]["pnl"], 50)
        early = metrics.journal_months(self.conn, 1000.0, "2025-11-01")                    # months before the first trade hold the Start
        self.assertEqual([(m["month"], m["trades"], m["balance"]) for m in early[:3]], [("2025-11", 0, 1000), ("2025-12", 0, 1000), ("2026-01", 2, 1050)])
        self.conn.execute("DELETE FROM trades")
        self.assertEqual(metrics.journal_months(self.conn, 1000.0), [])

    def test_growth_for_a_bucket_starts_at_its_first_month_with_a_value(self):
        self.snap("Stocks", "2023-01-31", 1000)
        self.snap("OKX Trading", "2023-03-31", 200)
        self.snap("OKX Trading", "2023-04-30", 300)
        g = metrics.value_growth_vs_benchmark(self.conn, metrics.monthly(self.conn), benchmark="BTC", field="trading")
        self.assertEqual([x["month"] for x in g], ["2023-03", "2023-04"])
        self.assertAlmostEqual(g[1]["portfolio"], 0.5)
        self.assertIsNone(g[1]["btc"])                                 # no BTC prices recorded

    def test_value_growth_counts_deposits_and_rebases_the_benchmark_to_the_start_month(self):
        self.snap("Stocks", "2023-01-31", 100000)
        self.snap("Stocks", "2023-02-28", 150000)        # may include deposits: it is value growth, not return
        self.snap("Stocks", "2022-12-31", 90000)         # before the window, ignored
        for as_of, value in (("2023-01-02", 1000), ("2023-02-03", 1100)):
            self.conn.execute("INSERT INTO benchmarks(name, as_of, value) VALUES ('SET', ?, ?)", (as_of, value))
        g = metrics.value_growth_vs_benchmark(self.conn, metrics.monthly(self.conn), start="2023-01")
        self.assertEqual([x["month"] for x in g], ["2023-01", "2023-02"])
        self.assertEqual((g[0]["portfolio"], g[0]["set"]), (0.0, 0.0))
        self.assertAlmostEqual(g[1]["portfolio"], 0.5)
        self.assertAlmostEqual(g[1]["set"], 0.10)
        self.assertEqual(metrics.value_growth_vs_benchmark(self.conn, []), [])

    def test_kpis_use_shop_revenue_for_the_same_months(self):
        self.snap("Stocks", "2026-01-31", 100000)
        self.snap("Stocks", "2026-02-28", 105000)
        shop = [{"month": "2026-01", "revenue": 6000.0}, {"month": "2026-02", "revenue": 9000.0}]
        k = metrics.kpis(metrics.monthly(self.conn), shop)
        self.assertEqual(k["shop_revenue"], 9000.0)
        self.assertAlmostEqual(k["shop_mom"], 0.5)
        self.assertAlmostEqual(k["investment_mom"], 0.05)

    def test_plan_measures_this_years_goals_and_keeps_income_targets_out_of_the_total(self):
        self.snap("Stocks", "2029-12-31", 1000)
        self.snap("Stocks", "2030-06-30", 1600)
        self.flow("Stocks", "2030-03-01", 300)
        self.flow("Stocks", "2030-07-01", 999)                                   # after the latest month: not counted yet
        goal = "INSERT INTO goals(year, name, bucket, goal_thb, monthly_thb, growth_pct, note) VALUES (?,?,?,?,?,?,?)"
        self.conn.execute(goal, (2030, "Stock", "investment", 2000, 100, 0.15, "plan"))
        self.conn.execute(goal, (2030, "OnTheWall", None, 500, None, None, None))
        self.conn.execute(goal, (2032, "Stock", "investment", 5000, None, None, None))
        db.set_setting(self.conn, "plan_birth_year", "1991")
        plan = metrics.plan_view(self.conn, metrics.monthly(self.conn), {"OnTheWall": {2030: 120}})
        t = plan["this_year"]
        self.assertEqual((t["year"], t["month"], t["months_left"], t["target_thb"], t["actual_thb"]), (2030, "2030-06", 6, 2000, 1600))   # the 500 of income is not in it
        self.assertEqual((t["opening_thb"], t["expected_thb"], t["gap_thb"], t["per_month_thb"]), (1000, 1500, 400, 66.67))
        stock = next(i for i in t["items"] if i["name"] == "Stock")
        self.assertEqual((stock["actual_thb"], stock["deposits_ytd"], stock["deposits_plan_ytd"], stock["growth_pct"], stock["note"]), (1600, 300, 600, 0.15, "plan"))
        shop = next(i for i in t["items"] if i["name"] == "OnTheWall")
        self.assertEqual((shop["group"], shop["actual_thb"], shop["deposits_ytd"]), (None, 120, None))
        big = plan["big"]
        self.assertEqual((big["year"], big["age"], big["target_thb"], big["months_left"]), (2032, 41, 5000, 30))
        self.assertAlmostEqual(big["needed_growth"], (5000 / 1600) ** (12 / 30) - 1)
        self.assertEqual([(r["year"], r["target_thb"], r["income_thb"], r["actual_thb"]) for r in plan["roadmap"]], [(2030, 2000, 500, 1600), (2032, 5000, 0, None)])
        self.assertEqual(plan["history"], [{"year": 2029, "actual_thb": 1000}])

    def test_finance_flow_averages_the_log_and_measures_investment_against_spending(self):
        self.snap("Stocks", "2030-02-28", 600000)
        self.snap("OKX Trading", "2030-02-28", 60000)
        line = "INSERT INTO cashflow_lines(month, section, line, amount_thb, entered_by, created_at) VALUES (?,?,?,?,'test','now')"
        for month in ("2030-01", "2030-02"):
            for row in (("income", "Salary", 100000), ("income", "Stock dividend", 1000), ("income", "Online Shop", 2000),
                        ("fixed_cost", "House debt", 40000), ("expense", "Food", 10000), ("allocation", "Stock", 20000), ("allocation", "Saving Bitcoin", 5000)):
                self.conn.execute(line, (month, *row))
        self.conn.execute(line, ("2030-03", "expense", "Later", 999999))          # after the latest finished month: not in the average
        road = [{"year": 2030, "age": 39, "plan": {"investment": 1000000, "trading": 0}}, {"year": 2031, "age": 40, "plan": {"investment": 4000000, "trading": 0}}]
        f = metrics.finance_flow(self.conn, metrics.monthly(self.conn), {"stock": 0.15, "trading": 0.5}, road)
        self.assertEqual((f["months"], f["income"], f["income_thb"]), (2, {"salary": 100000, "investment": 1000, "shop": 2000, "other": 0}, 103000))
        self.assertEqual((f["spending"], f["spending_thb"], f["reinvest_thb"], f["saved_thb"], f["free_thb"]), ({"fixed": 40000, "debt": 0, "expense": 10000}, 50000, 20000, 5000, 28000))
        self.assertEqual(f["investment"], {"stock": 600000, "trading": 60000, "total": 660000})
        self.assertEqual(f["expected_return_thb"], 10000)                        # (600,000 x 15% + 60,000 x 50%) / 12, a planning figure
        self.assertEqual((f["goes_on_thb"], f["gap_thb"]), (2000, 48000))        # Online Shop goes on without the job, so Investment has less to pay
        self.assertAlmostEqual(f["coverage"], 10000 / 48000)
        self.assertAlmostEqual(f["actual_coverage"], 0.02)                       # what was really recorded as income from Investment
        self.assertEqual(f["needed_thb"], 3168000)                               # 576,000 a year to pay at the 18.18% the mix returns
        self.assertEqual([(p["year"], p["return_thb"]) for p in f["path"]], [(2030, 12500), (2031, 50000)])
        self.assertEqual((f["covered_year"], f["covered_age"]), (2031, 40))

    def test_finance_flow_is_one_model_of_income_spending_debt_and_yields(self):
        self.snap("Stocks", "2030-02-28", 600000)
        self.snap("OKX Trading", "2030-02-28", 0)
        line = "INSERT INTO cashflow_lines(month, section, line, amount_thb, entered_by, created_at) VALUES (?,?,?,?,'test','now')"
        for row in (("income", "Salary", 100000), ("fixed_cost", "House debt", 40000), ("fixed_cost", "Utility", 5000), ("expense", "Food", 15000), ("allocation", "Stock", 10000)):
            self.conn.execute(line, ("2030-02", *row))
        rows, y = metrics.monthly(self.conn), {"stock": 0.12, "trading": 0.5}
        debt = [{"name": "House", "line": "House debt", "balance": 100000, "as_of": "2030-02", "rate": 0.12, "payment": 40000}]
        f = metrics.finance_flow(self.conn, rows, y, None, None, debt)
        # the log's House debt line becomes the Debt line: it is not counted twice
        self.assertEqual((f["spending"], f["spending_thb"]), ({"fixed": 5000, "debt": 40000, "expense": 15000}, 60000))
        self.assertEqual([(l["label"], l["detail"], l["amount"]) for l in f["spending_lines"]], [("Fixed costs", "", 5000), ("Debt", "House", 40000), ("Expenses", "", 15000)])
        d = f["debts"][0]                    # 1% a month on what is still owed: 1,000, then 610, then 216.10
        self.assertEqual((d["interest_thb"], d["principal_thb"], d["months_left"], d["paid_off"], d["interest_left_thb"]), (1000, 39000, 3, "2030-05", 1826.1))
        self.assertEqual((f["gap_thb"], f["gap_after_thb"], f["needed_thb"], f["needed_after_thb"]), (60000, 20000, 6000000, 2000000))
        self.assertEqual(f["debt_free"]["month"], "2030-05")
        base = f["reach"]["months"]
        self.assertGreater(base, 3)          # reached only after the debt is gone and the gap has dropped to 20,000

        def months(planned=None, yields=y, reinvest=None, debts=debt):
            return metrics.finance_flow(self.conn, rows, yields, None, planned, debts, reinvest)["reach"]["months"]

        # every input moves the result
        shop = [{"group": "Active", "name": "Salary", "amount": 100000}, {"group": "Active", "name": "Online Shop", "amount": 10000}]
        more = metrics.finance_flow(self.conn, rows, y, None, {"income": shop}, debt)
        self.assertEqual((more["gap_thb"], more["needed_thb"]), (50000, 5000000))
        self.assertLess(more["reach"]["months"], base)
        self.assertGreater(months({"spending": [{"group": "Expenses", "name": "Food", "amount": 30000}]}), base)
        self.assertLess(months(yields={"stock": 0.2, "trading": 0.5}), base)
        self.assertLess(months(reinvest={"stock": 30000}), base)
        self.assertLess(months(reinvest={"freed": True}), base)
        self.assertGreater(months(debts=[dict(debt[0], balance=2000000)]), base)
        # a balance typed for an earlier month is rolled forward to the latest finished month
        early = metrics.finance_flow(self.conn, rows, y, None, None, [dict(debt[0], as_of="2030-01")])["debts"][0]
        self.assertEqual((early["rolled"], early["balance_thb"], early["paid_off"]), (True, 61000, "2030-04"))
        # a payment that does not cover the interest never pays the loan off
        never = metrics.finance_flow(self.conn, rows, y, None, None, [dict(debt[0], balance=9000000)])
        self.assertEqual((never["debts"][0]["never"], never["debt_free"], never["spending"]["debt"]), (True, None, 40000))

    def test_a_wealth_goal_is_measured_by_saving_or_emc(self):
        self.assertEqual([metrics.goal_group({"bucket": b, "name": n}) for b, n in (("wealth", "EMC"), ("wealth", "Saving"), ("trading", "Trading"), (None, "OnTheWall"))],
                         ["emc", "saving", "trading", None])


if __name__ == "__main__":
    unittest.main()
