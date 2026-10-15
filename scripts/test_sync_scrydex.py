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


class CacheWriteTests(unittest.TestCase):
    def test_write_cache_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "scrydex.json"
            sync.write_cache({"source": "Scrydex", "cards": {"base1-4": {"history": []}}}, path)
            self.assertEqual(json.loads(path.read_text())["cards"]["base1-4"]["history"], [])


if __name__ == "__main__":
    unittest.main()
