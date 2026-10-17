#!/usr/bin/env python3
"""Demand proxy for BinderHunt price coverage.

POST /demand records a catalog id. GET /price serves a row already in
data/scrydex.json. Neither path calls Scrydex.

A live lookup exists only when the environment variable SCRYDEX_ALLOW_SPEND
is exactly "1". This repository does not set that variable. Secrets, when a
future host does allow a spend, are read from SCRYDEX_API_KEY and
SCRYDEX_TEAM_ID and are never printed or written into the demand file.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import plan_price_coverage as plan

ROOT = Path(__file__).resolve().parents[1]
DEMAND_PATH = ROOT / "data" / "price-demand.json"
CACHE_PATH = ROOT / "data" / "scrydex.json"
MAX_DEMAND_IDS = 4000
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_LOCK = threading.Lock()


def spend_enabled() -> bool:
    return os.environ.get("SCRYDEX_ALLOW_SPEND", "") == "1"


def valid_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    card_id = value.strip()
    if not ID_RE.fullmatch(card_id):
        return None
    return card_id


def load_demand(path: Path | None = None) -> dict:
    target = path or DEMAND_PATH
    try:
        parsed = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"counts": {}}
    counts = parsed.get("counts") if isinstance(parsed, dict) else None
    if not isinstance(counts, dict):
        return {"counts": {}}
    clean = {}
    for key, value in counts.items():
        card_id = valid_id(key)
        if card_id is None:
            continue
        try:
            clean[card_id] = max(0, int(value))
        except (TypeError, ValueError):
            continue
    return {"counts": clean}


def record_demand(card_id: str, path: Path | None = None) -> int:
    target = path or DEMAND_PATH
    with _LOCK:
        data = load_demand(target)
        counts = data["counts"]
        counts[card_id] = counts.get(card_id, 0) + 1
        if len(counts) > MAX_DEMAND_IDS:
            ranked = plan.rank_demand(counts, MAX_DEMAND_IDS)
            counts = {key: counts[key] for key in ranked}
        payload = {
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "counts": counts,
        }
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(target)
        return counts[card_id]


def cached_record(card_id: str, path: Path | None = None) -> dict | None:
    target = path or CACHE_PATH
    try:
        parsed = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    cards = parsed.get("cards") if isinstance(parsed, dict) else None
    if not isinstance(cards, dict):
        return None
    record = cards.get(card_id)
    if not isinstance(record, dict) or record.get("missing"):
        return None
    graded = record.get("graded") if isinstance(record.get("graded"), list) else []
    history = record.get("history") if isinstance(record.get("history"), list) else []
    if not graded and not history:
        return None
    return record


def live_fetch(card_id: str) -> dict:
    """Reach Scrydex. Callers must check spend_enabled() first."""
    import sync_scrydex

    key, team = sync_scrydex.require_secrets()
    headers = {"X-Api-Key": key, "X-Team-ID": team}
    record, _stop, _credits = sync_scrydex.fetch_card(card_id, headers, datetime.now(timezone.utc))
    return record


class Handler(BaseHTTPRequestHandler):
    demand_path = None
    cache_path = None

    def log_message(self, fmt: str, *args) -> None:
        return

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _card_id(self) -> str | None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        from_query = valid_id(query["id"][0]) if query.get("id") else None
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 4096:
            return from_query
        raw = self.rfile.read(length)
        if from_query:
            return from_query
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if isinstance(payload, dict):
            return valid_id(payload.get("id"))
        return None

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/plan":
            self._send(200, plan.estimate())
            return
        if path != "/price":
            self._send(404, {"ok": False, "error": "not found"})
            return
        card_id = self._card_id()
        if not card_id:
            self._send(400, {"ok": False, "error": "missing id"})
            return
        record = cached_record(card_id, self.cache_path)
        if record is not None:
            self._send(200, {"ok": True, "source": "cache", "id": card_id, "card": record})
            return
        if not spend_enabled():
            self._send(
                503,
                {
                    "ok": False,
                    "live": False,
                    "id": card_id,
                    "error": "Live Scrydex fetch is off. Set SCRYDEX_ALLOW_SPEND=1 on the proxy host to spend credits. No request was made.",
                    "plan": plan.estimate(),
                },
            )
            return
        try:
            fetched = live_fetch(card_id)
        except Exception as exc:
            message = str(exc)
            self._send(502, {"ok": False, "live": True, "id": card_id, "error": message})
            return
        self._send(200, {"ok": True, "source": "scrydex", "id": card_id, "card": fetched})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/demand":
            self._send(404, {"ok": False, "error": "not found"})
            return
        card_id = self._card_id()
        if not card_id:
            self._send(400, {"ok": False, "error": "missing id"})
            return
        count = record_demand(card_id, self.demand_path)
        self._send(202, {"ok": True, "id": card_id, "count": count, "live": False})


def serve(host: str = "127.0.0.1", port: int = 8787) -> None:
    server = ThreadingHTTPServer((host, port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    serve()
