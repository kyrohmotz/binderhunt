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

HTTP 402 on a card lookup, on price history, or on /account/v1/usage
is a hard stop. Credits already spent are recorded, cards refreshed
earlier in the run are written, and the process exits nonzero. The
workflow commits those files and the job stays red. The annotation is:

  Scrydex returned 402 Payment Required; check the shared Scrydex account.

A 5xx on one card is skipped. No record is written for that id, and the
credits still count. Three 5xx responses in a row stop the loop and the
process exits nonzero, after the partial cache and ledger are written.
The account usage read must establish the store reserve. Anything other
than HTTP 200 with a remaining-credit field fails the run before any
card request. That includes an empty body, JSON null, a non-object,
and every status other than 200. There is no fallback to the local
ledger. The usage read is recorded as 1 credit. HTTP 401 and 403 still
abort the run. HTTP 429 on a card still stops that run.
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
# A 5xx skips that card. This many in a row stops the loop and fails the
# job, so an outage does not walk the rest of the due list. HTTP 402 is
# not a skip: the first one stops the run.
SKIP_STREAK_LIMIT = 3
# Provider code/message copied out of a 402 or 5xx body. Headers are never
# included. Secrets in the text are redacted before this cap is applied.
PROVIDER_DETAIL_LIMIT = 200
PAYMENT_REQUIRED_MESSAGE = (
    "Scrydex returned 402 Payment Required; check the shared Scrydex account."
)
# TCGdex zero-pads set numbers and writes special sets as ".5".
# Scrydex uses the Pokémon TCG API form: sv03 -> sv3, sv03.5 -> sv3pt5, me02 -> me2.
_SET_RE = re.compile(r"^([a-z]+)(\d+)(\.5)?$")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ScrydexError(Exception):
    def __init__(self, message: str, credits: int = 0):
        super().__init__(message)
        self.credits = credits


class PaymentRequired(ScrydexError):
    """HTTP 402 on the shared Scrydex account. The run must fail."""

    def __init__(self, stage: str, detail: str = "", credits: int = 0, card_id: str | None = None):
        self.stage = stage
        self.detail = detail
        self.card_id = card_id
        self.status = 402
        super().__init__(PAYMENT_REQUIRED_MESSAGE, credits=credits)


class CardSkip(ScrydexError):
    """One card failed with a 5xx the rest of the run can skip."""

    def __init__(self, card_id: str, status: int, credits: int = 0, stage: str = "", detail: str = ""):
        self.card_id = card_id
        self.status = status
        self.stage = stage
        self.detail = detail
        message = f"{card_id}: skipped HTTP {status}, credits={credits}"
        if stage:
            message += f", stage={stage}"
        if detail:
            message += f", provider={detail}"
        super().__init__(message, credits=credits)


def skippable_status(status: int) -> bool:
    """Transient 5xx skips one card. 402, auth, and rate-limit stay hard."""
    return 500 <= status <= 599


def _plain_text(value) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return ""


def extract_provider_error(body, depth: int = 0) -> tuple[str, str]:
    """Return (code, message) from a JSON error body. Ignores every other field."""
    if depth > 4:
        return "", ""
    if isinstance(body, str):
        return "", body.strip()
    if not isinstance(body, dict):
        return "", ""
    code = ""
    for key in ("code", "error_code", "errorCode", "type"):
        found = _plain_text(body.get(key))
        if found:
            code = found
            break
    message = ""
    for key in ("message", "error", "detail", "title", "description"):
        value = body.get(key)
        if isinstance(value, dict):
            nested_code, nested_message = extract_provider_error(value, depth + 1)
            if nested_code or nested_message:
                message = nested_message
                if not code:
                    code = nested_code
                break
            continue
        found = _plain_text(value)
        if found:
            message = found
            break
    if not code and not message:
        nested = body.get("data")
        if isinstance(nested, dict):
            return extract_provider_error(nested, depth + 1)
    return code, message


def _redact_secrets(text: str) -> str:
    for name in ("SCRYDEX_API_KEY", "SCRYDEX_TEAM_ID"):
        secret = os.environ.get(name, "").strip()
        if len(secret) < 6 or secret not in text:
            continue
        text = text.replace(secret, "[redacted]")
    text = re.sub(
        r"(?i)\b(x-api-key|x-team-id|authorization|api[-_ ]?key|bearer)\b\s*[:=]?\s*\S+",
        r"\1 [redacted]",
        text,
    )
    return text


