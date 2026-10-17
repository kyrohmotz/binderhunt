#!/usr/bin/env python3
"""Refresh BinderHunt's Scrydex cache inside a shared Growth budget.

Scrydex documents a card lookup as 1 credit and price history as 3 credits:

  GET /pokemon/v1/cards/{id}?include=prices,pop_reports
  GET /pokemon/v1/cards/{id}/price_history?days=90&page_size=100
  GET /account/v1/usage

A hit is 4 credits. A mapped id that 404s and then hits on the catalog id
costs 5, because history is requested only after a hit. Both ids missing
costs 2. The account usage read is 1 credit when that endpoint responds.

The subscription is shared with the store. Before any card lookup this script
reads remaining credits. It skips the run when fewer than SCRYDEX_STORE_RESERVE
credits would be left (default 15,000). BinderHunt's own ledger stops at
SCRYDEX_MONTHLY_CAP (default 15,000). A run also stops at SCRYDEX_RUN_CAP
credits (default 500) and SCRYDEX_RUN_CARD_CAP cards (default 100).

While any seeded card has never been fetched, the run backfills the most
valuable unfetched cards. After that, tier A (the top of the seed) refreshes
weekly and tier B refreshes monthly. Cards people open or save often are
read from data/price-demand.json and refresh every 90 days, only after the
chase seed has room. Everything else keeps the TCGdex catalog price.

Catalog ids from TCGdex are mapped before the request (sv03-223 becomes
sv3-223). The record is stored under the catalog id. Secrets are read from
the environment and sent only as headers. They are never printed.
"""

from __future__ import annotations

import json
import os
import re
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
USAGE_PATH = ROOT / "data" / "scrydex-usage.json"
DEMAND_PATH = ROOT / "data" / "price-demand.json"
API = "https://api.scrydex.com/pokemon/v1/cards"
USAGE_API = "https://api.scrydex.com/account/v1/usage"
MAX_PER_RUN = 100
RUN_CREDIT_CAP = 500
MONTHLY_CAP = 15000
STORE_RESERVE = 15000
HISTORY_DAYS = 90
TIER_A_HOURS = 24 * 7
TIER_B_HOURS = 24 * 30
DEMAND_HOURS = 24 * 90
DEMAND_MIN = 2
MISSING_HOURS = 24 * 30
REQUEST_PAUSE_SEC = 0.35
# TCGdex zero-pads set numbers and writes special sets as ".5".
# Scrydex uses the Pokémon TCG API form: sv03 -> sv3, sv03.5 -> sv3pt5, me02 -> me2.
_SET_RE = re.compile(r"^([a-z]+)(\d+)(\.5)?$")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ScrydexError(Exception):
    def __init__(self, message: str, credits: int = 0):
        super().__init__(message)
        self.credits = credits


def map_scrydex_id(catalog_id: str) -> str:
    """Return the Scrydex id for a catalog id. Unchanged when already canonical."""
    if not isinstance(catalog_id, str) or "-" not in catalog_id:
        return catalog_id
    set_id, number = catalog_id.rsplit("-", 1)
    match = _SET_RE.fullmatch(set_id)
    if not match:
        return catalog_id
    prefix, digits, half = match.group(1), match.group(2), match.group(3)
    if not half and not digits.startswith("0"):
        return catalog_id
    mapped_set = f"{prefix}{int(digits)}{'pt5' if half else ''}"
    mapped_number = str(int(number)) if number.isdigit() else number
    return f"{mapped_set}-{mapped_number}"


def scrydex_candidates(catalog_id: str) -> list[str]:
    """Mapped id first, then the catalog id. Never more than two."""
    mapped = map_scrydex_id(catalog_id)
    if mapped != catalog_id:
        return [mapped, catalog_id]
    return [catalog_id]


def record_needs_remap(rec: dict, catalog_id: str) -> bool:
    """A miss stored under the raw TCGdex id should be tried with the mapped id."""
    if not isinstance(rec, dict) or not rec.get("missing"):
        return False
    mapped = map_scrydex_id(catalog_id)
    if mapped == catalog_id:
        return False
    tried = rec.get("lookup_id")
    if not isinstance(tried, str) or not tried:
        return True
    return tried != mapped


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


def load_seed(path: Path | None = None) -> list[tuple[str, str]]:
    path = SEED_PATH if path is None else path
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


def load_cache(path: Path | None = None) -> dict:
    path = CACHE_PATH if path is None else path
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


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ScrydexError(f"{name} must be a whole number. The value was not printed.") from exc
    if value < 0:
        raise ScrydexError(f"{name} must be zero or greater.")
    return value


