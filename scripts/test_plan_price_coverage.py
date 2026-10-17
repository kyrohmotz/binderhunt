#!/usr/bin/env python3
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

import plan_price_coverage as plan
import price_proxy


ROOT = Path(__file__).resolve().parent


class PlanTests(unittest.TestCase):
    def test_backfill_and_monthly_credits(self):
        self.assertEqual(plan.backfill_credits(), 8000)
        self.assertEqual(plan.backfill_credits(True), 10000)
        self.assertAlmostEqual(plan.monthly_credits_exact(), 300 * 4 * 30 / 7 + 1700 * 4)
        self.assertEqual(plan.monthly_credits(), 11943)
        self.assertEqual(plan.days_to_full_coverage(), 20)
        self.assertAlmostEqual(plan.cards_per_day_to_stay_fresh(), 300 / 7 + 1700 / 30)
        self.assertGreaterEqual(plan.RUN_CARD_CAP, plan.cards_per_day_to_stay_fresh())
        self.assertLess(plan.monthly_credits() + 30, plan.MONTHLY_CAP)

    def test_plan_costs(self):
        report = plan.estimate()
        self.assertEqual(report["spent_credits"], 0)
        self.assertEqual(report["recommended_plan"], "Growth")
        self.assertEqual(report["backfill_days"], 20)
        self.assertEqual(report["monthly_cap"], 15000)
        self.assertEqual(report["store_reserve"], 15000)
        self.assertEqual(report["run_card_cap"], 100)
        self.assertEqual(report["run_credit_cap"], 500)
        by_name = {row["name"]: row for row in report["plans"]}
        self.assertEqual(by_name["Growth"]["steady_usd"], 99)

    def test_rank_demand_prefers_most_requested(self):
        ranked = plan.rank_demand({"b": 1, "a": 4, "c": 4}, limit=2)
        self.assertEqual(ranked, ["a", "c"])

    def test_planner_source_does_not_open_the_network(self):
        text = (ROOT / "plan_price_coverage.py").read_text(encoding="utf-8")
        for banned in ("urllib", "requests", "socket", "SCRYDEX_API_KEY", "SCRYDEX_ALLOW_SPEND"):
            self.assertNotIn(banned, text)


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.demand = self.tmp / "price-demand.json"
        self.cache = self.tmp / "scrydex.json"
        self.cache.write_text(
            json.dumps(
                {
                    "cards": {
                        "base1-4": {"graded": [{"market": 1}], "history": [{"d": "2026-01-01", "m": 1}]},
                        "sv03-223": {"missing": True},
                    }
                }
            ),
            encoding="utf-8",
        )
        price_proxy.Handler.demand_path = self.demand
        price_proxy.Handler.cache_path = self.cache
        self.server = price_proxy.ThreadingHTTPServer(("127.0.0.1", 0), price_proxy.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.old_spend = os.environ.pop("SCRYDEX_ALLOW_SPEND", None)
        self.old_key = os.environ.get("SCRYDEX_API_KEY")
        self.old_team = os.environ.get("SCRYDEX_TEAM_ID")
        os.environ["SCRYDEX_API_KEY"] = "super-secret-value"
        os.environ["SCRYDEX_TEAM_ID"] = "team-secret-value"
        self.calls = []
        self.original_live = price_proxy.live_fetch
        def boom(card_id):
            self.calls.append(card_id)
            raise AssertionError("live fetch should not run")
        price_proxy.live_fetch = boom

    def tearDown(self):
        price_proxy.live_fetch = self.original_live
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        if self.old_spend is None:
            os.environ.pop("SCRYDEX_ALLOW_SPEND", None)
        else:
            os.environ["SCRYDEX_ALLOW_SPEND"] = self.old_spend
        if self.old_key is None:
            os.environ.pop("SCRYDEX_API_KEY", None)
        else:
            os.environ["SCRYDEX_API_KEY"] = self.old_key
        if self.old_team is None:
            os.environ.pop("SCRYDEX_TEAM_ID", None)
        else:
            os.environ["SCRYDEX_TEAM_ID"] = self.old_team
        self._tmpdir.cleanup()

    def _json(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read()
                return response.status, json.loads(raw.decode("utf-8")), raw
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            return exc.code, json.loads(raw.decode("utf-8")), raw

    def test_demand_does_not_call_scrydex_or_echo_secrets(self):
        status, payload, raw = self._json("POST", "/demand?id=me02-125", {"id": "me02-125"})
        self.assertEqual(status, 202)
        self.assertEqual(payload["count"], 1)
        self.assertFalse(payload["live"])
        self.assertEqual(self.calls, [])
        text = raw.decode("utf-8")
        self.assertNotIn("super-secret-value", text)
        self.assertNotIn("team-secret-value", text)
        stored = self.demand.read_text(encoding="utf-8")
        self.assertIn("me02-125", stored)
        self.assertNotIn("super-secret-value", stored)

    def test_missing_price_is_503_without_a_live_call(self):
        status, payload, raw = self._json("GET", "/price?id=sv03-223")
        self.assertEqual(status, 503)
        self.assertFalse(payload["live"])
        self.assertEqual(payload["plan"]["spent_credits"], 0)
        self.assertEqual(self.calls, [])
        text = raw.decode("utf-8")
        self.assertNotIn("super-secret-value", text)
        self.assertNotIn("team-secret-value", text)

    def test_cache_hit_does_not_call_live_fetch(self):
        status, payload, _raw = self._json("GET", "/price?id=base1-4")
        self.assertEqual(status, 200)
        self.assertEqual(payload["source"], "cache")
        self.assertEqual(self.calls, [])

    def test_spend_flag_is_what_allows_the_live_function(self):
        os.environ["SCRYDEX_ALLOW_SPEND"] = "1"
        price_proxy.live_fetch = lambda card_id: self.calls.append(card_id) or {"graded": [{"market": 2}], "history": []}
        status, payload, raw = self._json("GET", "/price?id=me02-125")
        self.assertEqual(status, 200)
        self.assertEqual(payload["source"], "scrydex")
        self.assertEqual(self.calls, ["me02-125"])
        self.assertNotIn("super-secret-value", raw.decode("utf-8"))


class WorkflowTests(unittest.TestCase):
    def test_demand_workflow_cannot_spend(self):
        text = (ROOT.parent / ".github" / "workflows" / "scrydex-demand.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch", text)
        self.assertNotIn("cron:", text)
        self.assertNotIn("SCRYDEX_API_KEY", text)
        self.assertNotIn("SCRYDEX_TEAM_ID", text)
        self.assertNotIn("SCRYDEX_ALLOW_SPEND", text)
        self.assertNotIn("sync_scrydex.py", text)
        daily = (ROOT.parent / ".github" / "workflows" / "scrydex.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "15 8 * * *"', daily)
        page = (ROOT.parent / "index.html").read_text(encoding="utf-8")
        self.assertIn('<meta name="binderhunt-price-proxy" content="">', page)
        self.assertNotIn("X-Api-Key", page)
        self.assertNotIn("SCRYDEX_API_KEY", page)
        sync = (ROOT.parent / "scripts" / "sync_scrydex.py").read_text(encoding="utf-8")
        self.assertIn("MONTHLY_CAP = 15000", sync)
        self.assertIn("RUN_CREDIT_CAP = 500", sync)
        self.assertIn("MAX_PER_RUN = 100", sync)
        self.assertIn("SCRYDEX_MONTHLY_CAP", daily)
        self.assertIn("SCRYDEX_RUN_CAP", daily)
        self.assertIn("data/scrydex-usage.json", daily)


if __name__ == "__main__":
    unittest.main()
