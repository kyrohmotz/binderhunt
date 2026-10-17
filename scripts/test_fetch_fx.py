#!/usr/bin/env python3
import json
import unittest
from pathlib import Path

import fetch_fx


class FetchFxTests(unittest.TestCase):
    def test_parse_rate_keeps_a_sane_daily_quote(self):
        row = fetch_fx.parse_rate({"date": "2026-10-16", "rates": {"USD": 1.1253}})
        self.assertEqual(row["eurUsd"], 1.1253)
        self.assertEqual(row["date"], "2026-10-16")
        self.assertEqual(row["source"], "frankfurter")

    def test_parse_rate_rejects_junk(self):
        self.assertIsNone(fetch_fx.parse_rate({"rates": {"USD": 0}}))
        self.assertIsNone(fetch_fx.parse_rate({"rates": {}}))
        self.assertIsNone(fetch_fx.parse_rate(None))

    def test_shipped_file_is_readable(self):
        raw = json.loads((Path(__file__).resolve().parents[1] / "data" / "fx.json").read_text())
        self.assertEqual(fetch_fx.parse_rate({"date": raw["date"], "rates": {"USD": raw["eurUsd"]}})["eurUsd"], raw["eurUsd"])


if __name__ == "__main__":
    unittest.main()
