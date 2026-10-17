#!/usr/bin/env python3
"""Write data/fx.json with the daily EUR to USD rate.

The page reads this file from the same origin, so a visit does not call a
third party. No API key. A failed fetch leaves an existing file alone.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "fx.json"
URL = "https://api.frankfurter.dev/v1/latest?from=EUR&to=USD"
# frankfurter.dev answers 403 to Python's default urllib user agent.
UA = "BinderHunt/1.0 (+https://kyrohmotz.github.io/binderhunt)"
# Last good ECB rate, used only when the file is missing and the request fails.
FALLBACK = 1.1253


def parse_rate(payload):
    if not isinstance(payload, dict):
        return None
    rates = payload.get("rates")
    if not isinstance(rates, dict) or "USD" not in rates:
        return None
    try:
        rate = float(rates["USD"])
    except (TypeError, ValueError):
        return None
    if not 0.2 < rate < 5:
        return None
    date = payload.get("date")
    if not isinstance(date, str) or len(date) < 8:
        date = datetime.now(timezone.utc).date().isoformat()
    return {"date": date[:10], "eurUsd": round(rate, 4), "source": "frankfurter"}


def fetch_payload(url=URL, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def write_fx(path=OUT, url=URL):
    try:
        row = parse_rate(fetch_payload(url))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError) as exc:
        print(f"fx fetch failed: {exc}")
        row = None
    if row is None:
        if path.exists():
            print(f"keeping {path}")
            return 0
        row = {
            "date": datetime.now(timezone.utc).date().isoformat(),
            "eurUsd": FALLBACK,
            "source": "fallback",
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(row, indent=2) + "\n")
    print(f"{path} {row['eurUsd']} {row['date']}")
    return 0


def main() -> int:
    return write_fx()


if __name__ == "__main__":
    sys.exit(main())