def card_is_unfilled(rec: dict, card_id: str) -> bool:
    if not rec or not rec.get("fetched_at"):
        return True
    return record_needs_remap(rec, card_id)


def load_demand(path: Path | None = None) -> dict[str, int]:
    """Counts of cards people opened or saved. Missing file means no demand."""
    target = path or DEMAND_PATH
    try:
        parsed = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    counts = parsed.get("counts") if isinstance(parsed, dict) else None
    if not isinstance(counts, dict):
        return {}
    clean: dict[str, int] = {}
    for key, value in counts.items():
        if not isinstance(key, str) or not _ID_RE.fullmatch(key.strip()):
            continue
        try:
            clean[key.strip()] = max(0, int(value))
        except (TypeError, ValueError):
            continue
    return clean


def _with_demand(
    due: list[str],
    seed: list[tuple[str, str]],
    cards: dict,
    now: datetime,
    demand: dict[str, int] | None,
    max_cards: int,
) -> list[str]:
    """Append often-opened cards after the chase list. They refresh every 90 days."""
    if not demand or len(due) >= max_cards:
        return due[:max_cards]
    seed_ids = {card_id for _tier, card_id in seed}
    ranked = []
    for card_id, count in demand.items():
        if count < DEMAND_MIN or card_id in seed_ids or card_id in due:
            continue
        rec = cards.get(card_id) if isinstance(cards.get(card_id), dict) else {}
        if card_is_unfilled(rec, card_id):
            ranked.append((-count, 0, card_id))
            continue
        fetched = parse_time(rec.get("fetched_at"))
        age = None if fetched is None else (now - fetched).total_seconds() / 3600
        if age is None or age < DEMAND_HOURS:
            continue
        ranked.append((-count, -(age or 0), card_id))
    ranked.sort()
    room = max_cards - len(due)
    return due + [card_id for *_rest, card_id in ranked[:room]]


def select_due(
    seed: list[tuple[str, str]],
    cards: dict,
    now: datetime,
    max_cards: int = MAX_PER_RUN,
    demand: dict[str, int] | None = None,
) -> list[str]:
    """Backfill unfetched cards first. Then weekly tier A and monthly tier B."""
    unfilled = []
    seen = set()
    for _tier, card_id in seed:
        if card_id in seen:
            continue
        seen.add(card_id)
        rec = cards.get(card_id) if isinstance(cards.get(card_id), dict) else {}
        if card_is_unfilled(rec, card_id):
            unfilled.append(card_id)
    if unfilled:
        return _with_demand(unfilled, seed, cards, now, demand, max_cards)
    ranked = []
    seen.clear()
    for index, (tier, card_id) in enumerate(seed):
        if card_id in seen:
            continue
        seen.add(card_id)
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
        ranked.append((0 if tier == "A" else 1, -(age or 0), index, card_id))
    ranked.sort()
    due = [card_id for *_, card_id in ranked[:max_cards]]
    return _with_demand(due, seed, cards, now, demand, max_cards)


def max_card_credits(card_id: str) -> int:
    """Worst case for one card: two lookups and one history read."""
    return len(scrydex_candidates(card_id)) + 3


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


