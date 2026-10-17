#!/usr/bin/env python3
import io
import json
import unittest
from pathlib import Path
from unittest import mock

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

    def test_fetch_sends_a_user_agent(self):
        seen = {}

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_open(req, timeout=0):
            seen["ua"] = req.get_header("User-agent")
            seen["timeout"] = timeout
            return Resp(b'{"date":"2026-10-16","rates":{"USD":1.1253}}')

        with mock.patch.object(fetch_fx.urllib.request, "urlopen", fake_open):
            payload = fetch_fx.fetch_payload("https://api.frankfurter.dev/v1/latest?from=EUR&to=USD", timeout=3)
        self.assertEqual(payload["rates"]["USD"], 1.1253)
        self.assertIn("BinderHunt", seen["ua"])
        self.assertNotIn("Python-urllib", seen["ua"])

    def test_shipped_file_is_readable(self):
        raw = json.loads((Path(__file__).resolve().parents[1] / "data" / "fx.json").read_text())
        self.assertEqual(fetch_fx.parse_rate({"date": raw["date"], "rates": {"USD": raw["eurUsd"]}})["eurUsd"], raw["eurUsd"])


if __name__ == "__main__":
    unittest.main()
