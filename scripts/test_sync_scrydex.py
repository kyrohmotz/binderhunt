#!/usr/bin/env python3
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

import sync_scrydex as sync


class TrimTests(unittest.TestCase):
    def test_history_keeps_raw_near_mint_usd_only(self):
        payload = {
            "count": 1,
            "total_count": 2,
            "data": [
                {
                    "date": "2026-10-01",
                    "prices": [
                        {"type": "raw", "condition": "NM", "currency": "USD", "variant": "holofoil", "market": 10.5},
                        {"type": "raw", "condition": "LP", "currency": "USD", "variant": "holofoil", "market": 4},
                        {"type": "graded", "condition": "NM", "currency": "USD", "variant": "holofoil", "market": 99, "company": "PSA", "grade": "10"},
                        {"type": "raw", "condition": "NM", "currency": "EUR", "variant": "holofoil", "market": 8},
                        {"type": "raw", "condition": "NM", "currency": "USD", "variant": "holofoil", "market": 10.5, "is_signed": True},
                    ],
                }
            ],
        }
        rows, truncated = sync.trim_history(payload)
        self.assertEqual(rows, [{"d": "2026-10-01", "v": "holofoil", "m": 10.5}])
        self.assertTrue(truncated)

    def test_graded_and_pop_skip_signed_and_blank_counts(self):
        payload = {
            "data": {
                "name": "Charizard",
                "variants": [
                    {
                        "name": "holofoil",
                        "prices": [
                            {"type": "raw", "market": 12, "currency": "USD"},
                            {"type": "graded", "company": "PSA", "grade": "10", "market": 100, "low": 90, "mid": 95, "high": 110, "currency": "USD"},
                            {"type": "graded", "company": "PSA", "grade": "10", "market": 500, "is_signed": True, "currency": "USD"},
                        ],
                        "pop_reports": [
                            {
                                "company": "PSA",
                                "total": 3,
                                "grades": [
                                    {"grade": "10", "count": 2},
                                    {"grade": "9", "count": True},
                                    {"grade": "8", "count": -1},
                                ],
                            }
                        ],
                    }
                ],
            }
        }
        graded, pop = sync.trim_graded_and_pop(payload)
        self.assertEqual(len(graded), 1)
        self.assertEqual(graded[0]["market"], 100)
        self.assertEqual(graded[0]["company"], "PSA")
        self.assertEqual(pop[0]["total"], 3)
        self.assertEqual(pop[0]["grades"], [{"grade": "10", "count": 2}])

    def test_select_due_caps_and_prefers_tier_a(self):
        now = datetime(2026, 10, 15, tzinfo=timezone.utc)
        seed = [("B", "old-b"), ("A", "fresh-a"), ("A", "stale-a"), ("A", "new-a")]
        cards = {
            "old-b": {"fetched_at": (now - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")},
            "fresh-a": {"fetched_at": (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")},
            "stale-a": {"fetched_at": (now - timedelta(hours=50)).strftime("%Y-%m-%dT%H:%M:%SZ")},
        }
        due = sync.select_due(seed, cards, now, max_cards=2)
        self.assertEqual(due, ["new-a"])
        cards["new-a"] = {"fetched_at": (now - timedelta(days=9)).strftime("%Y-%m-%dT%H:%M:%SZ")}
        cards["stale-a"] = {"fetched_at": (now - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")}
        due = sync.select_due(seed, cards, now, max_cards=2)
        self.assertEqual(due, ["new-a", "stale-a"])

    def test_demand_follows_chase_and_refreshes_slowly(self):
        now = datetime(2026, 10, 15, tzinfo=timezone.utc)
        seed = [("A", "chase")]
        demand = {"cheap-1": 4, "once": 1, "chase": 9}
        self.assertEqual(sync.select_due(seed, {}, now, max_cards=1, demand=demand), ["chase"])
        self.assertEqual(sync.select_due(seed, {}, now, max_cards=5, demand=demand), ["chase", "cheap-1"])
        fresh = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        recent = (now - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
        stale = (now - timedelta(days=91)).strftime("%Y-%m-%dT%H:%M:%SZ")
        cards = {"chase": {"fetched_at": fresh}, "cheap-1": {"fetched_at": recent}}
        self.assertEqual(sync.select_due(seed, cards, now, max_cards=5, demand=demand), [])
        cards["cheap-1"] = {"fetched_at": stale}
        self.assertEqual(sync.select_due(seed, cards, now, max_cards=5, demand=demand), ["cheap-1"])

    def test_missing_secret_does_not_echo_values(self):
        old_key = os.environ.pop("SCRYDEX_API_KEY", None)
        old_team = os.environ.pop("SCRYDEX_TEAM_ID", None)
        os.environ["SCRYDEX_API_KEY"] = "super-secret-value"
        os.environ["SCRYDEX_TEAM_ID"] = ""
        try:
            with self.assertRaises(sync.ScrydexError) as caught:
                sync.require_secrets()
            self.assertIn("SCRYDEX_TEAM_ID", str(caught.exception))
            self.assertNotIn("super-secret-value", str(caught.exception))
        finally:
            if old_key is None:
                os.environ.pop("SCRYDEX_API_KEY", None)
            else:
                os.environ["SCRYDEX_API_KEY"] = old_key
            if old_team is not None:
                os.environ["SCRYDEX_TEAM_ID"] = old_team

    def test_seed_file_parses(self):
        seed = sync.load_seed()
        ids = [card_id for _, card_id in seed]
        tiers = [tier for tier, _card_id in seed]
        by_id = {card_id: tier for tier, card_id in seed}
        self.assertEqual(by_id["base1-4"], "A")
        self.assertEqual(by_id["swsh7-215"], "A")
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(ids), 1500)
        self.assertLessEqual(len(ids), 2000)
        self.assertEqual(tiers[:300].count("A"), 300)
        self.assertEqual(tiers[300:].count("B"), len(tiers) - 300)
        self.assertNotIn("B", tiers[:300])
        self.assertTrue(all(not __import__("re").fullmatch(r"(?:P-A|[AB]\d+[a-z]*)", card_id.split("-")[0]) for card_id in ids))


class IdMapTests(unittest.TestCase):
    def test_maps_tcgdex_ids_to_scrydex_ids(self):
        expected = {
            "base1-4": "base1-4",
            "swsh7-215": "swsh7-215",
            "gym2-2": "gym2-2",
            "neo1-9": "neo1-9",
            "swsh9tg-TG23": "swsh9tg-TG23",
            "sv03-223": "sv3-223",
            "sv08-238": "sv8-238",
            "sv03.5-199": "sv3pt5-199",
            "sv03.5-006": "sv3pt5-6",
            "sv04.5-234": "sv4pt5-234",
            "swsh12.5-102": "swsh12pt5-102",
            "me02-125": "me2-125",
            "sv04-199": "sv4-199",
        }
        for catalog_id, scrydex_id in expected.items():
            self.assertEqual(sync.map_scrydex_id(catalog_id), scrydex_id)
        self.assertEqual(sync.scrydex_candidates("sv03-223"), ["sv3-223", "sv03-223"])
        self.assertEqual(sync.scrydex_candidates("base1-4"), ["base1-4"])

    def test_missing_raw_id_is_due_until_the_mapped_id_is_tried(self):
        now = datetime(2026, 10, 16, tzinfo=timezone.utc)
        fresh = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        seed = [("A", "sv03-223"), ("A", "base1-4")]
        cards = {
            "sv03-223": {"missing": True, "fetched_at": fresh},
            "base1-4": {"fetched_at": fresh, "history": []},
        }
        self.assertEqual(sync.select_due(seed, cards, now, max_cards=10), ["sv03-223"])
        cards["sv03-223"]["lookup_id"] = "sv3-223"
        self.assertEqual(sync.select_due(seed, cards, now, max_cards=10), [])

    def test_fetch_uses_mapped_id_and_does_not_fan_out(self):
        calls = []

        def fake(url, headers):
            calls.append(url)
            if "sv3-223?" in url:
                return 200, {"data": {"name": "Charizard ex", "variants": []}}
            if "price_history" in url:
                self.assertIn("/sv3-223/", url)
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 404, {}

        original = sync.request_json
        original_sleep = sync.time.sleep
        sync.request_json = fake
        sync.time.sleep = lambda *args, **kwargs: None
        try:
            record, stop, _credits = sync.fetch_card("sv03-223", {}, datetime(2026, 10, 16, tzinfo=timezone.utc))
        finally:
            sync.request_json = original
            sync.time.sleep = original_sleep
        self.assertFalse(stop)
        self.assertFalse(record.get("missing"))
        self.assertEqual(record["lookup_id"], "sv3-223")
        self.assertEqual(len(calls), 2)
        self.assertEqual(_credits, 4)
        self.assertNotIn("sv03-223", calls[0])

    def test_fetch_tries_one_fallback_then_stops(self):
        calls = []

        def fake(url, headers):
            calls.append(url)
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            if "/sv3-223?" in url:
                return 404, {}
            if "/sv03-223?" in url:
                return 200, {"data": {"name": "Charizard ex", "variants": []}}
            return 500, {}

        original = sync.request_json
        original_sleep = sync.time.sleep
        sync.request_json = fake
        sync.time.sleep = lambda *args, **kwargs: None
        try:
            record, stop, _credits = sync.fetch_card("sv03-223", {}, datetime(2026, 10, 16, tzinfo=timezone.utc))
        finally:
            sync.request_json = original
            sync.time.sleep = original_sleep
        self.assertFalse(record.get("missing"))
        self.assertEqual(record["lookup_id"], "sv03-223")
        self.assertEqual(len(calls), 3)
        self.assertEqual(_credits, 5)
        self.assertEqual(sum("price_history" in url for url in calls), 1)

    def test_fetch_missing_does_not_request_history(self):
        calls = []

        def fake(url, headers):
            calls.append(url)
            return 404, {}

        original = sync.request_json
        original_sleep = sync.time.sleep
        sync.request_json = fake
        sync.time.sleep = lambda *args, **kwargs: None
        try:
            record, stop, _credits = sync.fetch_card("sv03-223", {}, datetime(2026, 10, 16, tzinfo=timezone.utc))
        finally:
            sync.request_json = original
            sync.time.sleep = original_sleep
        self.assertTrue(record.get("missing"))
        self.assertEqual(record["lookup_id"], "sv3-223")
        self.assertFalse(stop)
        self.assertEqual(len(calls), 2)
        self.assertEqual(_credits, 2)
        self.assertFalse(any("price_history" in url for url in calls))

    def test_rate_limit_stops_before_a_second_lookup(self):
        calls = []

        def fake(url, headers):
            calls.append(url)
            return 429, {}

        original = sync.request_json
        sync.request_json = fake
        try:
            with self.assertRaises(sync.ScrydexError) as caught:
                sync.fetch_card("sv03-223", {}, datetime(2026, 10, 16, tzinfo=timezone.utc))
        finally:
            sync.request_json = original
        self.assertEqual(str(caught.exception), "RATE_LIMIT")
        self.assertEqual(len(calls), 1)

    def test_skippable_status_is_5xx_only(self):
        for status in (500, 503, 599):
            self.assertTrue(sync.skippable_status(status), status)
        for status in (200, 400, 401, 402, 403, 404, 429, 499):
            self.assertFalse(sync.skippable_status(status), status)

    def test_provider_detail_is_bounded_and_drops_headers(self):
        secret = "super-secret-value"
        team = "team-secret-value"
        old_key = os.environ.get("SCRYDEX_API_KEY")
        old_team = os.environ.get("SCRYDEX_TEAM_ID")
        os.environ["SCRYDEX_API_KEY"] = secret
        os.environ["SCRYDEX_TEAM_ID"] = team
        try:
            body = {
                "code": "payment_required",
                "message": "account " + secret + " down\n" + ("x" * 500),
                "Authorization": "Bearer " + team,
                "X-Api-Key": secret,
            }
            detail = sync.sanitize_provider_detail(body)
        finally:
            if old_key is None:
                os.environ.pop("SCRYDEX_API_KEY", None)
            else:
                os.environ["SCRYDEX_API_KEY"] = old_key
            if old_team is None:
                os.environ.pop("SCRYDEX_TEAM_ID", None)
            else:
                os.environ["SCRYDEX_TEAM_ID"] = old_team
        self.assertLessEqual(len(detail), 200)
        self.assertNotIn(secret, detail)
        self.assertNotIn(team, detail)
        self.assertNotIn("Authorization", detail)
        self.assertNotIn("Bearer", detail)
        self.assertNotIn("X-Api-Key", detail)
        self.assertNotIn("\n", detail)
        self.assertIn("code=payment_required", detail)
        self.assertIn("[redacted]", detail)
        self.assertNotIn("x" * 250, detail)
        nested = sync.sanitize_provider_detail({"error": {"code": "E1", "message": "nope"}})
        self.assertEqual(nested, "code=E1 message=nope")

    def _fetch(self, card_id, fake):
        original = sync.request_json
        original_sleep = sync.time.sleep
        sync.request_json = fake
        sync.time.sleep = lambda *args, **kwargs: None
        try:
            return sync.fetch_card(card_id, {}, datetime(2026, 10, 16, tzinfo=timezone.utc))
        finally:
            sync.request_json = original
            sync.time.sleep = original_sleep

    def test_fetch_402_is_a_hard_stop_without_a_fallback(self):
        calls = []

        def fake(url, headers):
            calls.append(url)
            return 402, {"error": "payment required", "Authorization": "Bearer sekrit"}

        out = io.StringIO()
        with redirect_stdout(out):
            with self.assertRaises(sync.PaymentRequired) as caught:
                self._fetch("ex11-3", fake)
        self.assertNotIsInstance(caught.exception, sync.CardSkip)
        self.assertIsInstance(caught.exception, sync.ScrydexError)
        self.assertEqual(caught.exception.card_id, "ex11-3")
        self.assertEqual(caught.exception.stage, "card lookup")
        self.assertEqual(caught.exception.status, 402)
        self.assertEqual(caught.exception.credits, 1)
        self.assertEqual(str(caught.exception), sync.PAYMENT_REQUIRED_MESSAGE)
        self.assertIn("message=payment required", caught.exception.detail)
        self.assertLessEqual(len(caught.exception.detail), 200)
        self.assertEqual(len(calls), 1)
        logged = out.getvalue()
        self.assertIn("Scrydex HTTP 402 on card lookup for ex11-3:", logged)
        self.assertNotIn("Authorization", logged)
        self.assertNotIn("Bearer", logged)
        self.assertNotIn("sekrit", logged)

    def test_fetch_402_after_a_404_does_not_write_a_miss(self):
        calls = []

        def fake(url, headers):
            calls.append(url)
            if "/sv3-223?" in url:
                return 404, {}
            return 402, {}

        with self.assertRaises(sync.PaymentRequired) as caught:
            self._fetch("sv03-223", fake)
        self.assertNotIsInstance(caught.exception, sync.CardSkip)
        self.assertEqual(caught.exception.status, 402)
        self.assertEqual(caught.exception.credits, 2)
        self.assertEqual(len(calls), 2)
        self.assertFalse(any("price_history" in url for url in calls))

    def test_fetch_price_history_402_is_a_hard_stop(self):
        def fake(url, headers):
            if "price_history" in url:
                return 402, {"message": "history blocked"}
            return 200, {"data": {"name": "Card", "variants": []}}

        out = io.StringIO()
        with redirect_stdout(out):
            with self.assertRaises(sync.PaymentRequired) as caught:
                self._fetch("ex11-3", fake)
        self.assertEqual(caught.exception.stage, "price history")
        self.assertEqual(caught.exception.status, 402)
        self.assertEqual(caught.exception.credits, 4)
        self.assertIn("message=history blocked", caught.exception.detail)
        self.assertIn("Scrydex HTTP 402 on price history for ex11-3:", out.getvalue())

    def test_fetch_soft_skips_http_500(self):
        calls = []

        def fake(url, headers):
            calls.append(url)
            return 503, {}

        with self.assertRaises(sync.CardSkip) as caught:
            self._fetch("sv03-223", fake)
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(caught.exception.credits, 1)
        self.assertEqual(len(calls), 1)

    def test_fetch_auth_errors_still_raise(self):
        for status in (401, 403):
            def fake(url, headers, status=status):
                return status, {}

            with self.assertRaises(sync.ScrydexError) as caught:
                self._fetch("ex11-3", fake)
            self.assertNotIsInstance(caught.exception, sync.CardSkip)
            self.assertIn(f"HTTP {status}", str(caught.exception))
            self.assertEqual(caught.exception.credits, 1)

    def test_price_history_auth_errors_still_raise(self):
        def fake(url, headers):
            if "price_history" in url:
                return 403, {}
            return 200, {"data": {"name": "Card", "variants": []}}

        with self.assertRaises(sync.ScrydexError) as caught:
            self._fetch("ex11-3", fake)
        self.assertNotIsInstance(caught.exception, sync.CardSkip)
        self.assertIn("HTTP 403", str(caught.exception))
        self.assertEqual(caught.exception.credits, 4)


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cache = root / "scrydex.json"
        self.usage = root / "scrydex-usage.json"
        self.seed = root / "seed.txt"
        self.seed.write_text("A base1-4\nB sv03-223\n", encoding="utf-8")
        self.saved = {
            "CACHE_PATH": sync.CACHE_PATH,
            "USAGE_PATH": sync.USAGE_PATH,
            "SEED_PATH": sync.SEED_PATH,
            "request_json": sync.request_json,
            "sleep": sync.time.sleep,
        }
        sync.CACHE_PATH = self.cache
        sync.USAGE_PATH = self.usage
        sync.SEED_PATH = self.seed
        sync.time.sleep = lambda *_args, **_kwargs: None
        self.env = {name: os.environ.get(name) for name in (
            "SCRYDEX_API_KEY", "SCRYDEX_TEAM_ID", "SCRYDEX_MONTHLY_CAP",
            "SCRYDEX_STORE_RESERVE", "SCRYDEX_RUN_CAP", "SCRYDEX_RUN_CARD_CAP",
        )}
        os.environ["SCRYDEX_API_KEY"] = "super-secret-value"
        os.environ["SCRYDEX_TEAM_ID"] = "team-secret-value"
        os.environ["SCRYDEX_MONTHLY_CAP"] = "15000"
        os.environ["SCRYDEX_STORE_RESERVE"] = "15000"
        os.environ["SCRYDEX_RUN_CAP"] = "400"
        os.environ["SCRYDEX_RUN_CARD_CAP"] = "80"
        self.calls = []

    def tearDown(self):
        sync.CACHE_PATH = self.saved["CACHE_PATH"]
        sync.USAGE_PATH = self.saved["USAGE_PATH"]
        sync.SEED_PATH = self.saved["SEED_PATH"]
        sync.request_json = self.saved["request_json"]
        sync.time.sleep = self.saved["sleep"]
        for name, value in self.env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        self.tmp.cleanup()

    def test_low_balance_skips_card_lookups(self):
        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 12000}
            raise AssertionError("card lookup should not run")
        sync.request_json = fake
        self.assertEqual(sync.sync(datetime(2026, 10, 17, tzinfo=timezone.utc)), 0)
        self.assertEqual(self.calls, [sync.USAGE_API])
        self.assertFalse(self.cache.exists())
        text = self.usage.read_text(encoding="utf-8")
        self.assertNotIn("super-secret-value", text)
        self.assertNotIn("team-secret-value", text)
        self.assertEqual(json.loads(text)["months"]["2026-10"]["credits"], 1)

    def test_full_ledger_skips_before_the_account_read(self):
        self.usage.write_text(json.dumps({"months": {"2026-10": {"credits": 15000}}}), encoding="utf-8")
        def fake(url, headers):
            self.calls.append(url)
            return 200, {"credits_remaining": 50000}
        sync.request_json = fake
        self.assertEqual(sync.sync(datetime(2026, 10, 17, tzinfo=timezone.utc)), 0)
        self.assertEqual(self.calls, [])

    def test_run_cap_stops_before_the_next_card(self):
        os.environ["SCRYDEX_RUN_CAP"] = "5"
        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}
        sync.request_json = fake
        self.assertEqual(sync.sync(datetime(2026, 10, 17, tzinfo=timezone.utc)), 0)
        card_calls = [url for url in self.calls if "/cards/" in url]
        self.assertEqual(len(card_calls), 2)
        self.assertEqual(json.loads(self.usage.read_text())["months"]["2026-10"]["credits"], 5)
        self.assertIn("base1-4", json.loads(self.cache.read_text())["cards"])
        self.assertNotIn("sv03-223", json.loads(self.cache.read_text())["cards"])

    def _sync(self, fake, when=None):
        sync.request_json = fake
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = sync.sync(when or datetime(2026, 10, 17, tzinfo=timezone.utc))
        return code, buf.getvalue()

    def _main(self, fake):
        sync.request_json = fake
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = sync.main()
        return code, out.getvalue(), err.getvalue()

    def _ledger(self) -> int:
        if not self.usage.exists():
            return 0
        data = json.loads(self.usage.read_text(encoding="utf-8"))
        total = 0
        for row in data.get("months", {}).values():
            if isinstance(row, dict) and isinstance(row.get("credits"), int):
                total += row["credits"]
        return total

    def _cards(self) -> dict:
        return json.loads(self.cache.read_text(encoding="utf-8"))["cards"]

    def test_402_stops_on_the_first_response_and_fails(self):
        self.seed.write_text(
            "A base1-4\nA ex11-1\nA ex11-2\nA ex11-3\nA swsh7-215\n",
            encoding="utf-8",
        )

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-" in url:
                return 402, {"message": "payment required"}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{sync.PAYMENT_REQUIRED_MESSAGE}", err)
        self.assertIn("Scrydex HTTP 402 on card lookup for ex11-1:", out)
        self.assertIn("message=payment required", out)
        self.assertTrue(any("/ex11-1" in url for url in self.calls))
        self.assertFalse(any("/ex11-2" in url for url in self.calls))
        self.assertFalse(any("/ex11-3" in url for url in self.calls))
        self.assertFalse(any("/swsh7-215" in url for url in self.calls))
        self.assertEqual(list(self._cards()), ["base1-4"])
        self.assertEqual(self._ledger(), 6)
        self.assertNotIn("super-secret-value", out + err)
        self.assertNotIn("team-secret-value", out + err)

    def test_opening_402_fails_and_records_credits(self):
        self.seed.write_text("A ex11-1\nA ex11-2\nA ex11-3\nA base1-4\n", encoding="utf-8")

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-" in url:
                return 402, {"message": "payment required"}
            raise AssertionError(url)

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{sync.PAYMENT_REQUIRED_MESSAGE}", err)
        self.assertIn("card lookup for ex11-1", out)
        self.assertFalse(self.cache.exists())
        self.assertFalse(any("/ex11-2" in url for url in self.calls))
        self.assertFalse(any("/base1-4" in url for url in self.calls))
        self.assertEqual(self._ledger(), 2)
        self.assertNotIn("super-secret-value", self.usage.read_text(encoding="utf-8"))

    def test_first_card_402_fails_the_job(self):
        self.seed.write_text("A ex11-3\nA base1-4\n", encoding="utf-8")

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-3" in url:
                return 402, {"code": "payment_required", "message": "payment required"}
            raise AssertionError(url)

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{sync.PAYMENT_REQUIRED_MESSAGE}", err)
        self.assertIn("Scrydex HTTP 402 on card lookup for ex11-3: code=payment_required message=payment required", out)
        self.assertFalse(self.cache.exists())
        self.assertFalse(any("/base1-4" in url for url in self.calls))
        self.assertEqual(self.calls, [sync.USAGE_API, f"{sync.API}/ex11-3?include=prices,pop_reports"])
        self.assertEqual(self._ledger(), 2)

    def test_partial_cache_and_ledger_are_written_on_402(self):
        self.seed.write_text("A base1-4\nA ex11-3\nA swsh7-215\n", encoding="utf-8")

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-3" in url:
                return 402, {"error": "payment required"}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{sync.PAYMENT_REQUIRED_MESSAGE}", err)
        self.assertIn("card lookup for ex11-3", out)
        self.assertIn("message=payment required", out)
        cards = self._cards()
        self.assertIn("base1-4", cards)
        self.assertNotIn("ex11-3", cards)
        self.assertNotIn("swsh7-215", cards)
        self.assertFalse(any("/swsh7-215" in url for url in self.calls))
        self.assertEqual(self._ledger(), 6)
        self.assertNotIn("super-secret-value", out + err)
        self.assertNotIn("super-secret-value", self.cache.read_text(encoding="utf-8"))
        self.assertNotIn("super-secret-value", self.usage.read_text(encoding="utf-8"))

    def test_main_fails_when_a_later_card_is_402(self):
        self.seed.write_text("A base1-4\nA ex11-3\n", encoding="utf-8")

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-3" in url:
                return 402, {}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{sync.PAYMENT_REQUIRED_MESSAGE}", err)
        self.assertIn(sync.PAYMENT_REQUIRED_MESSAGE, err)
        self.assertIn("no provider error message", out)
        cards = self._cards()
        self.assertIn("base1-4", cards)
        self.assertNotIn("ex11-3", cards)
        self.assertGreaterEqual(self._ledger(), 5)

    def test_usage_402_fails_closed_without_card_requests(self):
        secret = os.environ["SCRYDEX_API_KEY"]
        team = os.environ["SCRYDEX_TEAM_ID"]

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 402, {
                    "code": "payment_required",
                    "message": "account " + secret + " inactive " + ("y" * 300),
                    "X-Api-Key": secret,
                    "Authorization": "Bearer " + team,
                }
            raise AssertionError(url)

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertEqual(self.calls, [sync.USAGE_API])
        self.assertFalse(self.cache.exists())
        self.assertIn(f"::error::{sync.PAYMENT_REQUIRED_MESSAGE}", err)
        self.assertIn("Scrydex HTTP 402 on account usage:", out)
        detail = out.split("Scrydex HTTP 402 on account usage: ", 1)[1].splitlines()[0]
        self.assertLessEqual(len(detail), 200)
        self.assertIn("code=payment_required", detail)
        self.assertIn("[redacted]", detail)
        self.assertNotIn(secret, out + err + detail)
        self.assertNotIn(team, out + err + detail)
        self.assertNotIn("Authorization", out + err)
        self.assertNotIn("Bearer", out + err)
        self.assertNotIn("X-Api-Key", out + err)
        self.assertNotIn("y" * 250, out + err)
        self.assertEqual(self._ledger(), 1)
        self.assertNotIn(secret, self.usage.read_text(encoding="utf-8"))

    def test_usage_5xx_fails_closed_without_card_requests(self):
        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 503, {"error": {"code": "upstream", "message": "unavailable"}}
            raise AssertionError(url)

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertEqual(self.calls, [sync.USAGE_API])
        self.assertFalse(self.cache.exists())
        self.assertIn("::error::", err)
        self.assertIn("HTTP 503", err)
        self.assertIn("no cards were requested", err)
        self.assertIn("account usage", out)
        self.assertIn("code=upstream", out)
        self.assertIn("message=unavailable", out)
        self.assertIn("code=upstream", err)
        self.assertEqual(self._ledger(), 1)
        self.assertNotIn("super-secret-value", out + err)
        self.assertNotIn("team-secret-value", out + err)

    def test_usage_missing_balance_fails_closed(self):
        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"plan": "growth"}
            raise AssertionError(url)

        code, _out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertEqual(self.calls, [sync.USAGE_API])
        self.assertFalse(self.cache.exists())
        self.assertIn("::error::", err)
        self.assertIn("remaining-credit field", err)
        self.assertIn("no cards were requested", err)
        self.assertIn("plan", err)
        self.assertNotIn("growth", err)
        self.assertEqual(self._ledger(), 1)

    def test_zero_credit_usage_makes_no_card_requests(self):
        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 0}
            raise AssertionError(url)

        code, log = self._sync(fake)
        self.assertEqual(code, 0)
        self.assertEqual(self.calls, [sync.USAGE_API])
        self.assertFalse(self.cache.exists())
        self.assertIn("Scrydex has 0 credits left", log)
        self.assertIn("15000", log)
        self.assertEqual(self._ledger(), 1)

    def _usage_response_fails_closed(self, status: int, raw: bytes, needle: str):
        """Drive the real response parser. No live Scrydex call."""
        calls = []
        original = sync.urllib.request.urlopen

        class Response:
            def __init__(self):
                self.status = status

            def read(self):
                return raw

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_open(request, timeout=30):
            calls.append(request.full_url)
            if not request.full_url.endswith("/usage"):
                raise AssertionError(request.full_url)
            if status >= 400:
                raise sync.urllib.error.HTTPError(
                    request.full_url, status, "error", None, io.BytesIO(raw)
                )
            return Response()

        sync.urllib.request.urlopen = fake_open
        try:
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = sync.main()
        finally:
            sync.urllib.request.urlopen = original
        logged = out.getvalue() + err.getvalue()
        self.assertEqual(code, 1)
        self.assertEqual(calls, [sync.USAGE_API])
        self.assertFalse(any("/cards/" in url for url in calls))
        self.assertFalse(self.cache.exists())
        self.assertIn("::error::", err.getvalue())
        self.assertIn(needle, err.getvalue())
        self.assertIn("no cards were requested", err.getvalue())
        self.assertEqual(self._ledger(), 1)
        self.assertNotIn("super-secret-value", logged)
        self.assertNotIn("team-secret-value", logged)

    def test_usage_200_empty_body_fails_closed(self):
        self._usage_response_fails_closed(200, b"", "HTTP 200")

    def test_usage_200_null_fails_closed(self):
        self._usage_response_fails_closed(200, b"null", "HTTP 200")

    def test_usage_200_array_fails_closed(self):
        self._usage_response_fails_closed(200, b"[]", "HTTP 200")

    def test_usage_200_number_fails_closed(self):
        self._usage_response_fails_closed(200, b"12", "HTTP 200")

    def test_usage_429_fails_closed(self):
        self._usage_response_fails_closed(429, b'{"message":"slow down"}', "HTTP 429")

    def test_usage_400_fails_closed(self):
        self._usage_response_fails_closed(400, b'{"message":"bad request"}', "HTTP 400")

    def test_usage_404_fails_closed(self):
        self._usage_response_fails_closed(404, b"{}", "HTTP 404")

    def test_http_500_is_a_per_card_skip(self):
        self.seed.write_text("A base1-4\nA ex11-3\nA swsh7-215\n", encoding="utf-8")

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-3" in url:
                return 500, {}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}

        code, log = self._sync(fake)
        self.assertEqual(code, 0)
        self.assertIn("ex11-3: skipped HTTP 500, credits=1", log)
        cards = json.loads(self.cache.read_text(encoding="utf-8"))["cards"]
        self.assertIn("base1-4", cards)
        self.assertIn("swsh7-215", cards)
        self.assertNotIn("ex11-3", cards)

    def test_http_401_still_fails_the_run(self):
        self.seed.write_text("A base1-4\nA ex11-3\n", encoding="utf-8")

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-3" in url:
                return 401, {}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}

        sync.request_json = fake
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(sync.ScrydexError) as caught:
                sync.sync(datetime(2026, 10, 17, tzinfo=timezone.utc))
        self.assertNotIsInstance(caught.exception, sync.CardSkip)
        self.assertIn("HTTP 401", str(caught.exception))
        cards = json.loads(self.cache.read_text(encoding="utf-8"))["cards"]
        self.assertIn("base1-4", cards)
        self.assertNotIn("ex11-3", cards)
        self.assertEqual(json.loads(self.usage.read_text(encoding="utf-8"))["months"]["2026-10"]["credits"], 6)

    def test_price_history_402_fails_and_keeps_earlier_cards(self):
        self.seed.write_text("A base1-4\nA ex11-3\nA swsh7-215\n", encoding="utf-8")

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-3" in url and "price_history" in url:
                return 402, {"message": "history blocked"}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{sync.PAYMENT_REQUIRED_MESSAGE}", err)
        self.assertIn("Scrydex HTTP 402 on price history for ex11-3:", out)
        self.assertIn("message=history blocked", out)
        cards = self._cards()
        self.assertIn("base1-4", cards)
        self.assertNotIn("ex11-3", cards)
        self.assertNotIn("swsh7-215", cards)
        self.assertFalse(any("/swsh7-215" in url for url in self.calls))
        self.assertEqual(self._ledger(), 9)

    def test_three_5xx_in_a_row_fails_and_keeps_earlier_cards(self):
        self.seed.write_text(
            "A base1-4\nA ex11-1\nA ex11-2\nA ex11-3\nA swsh7-215\n",
            encoding="utf-8",
        )

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-" in url:
                return 503, {"error": {"code": "upstream", "message": "bad gateway"}}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}

        code, out, err = self._main(fake)
        self.assertEqual(code, 1)
        self.assertIn("::error::", err)
        self.assertIn("HTTP 503 on 3 cards in a row", err)
        self.assertIn("stage card lookup", err)
        self.assertIn("Scrydex HTTP 503 on card lookup for ex11-1:", out)
        self.assertIn("code=upstream", out)
        self.assertIn("message=bad gateway", out)
        self.assertIn("ex11-3: skipped HTTP 503, credits=1, stage=card lookup", out)
        self.assertTrue(any("/ex11-3" in url for url in self.calls))
        self.assertFalse(any("/swsh7-215" in url for url in self.calls))
        self.assertEqual(list(self._cards()), ["base1-4"])
        self.assertEqual(self._ledger(), 8)
        self.assertNotIn("super-secret-value", out + err)

    def test_two_5xx_do_not_fail_the_run(self):
        self.seed.write_text("A ex11-1\nA ex11-2\nA base1-4\n", encoding="utf-8")

        def fake(url, headers):
            self.calls.append(url)
            if url.endswith("/usage"):
                return 200, {"credits_remaining": 50000}
            if "/ex11-" in url:
                return 500, {"message": "temp"}
            if "price_history" in url:
                return 200, {"count": 0, "total_count": 0, "data": []}
            return 200, {"data": {"name": "Card", "variants": []}}

        code, out, err = self._main(fake)
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertIn("stage=card lookup", out)
        self.assertIn("message=temp", out)
        cards = self._cards()
        self.assertIn("base1-4", cards)
        self.assertNotIn("ex11-1", cards)
        self.assertNotIn("ex11-2", cards)


