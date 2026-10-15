#!/usr/bin/env python3
"""Refresh BinderHunt's small Scrydex cache.

Scrydex documents general card requests as 1 credit and price history as
3 credits. This script makes those two calls for at most 10 due cards:

  GET /pokemon/v1/cards/{id}?include=prices,pop_reports
  GET /pokemon/v1/cards/{id}/price_history?days=90&page_size=100

A full run is therefore at most 40 credits. The daily workflow stays near
that ceiling only while the cache is catching up. Once warm, tier A cards
are older than 48 hours and tier B cards older than 7 days, which is about
30 credits a day, or roughly 900–1,200 credits a month.

The API key and team id are read from the environment and sent only as
request headers. They are never printed, written into the JSON, or passed
on the command line.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED_PATH = ROOT / "data" / "scrydex-seed.txt"
CACHE_PATH = ROOT / "data" / "scrydex.json"
API = "https://api.scrydex.com/pokemon/v1/cards"
MAX_PER_RUN = 10
HISTORY_DAYS = 90
TIER_A_HOURS = 48
TIER_B_HOURS = 24 * 7
MISSING_HOURS = 24 * 14
REQUEST_PAUSE_SEC = 0.35


class ScrydexError(Exception):
    pass


def require_secrets() -> tuple[str, str]:
    key = os.environ.get("SCRYDEX_API_KEY", "")
    team = os.environ.get("SCRYDEX_TEAM_ID", "")
    missing = []
    if not key.strip():
        missing.append("SCRYDEX_API_KEY")
    if not team.strip():
        missing.append("SCRYDEX_TEAM_ID")
    if missing:
        names = " and ".join(missing)
        raise ScrydexError(
            "Missing Scrydex secret "
            + names
            + ". Add it under GitHub Settings → Secrets and variables → Actions. "
            + "SCRYDEX_API_KEY is the API key from the Scrydex dashboard. "
            + "SCRYDEX_TEAM_ID is the team id from the Scrydex account hub "
            + "(the X-Team-ID header). Both are required. "
            + "The values were not printed."
        )
    return key.strip(), team.strip()


def parse_time(value: str | None) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_seed(path: Path = SEED_PATH) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    text = path.read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2 or parts[0] not in {"A", "B"}:
            raise ScrydexError(f"Bad seed line in {path.name}: {line}")
        rows.append((parts[0], parts[1]))
    if not rows:
        raise ScrydexError(f"No cards listed in {path}")
    return rows


def load_cache(path: Path = CACHE_PATH) -> dict:
    if not path.exists():
        return {"source": "Scrydex", "generated_at": None, "history_days": HISTORY_DAYS, "cards": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ScrydexError(f"{path.name} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("cards"), dict):
        raise ScrydexError(f"{path.name} is missing a cards object")
    return data


def as_float(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number:
        return None
    return number


def trim_history(payload: dict) -> tuple[list[dict], bool]:
    days = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(days, list):
        return [], False
    rows = []
    seen = set()
    for day in days:
        if not isinstance(day, dict):
            continue
        date = day.get("date")
        if not isinstance(date, str) or len(date) < 8:
            continue
        date = date[:10]
        for price in day.get("prices") or []:
            if not isinstance(price, dict):
                continue
            if price.get("type") not in (None, "raw"):
                continue
            if price.get("condition") not in (None, "NM"):
                continue
            if price.get("is_signed") or price.get("is_error"):
                continue
            if price.get("currency") not in (None, "USD"):
                continue
            market = as_float(price.get("market"))
            if market is None:
                continue
            variant = str(price.get("variant") or "normal")
            key = (date, variant)
            if key in seen:
                continue
            seen.add(key)
            rows.append({"d": date, "v": variant, "m": round(market, 2)})
    rows.sort(key=lambda row: (row["d"], row["v"]))
    total = payload.get("total_count")
    count = payload.get("count")
    truncated = isinstance(total, int) and isinstance(count, int) and total > count
    return rows, truncated


def card_body(payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    return payload


def trim_graded_and_pop(payload: dict) -> tuple[list[dict], list[dict]]:
    card = card_body(payload)
    graded = []
    pop = []
    graded_seen = set()
    pop_seen = set()
    for variant in card.get("variants") or []:
        if not isinstance(variant, dict):
            continue
        name = str(variant.get("name") or "")
        for price in variant.get("prices") or []:
            if not isinstance(price, dict) or price.get("type") != "graded":
                continue
            if price.get("is_signed") or price.get("is_error"):
                continue
            market = as_float(price.get("market"))
            low = as_float(price.get("low"))
            mid = as_float(price.get("mid"))
            high = as_float(price.get("high"))
            if market is None and low is None and mid is None and high is None:
                continue
            company = str(price.get("company") or "")
            grade = str(price.get("grade") or "")
            key = (name, company, grade)
            if key in graded_seen:
                continue
            graded_seen.add(key)
            graded.append({
                "variant": name,
                "company": company,
                "grade": grade,
                "market": None if market is None else round(market, 2),
                "low": None if low is None else round(low, 2),
                "mid": None if mid is None else round(mid, 2),
                "high": None if high is None else round(high, 2),
                "currency": price.get("currency") or "USD",
            })
        for report in variant.get("pop_reports") or []:
            if not isinstance(report, dict):
                continue
            grades = []
            for item in report.get("grades") or []:
                if not isinstance(item, dict):
                    continue
                count = item.get("count")
                if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                    continue
                if item.get("grade") is None:
                    continue
                grades.append({"grade": str(item.get("grade")), "count": count})
            total = report.get("total")
            if not grades and not isinstance(total, int):
                continue
            company = str(report.get("company") or "")
            key = (name, company)
            if key in pop_seen:
                continue
            pop_seen.add(key)
            pop.append({
                "variant": name,
                "company": company,
                "total": total if isinstance(total, int) and total >= 0 else None,
                "grades": grades,
            })
    return graded, pop


def select_due(
    seed: list[tuple[str, str]],
    cards: dict,
    now: datetime,
    max_cards: int = MAX_PER_RUN,
) -> list[str]:
    ranked = []
    for index, (tier, card_id) in enumerate(seed):
        rec = cards.get(card_id) if isinstance(cards.get(card_id), dict) else {}
        fetched = parse_time(rec.get("fetched_at"))
        if rec.get("missing"):
            limit = MISSING_HOURS
        elif tier == "A":
            limit = TIER_A_HOURS
        else:
            limit = TIER_B_HOURS
        age = None if fetched is None else (now - fetched).total_seconds() / 3600
        if age is not None and age < limit:
            continue
        ranked.append((0 if tier == "A" else 1, 0 if age is None else 1, -(age or 0), index, card_id))
    ranked.sort()
    chosen = []
    seen = set()
    for *_, card_id in ranked:
        if card_id in seen:
            continue
        seen.add(card_id)
        chosen.append(card_id)
        if len(chosen) >= max_cards:
            break
    return chosen


def request_json(url: str, headers: dict) -> tuple[int, dict | list | None]:
    request = urllib.request.Request(url, headers={**headers, "Accept": "application/json", "User-Agent": "BinderHunt-scrydex-sync"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except urllib.error.URLError as exc:
        raise ScrydexError(f"Scrydex request failed before a response: {exc.reason}") from exc
    text = raw.decode("utf-8", "replace")
    try:
        body = json.loads(text) if text else None
    except json.JSONDecodeError:
        body = {"error": text[:180]}
    return status, body


def fetch_card(card_id: str, headers: dict, now: datetime) -> tuple[dict, bool]:
    """Return (record, stop). stop is true when Scrydex rate-limits the run."""
    quoted = urllib.parse.quote(card_id, safe="")
    status, payload = request_json(f"{API}/{quoted}?include=prices,pop_reports", headers)
    if status in (401, 403):
        raise ScrydexError(
            f"Scrydex rejected the credentials (HTTP {status}). "
            "Check the SCRYDEX_API_KEY and SCRYDEX_TEAM_ID repository secrets. "
            "The secret values were not printed."
        )
    if status == 429:
        raise ScrydexError("RATE_LIMIT")
    if status == 404:
        return {"fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "missing": True}, False
    if status != 200 or not isinstance(payload, dict):
        raise ScrydexError(f"Card {card_id} lookup failed with HTTP {status}.")
    time.sleep(REQUEST_PAUSE_SEC)
    h_status, history_payload = request_json(
        f"{API}/{quoted}/price_history?days={HISTORY_DAYS}&page_size=100",
        headers,
    )
    if h_status in (401, 403):
        raise ScrydexError(
            f"Scrydex rejected the credentials (HTTP {h_status}) on price history. "
            "Check SCRYDEX_API_KEY and SCRYDEX_TEAM_ID. The secret values were not printed."
        )
    stop = False
    history: list[dict] = []
    truncated = False
    if h_status == 429:
        stop = True
    elif h_status == 200 and isinstance(history_payload, dict):
        history, truncated = trim_history(history_payload)
    elif h_status not in (200, 404):
        raise ScrydexError(f"Price history for {card_id} failed with HTTP {h_status}.")
    graded, pop = trim_graded_and_pop(payload)
    name = card_body(payload).get("name")
    record = {
        "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "name": name if isinstance(name, str) else "",
        "history": history,
        "history_truncated": truncated,
        "graded": graded,
        "pop": pop,
    }
    return record, stop


def write_cache(cache: dict, path: Path = CACHE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def sync(now: datetime | None = None) -> int:
    key, team = require_secrets()
    headers = {"X-Api-Key": key, "X-Team-ID": team}
    now = now or datetime.now(timezone.utc)
    seed = load_seed()
    cache = load_cache()
    cards = cache["cards"]
    due = select_due(seed, cards, now)
    if not due:
        print(f"No cards due. Cache has {len(cards)} card(s); nothing was requested.")
        return 0
    print(f"Refreshing {len(due)} card(s). Published cost is 4 credits each (1 card + 3 history), {len(due) * 4} credits max.")
    refreshed = 0
    rate_limited = False
    try:
        for card_id in due:
            try:
                record, stop = fetch_card(card_id, headers, now)
            except ScrydexError as exc:
                if str(exc) == "RATE_LIMIT":
                    rate_limited = True
                    print("Scrydex returned HTTP 429. Stopped so this run does not spend more credits.")
                    break
                raise
            cards[card_id] = record
            refreshed += 1
            if record.get("missing"):
                print(f"  {card_id}: not found")
            else:
                print(
                    f"  {card_id}: history={len(record['history'])} graded={len(record['graded'])} pop={len(record['pop'])}"
                )
            if stop:
                rate_limited = True
                print("Scrydex returned HTTP 429 after a card lookup. History for that card was skipped and the run stopped.")
                break
            time.sleep(REQUEST_PAUSE_SEC)
    finally:
        if refreshed:
            cache["source"] = "Scrydex"
            cache["generated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
            cache["history_days"] = HISTORY_DAYS
            cache["cards"] = cards
            write_cache(cache)
            print(f"Wrote {CACHE_PATH.relative_to(ROOT)} ({refreshed} card(s) updated).")
    if rate_limited and not refreshed:
        raise ScrydexError(
            "Scrydex returned HTTP 429 before any card was saved. "
            "Wait and run the workflow again. No secret values were printed."
        )
    return 0


def main() -> int:
    try:
        return sync()
    except ScrydexError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