def sanitize_provider_detail(body) -> str:
    """Short code and message from a provider body. At most 200 characters.

    Only error code/message fields are read. Headers are not accepted.
    Secret values and header-like tokens are redacted before the cap.
    """
    code, message = extract_provider_error(body)
    code = re.sub(r"\s+", " ", "".join(char if char.isprintable() else " " for char in code)).strip()
    message = re.sub(r"\s+", " ", "".join(char if char.isprintable() else " " for char in message)).strip()
    parts = []
    if code:
        parts.append(f"code={code}")
    if message and message != code:
        parts.append(f"message={message}")
    text = _redact_secrets(" ".join(parts)).strip()
    if len(text) > PROVIDER_DETAIL_LIMIT:
        text = text[:PROVIDER_DETAIL_LIMIT].rstrip()
    return text


def announce_provider_failure(stage: str, status: int, body, card_id: str | None = None) -> str:
    """Log the endpoint stage and a bounded provider detail. Return the detail."""
    detail = sanitize_provider_detail(body)
    subject = f"{stage} for {card_id}" if card_id else stage
    suffix = detail if detail else "no provider error message"
    print(f"Scrydex HTTP {status} on {subject}: {suffix}")
    return detail


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

    HTTP 402 raises PaymentRequired. Credits already spent are on the
    exception, and no record is returned. The caller stops the run.
    A 5xx raises CardSkip. HTTP 401 and 403 still raise ScrydexError.
    HTTP 429 raises RATE_LIMIT on lookup, or returns stop on price history.
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
        if status == 402:
            detail = announce_provider_failure("card lookup", status, body, card_id)
            raise PaymentRequired("card lookup", detail=detail, credits=credits, card_id=card_id)
        if skippable_status(status):
            detail = announce_provider_failure("card lookup", status, body, card_id)
            raise CardSkip(card_id, status, credits, stage="card lookup", detail=detail)
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
    if h_status == 402:
        detail = announce_provider_failure("price history", h_status, history_payload, card_id)
        raise PaymentRequired("price history", detail=detail, credits=credits, card_id=card_id)
    if skippable_status(h_status):
        detail = announce_provider_failure("price history", h_status, history_payload, card_id)
        raise CardSkip(card_id, h_status, credits, stage="price history", detail=detail)
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


def _usage_unreadable(status: int, body, why: str) -> None:
    """Fail closed on a non-200 usage response. The call costs 1 credit."""
    detail = announce_provider_failure("account usage", status, body)
    extra = f" ({detail})" if detail else ""
    raise ScrydexError(
        f"Scrydex account usage returned HTTP {status}{extra}. {why}",
        credits=1,
    )


def read_account_remaining(headers: dict) -> tuple[int, int]:
    """Return (credits left, cost of this read).

    Only HTTP 200 with an object that includes a remaining-credit field
    establishes the store reserve. Every other response raises. The caller
    must not request any cards. There is no local-ledger fallback.
    A response costs 1 credit.
    """
    status, body = request_json(USAGE_API, headers)
    if status in (401, 403):
        raise ScrydexError(
            f"Scrydex rejected the credentials (HTTP {status}) on account usage. "
            "Check SCRYDEX_API_KEY and SCRYDEX_TEAM_ID. The secret values were not printed.",
            credits=1,
        )
    if status == 402:
        detail = announce_provider_failure("account usage", status, body)
        raise PaymentRequired("account usage", detail=detail, credits=1)
    refused = "The store reserve could not be read, so no cards were requested."
    if status != 200:
        _usage_unreadable(status, body, refused)
    if not isinstance(body, dict):
        raise ScrydexError(
            "Scrydex account usage returned HTTP 200 without a remaining-credit object. "
            + refused,
            credits=1,
        )
    remaining = remaining_credits(body)
    if remaining is None:
        keys = ",".join(sorted(str(key)[:40] for key in list(body.keys())[:20]))[:200]
        raise ScrydexError(
            "Scrydex account usage did not include a remaining-credit field "
            f"({keys}). {refused}",
            credits=1,
        )
    return remaining, 1


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
        remaining, check_credits = read_account_remaining(headers)
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
    skip_streak = 0
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
                if isinstance(exc, CardSkip):
                    skip_streak += 1
                    print(f"  {exc}")
                    if skip_streak >= SKIP_STREAK_LIMIT:
                        raise ScrydexError(
                            f"Scrydex returned HTTP {exc.status} on {skip_streak} cards in a row "
                            f"(last card {exc.card_id}, stage {exc.stage or 'card'}). "
                            "Stopped so this run does not keep requesting. "
                            "Cards refreshed earlier in this run are kept."
                        ) from None
                    time.sleep(REQUEST_PAUSE_SEC)
                    continue
                if str(exc) == "RATE_LIMIT":
                    rate_limited = True
                    print("Scrydex returned HTTP 429. Stopped so this run does not spend more credits.")
                    break
                raise
            skip_streak = 0
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