class WorkflowGuardTests(unittest.TestCase):
    def test_commit_runs_after_a_failed_refresh(self):
        text = (Path(__file__).resolve().parents[1] / ".github" / "workflows" / "scrydex.yml").read_text(encoding="utf-8")
        self.assertIn("always() && !cancelled()", text)
        self.assertNotIn("continue-on-error", text)
        self.assertIn("git diff --cached --quiet", text)
        self.assertIn("data/scrydex.json data/scrydex-usage.json", text)
        self.assertIn("SCRYDEX_MONTHLY_CAP: ${{ vars.SCRYDEX_MONTHLY_CAP || '15000' }}", text)
        self.assertIn("SCRYDEX_STORE_RESERVE: ${{ vars.SCRYDEX_STORE_RESERVE || '15000' }}", text)
        sync_text = Path(__file__).resolve().with_name("sync_scrydex.py").read_text(encoding="utf-8")
        self.assertIn("MONTHLY_CAP = 15000", sync_text)
        self.assertIn("STORE_RESERVE = 15000", sync_text)
        self.assertIn(sync.PAYMENT_REQUIRED_MESSAGE, sync_text)


class CacheWriteTests(unittest.TestCase):
    def test_refresh_keeps_existing_illustrator(self):
        kept = sync.preserve_illustrator(
            {"name": "Venusaur", "history": []},
            {"name": "Venusaur", "illustrator": "Ken Sugimori", "history": []},
        )
        self.assertEqual(kept["illustrator"], "Ken Sugimori")
        self.assertEqual(kept["history"], [])
        fresh = sync.preserve_illustrator({"name": "New"}, {"name": "Old"})
        self.assertNotIn("illustrator", fresh)

    def test_write_cache_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "scrydex.json"
            sync.write_cache({"source": "Scrydex", "cards": {"base1-4": {"history": []}}}, path)
            self.assertEqual(json.loads(path.read_text())["cards"]["base1-4"]["history"], [])


if __name__ == "__main__":
    unittest.main()