def fetch_card(card_id: str, headers: dict, now: datetime) -> tuple[dict, bool, int]:
    """Return (record, stop, credits). stop is true when Scrydex rate-limits the run.

    At most two card lookups. History (3 credits) runs only after a hit.
    Each completed card lookup counts as 1 credit. A history response counts as 3.
    """
    credits = 0
    payload = None
    used = None
    candidates = scrydex_candidates(card_id)

    def fail(message: str) -> None:
        raise ScrydexError(message, credits=credits)

    for index, lookup in enumerate(candidates):
        quoted = urllib.parse.quote(lookup, safe="")
        status, body = request_json(f"{API}/{quoted}?include=prices,pop_reports", headers)
        credits += 1
        if status in (401, 403):
            fail(
                f"Scrydex rejected the credentials (HTTP {status}). "
                "Check the SCRYDEX_API_KEY and SCRYDEX_TEAM_ID repository secrets. "
                "The secret values were not printed."
            )
        if status == 429:
            fail("RATE_LIMIT")
        if status == 200 and isinstance(body, dict):
            payload = body
            used = lookup
            break
        if status == 404:
            if index < len(candidates) - 1:
                time.sleep(REQUEST_PAUSE_SEC)
                continue
            return {
                "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "missing": True,
                "lookup_id": map_scrydex_id(card_id),
            }, False, credits
        fail(f"Card {card_id} lookup failed with HTTP {status}.")
    if payload is None or used is None:
        fail(f"Card {card_id} lookup failed.")
    time.sleep(REQUEST_PAUSE_SEC)
    quoted = urllib.parse.quote(used, safe="")
    h_status, history_payload = request_json(
        f"{API}/{quoted}/price_history?days={HISTORY_DAYS}&page_size=100",
        headers,
    )
    credits += 3
    if h_status in (401, 403):
        fail(
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
        fail(f"Price history for {card_id} failed with HTTP {h_status}.")
    graded, pop = trim_graded_and_pop(payload)
    name = card_body(payload).get("name")
    record = {
        "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lookup_id": used,
        "name": name if isinstance(name, str) else "",
        "history": history,
        "history_truncated": truncated,
        "graded": graded,
        "pop": pop,
    }
    return record, stop, credits


def write_cache(cache: dict, path: Path | None = None) -> None:
    path = CACHE_PATH if path is None else path
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_usage(path: Path | None = None) -> dict:
    path = USAGE_PATH if path is None else path
    if not path.exists():
        return {"months": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"months": {}}
    if not isinstance(data, dict) or not isinstance(data.get("months"), dict):
        return {"months": {}}
    return data


def month_credits(usage: dict, month: str) -> int:
    row = usage.get("months", {}).get(month) or {}
    value = row.get("credits", 0) if isinstance(row, dict) else 0
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def add_usage(usage: dict, month: str, credits: int, now: datetime) -> None:
    if credits <= 0:
        return
    months = usage.setdefault("months", {})
    row = months.get(month)
    if not isinstance(row, dict):
        row = {"credits": 0, "runs": 0}
        months[month] = row
    row["credits"] = month_credits(usage, month) + credits
    row["updated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")


def write_usage(usage: dict, path: Path | None = None) -> None:
    path = USAGE_PATH if path is None else path
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(usage, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def remaining_credits(body: dict) -> int | None:
    if not isinstance(body, dict):
        return None
    for key in ("credits_remaining", "remaining_credits", "creditsRemaining"):
        value = body.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value == int(value):
            return int(value)
    nested = body.get("data")
    if isinstance(nested, dict):
        return remaining_credits(nested)
    return None


def read_account_remaining(headers: dict) -> tuple[int | None, int, bool]:
    """Return (credits left, cost of this read, whether to skip).

    A 404 means the endpoint is not offered, so the local ledger is enough.
    A 200 without a remaining-credit field skips the run.
    """
    status, body = request_json(USAGE_API, headers)
    if status == 404:
        print("Scrydex account usage is not offered (HTTP 404). Using the local monthly ledger.")
        return None, 0, False
    if status in (401, 403):
        raise ScrydexError(
            f"Scrydex rejected the credentials (HTTP {status}) on account usage. "
            "Check SCRYDEX_API_KEY and SCRYDEX_TEAM_ID. The secret values were not printed.",
            credits=1,
        )
    if status != 200 or not isinstance(body, dict):
        print(f"Scrydex account usage returned HTTP {status}. Using the local monthly ledger.")
        return None, 0, False
    remaining = remaining_credits(body)
    if remaining is None:
        keys = ",".join(sorted(str(key) for key in body.keys()))
        print(
            f"Scrydex account usage did not include a remaining-credit field ({keys}). "
            "Skipping so the store balance is not guessed."
        )
        return None, 1, True
    return remaining, 1, False


def sync(now: datetime | None = None) -> int:
    key, team = require_secrets()
    headers = {"X-Api-Key": key, "X-Team-ID": team}
    now = now or datetime.now(timezone.utc)
    monthly_cap = env_int("SCRYDEX_MONTHLY_CAP", MONTHLY_CAP)
    store_reserve = env_int("SCRYDEX_STORE_RESERVE", STORE_RESERVE)
    run_credit_cap = env_int("SCRYDEX_RUN_CAP", RUN_CREDIT_CAP)
    run_card_cap = env_int("SCRYDEX_RUN_CARD_CAP", MAX_PER_RUN)
    month = now.strftime("%Y-%m")
    usage = load_usage()
    spent_month = month_credits(usage, month)
    if spent_month >= monthly_cap:
        print(f"Skipping. BinderHunt has logged {spent_month} credits in {month}, and the cap is {monthly_cap}.")
        return 0
    try:
        remaining, check_credits, usage_skip = read_account_remaining(headers)
    except ScrydexError as exc:
        if exc.credits:
            add_usage(usage, month, exc.credits, now)
            write_usage(usage)
        raise
    run_credits = check_credits
    if check_credits:
        add_usage(usage, month, check_credits, now)
        spent_month += check_credits
        write_usage(usage)
    if usage_skip:
        print(f"credits this run: {run_credits}")
        print(f"credits this month ({month}): {spent_month} / {monthly_cap}")
        return 0
    if remaining is not None and remaining - store_reserve < 2:
        print(
            f"Skipping. Scrydex has {remaining} credits left. "
            f"A card fetch would leave fewer than {store_reserve} for the store."
        )
        print(f"credits this run: {run_credits}")
        print(f"credits this month ({month}): {spent_month} / {monthly_cap}")
        return 0
    room = monthly_cap - spent_month
    if remaining is not None:
        room = min(room, remaining - store_reserve)
    if room < 2 or run_credit_cap < 2 or run_card_cap < 1:
        print(
            f"Skipping. Credit room this run is {max(room, 0)} "
            f"(monthly cap {monthly_cap}, per-run cap {run_credit_cap})."
        )
        print(f"credits this run: {run_credits}")
        print(f"credits this month ({month}): {spent_month} / {monthly_cap}")
        return 0
    run_cap = min(run_credit_cap, room)
    seed = load_seed()
    cache = load_cache()
    cards = cache["cards"]
    due = select_due(seed, cards, now, max_cards=run_card_cap, demand=load_demand())
    if not due:
        print(f"No cards due. Cache has {len(cards)} card(s); nothing was requested.")
        print(f"credits this run: {run_credits}")
        print(f"credits this month ({month}): {spent_month} / {monthly_cap}")
        if remaining is not None:
            print(f"account credits remaining: {remaining}")
        return 0
    phase = "backfill" if any(card_is_unfilled(cards.get(card_id) if isinstance(cards.get(card_id), dict) else {}, card_id) for card_id in due) else "steady"
    print(
        f"{phase}: up to {len(due)} card(s). "
        f"Per-run credit cap {run_cap}. Monthly cap {monthly_cap}. Store reserve {store_reserve}."
    )
    refreshed = 0
    card_credits = 0
    rate_limited = False
    try:
        for card_id in due:
            worst = max_card_credits(card_id)
            if card_credits + worst > run_cap or spent_month + worst > monthly_cap:
                print(f"Stopping before {card_id}. The next card could pass the credit cap.")
                break
            if remaining is not None and remaining - card_credits - worst < store_reserve:
                print(f"Stopping before {card_id}. The next card could drop the account under the store reserve.")
                break
            try:
                record, stop, credits = fetch_card(card_id, headers, now)
            except ScrydexError as exc:
                card_credits += exc.credits
                spent_month += exc.credits
                add_usage(usage, month, exc.credits, now)
                if str(exc) == "RATE_LIMIT":
                    rate_limited = True
                    print("Scrydex returned HTTP 429. Stopped so this run does not spend more credits.")
                    break
                raise
            card_credits += credits
            spent_month += credits
            add_usage(usage, month, credits, now)
            cards[card_id] = record
            refreshed += 1
            if record.get("missing"):
                print(f"  {card_id}: not found, credits={credits}")
            else:
                print(
                    f"  {card_id}: history={len(record['history'])} graded={len(record['graded'])} "
                    f"pop={len(record['pop'])} credits={credits}"
                )
            if stop:
                rate_limited = True
                print("Scrydex returned HTTP 429 on price history. The run stopped.")
                break
            time.sleep(REQUEST_PAUSE_SEC)
    finally:
        if refreshed:
            cache["source"] = "Scrydex"
            cache["generated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
            cache["history_days"] = HISTORY_DAYS
            cache["cards"] = cards
            write_cache(cache)
            print(f"Wrote {CACHE_PATH.name} ({refreshed} card(s) updated).")
        if card_credits or check_credits:
            write_usage(usage)
        run_credits += card_credits
        print(f"credits this run: {run_credits}")
        print(f"credits this month ({month}): {month_credits(usage, month)} / {monthly_cap}")
        if remaining is not None:
            print(f"account credits remaining at start of run: {remaining}")
    if rate_limited and not refreshed:
        raise ScrydexError(
            "Scrydex returned HTTP 429 before any card was saved. "
            "Wait and run the workflow again. No secret values were printed.",
            credits=card_credits,
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
