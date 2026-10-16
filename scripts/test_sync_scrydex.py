#!/usr/bin/env python3
import json
import os
import tempfile
import unittest
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
        self.assertEqual(due, ["new-a", "stale-a"])

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
        self.assertIn("base1-4", ids)
        self.assertIn("swsh7-215", ids)
        self.assertLessEqual(len(ids), 40)


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
            record, stop = sync.fetch_card("sv03-223", {}, datetime(2026, 10, 16, tzinfo=timezone.utc))
        finally:
            sync.request_json = original
            sync.time.sleep = original_sleep
        self.assertFalse(stop)
        self.assertFalse(record.get("missing"))
        self.assertEqual(record["lookup_id"], "sv3-223")
        self.assertEqual(len(calls), 2)
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
            record, stop = sync.fetch_card("sv03-223", {}, datetime(2026, 10, 16, tzinfo=timezone.utc))
        finally:
            sync.request_json = original
            sync.time.sleep = original_sleep
        self.assertFalse(record.get("missing"))
        self.assertEqual(record["lookup_id"], "sv03-223")
        self.assertEqual(len(calls), 3)
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
            record, stop = sync.fetch_card("sv03-223", {}, datetime(2026, 10, 16, tzinfo=timezone.utc))
        finally:
            sync.request_json = original
            sync.time.sleep = original_sleep
        self.assertTrue(record.get("missing"))
        self.assertEqual(record["lookup_id"], "sv3-223")
        self.assertFalse(stop)
        self.assertEqual(len(calls), 2)
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


class CacheWriteTests(unittest.TestCase):
    def test_write_cache_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "scrydex.json"
            sync.write_cache({"source": "Scrydex", "cards": {"base1-4": {"history": []}}}, path)
            self.assertEqual(json.loads(path.read_text())["cards"]["base1-4"]["history"], [])


if __name__ == "__main__":
    unittest.main()
