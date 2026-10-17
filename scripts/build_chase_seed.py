#!/usr/bin/env python3
"""Build data/scrydex-seed.txt from TCGdex prices.

Reads the public TCGdex catalog only. It does not call Scrydex and does not
use API keys. The top 300 priced physical chase cards are tier A (weekly).
The rest of the top 2,000 are tier B (monthly).
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED_PATH = ROOT / "data" / "scrydex-seed.txt"
API = "https://api.tcgdex.net/v2/en"
TIER_A = 300
LIMIT = 2000
POCKET_SET = re.compile(r"^(?:P-A|[AB]\d+[a-z]*)$")
POCKET_RARITIES = {
    "One Diamond",
    "Two Diamond",
    "Three Diamond",
    "Four Diamond",
    "One Star",
    "Two Star",
    "Three Star",
    "One Shiny",
    "Two Shiny",
    "Crown",
}
CHASE_RARITIES = [
    "Special illustration rare",
    "Illustration rare",
    "Hyper rare",
    "Mega Hyper Rare",
    "Secret Rare",
    "Shiny Ultra Rare",
    "Shiny rare VMAX",
    "Shiny rare V",
    "Shiny rare",
    "Holo Rare VMAX",
    "Holo Rare VSTAR",
    "Radiant Rare",
    "Amazing Rare",
    "Ultra Rare",
    "Full Art Trainer",
    "Rare Holo LV.X",
    "Rare PRIME",
    "LEGEND",
    "ACE SPEC Rare",
    "Holo Rare",
    "Rare Holo",
    "Classic Collection",
    "Double rare",
]
VINTAGE_RARITIES = ["Rare", "Holo Rare", "Rare Holo"]
VINTAGE_SERIES = {"base", "gym", "neo", "ecard", "lc", "pop", "ex"}


def get_json(url: str, attempts: int = 4):
    delay = 0.4
    for attempt in range(attempts):
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "BinderHunt-chase-seed"})
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)
            delay *= 2
    return None


def positive(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    number = float(value)
    if number != number or number <= 0 or number >= 99999:
        return 0.0
    return number


def quote_usd(card: dict) -> float:
    """Highest TCGplayer market price. Mid is used only when market is missing."""
    table = ((card.get("pricing") or {}).get("tcgplayer") or {})
    best = 0.0
    if not isinstance(table, dict):
        return 0.0
    for value in table.values():
        if not isinstance(value, dict):
            continue
        market = positive(value.get("marketPrice"))
        mid = positive(value.get("midPrice"))
        best = max(best, market or mid)
    return best


def quote_eur(card: dict) -> float:
    best = 0.0
    market = (card.get("pricing") or {}).get("cardmarket") or {}
    if isinstance(market, dict):
        for field in ("avg", "trend", "avg7", "avg30", "avg1"):
            best = max(best, positive(market.get(field)))
    for variant in card.get("variants_detailed") or []:
        if not isinstance(variant, dict):
            continue
        prices = (variant.get("pricing") or {}).get("cardmarket") or {}
        if isinstance(prices, dict):
            for field in ("avg", "trend", "avg7", "avg30", "avg1"):
                best = max(best, positive(prices.get(field)))
    return best


def set_id_of(card_id: str) -> str:
    return card_id.rsplit("-", 1)[0]


def load_sets() -> dict[str, dict]:
    briefs = get_json(f"{API}/sets")
    found = {}

    def one(brief: dict) -> tuple[str, dict]:
        set_id = brief["id"]
        try:
            full = get_json(f"{API}/sets/{urllib.parse.quote(set_id)}")
        except Exception:
            full = brief
        serie = full.get("serie") if isinstance(full, dict) else None
        serie_id = serie.get("id") if isinstance(serie, dict) else ""
        release = full.get("releaseDate") if isinstance(full, dict) else ""
        return set_id, {
            "name": (full.get("name") if isinstance(full, dict) else None) or brief.get("name") or set_id,
            "serie": serie_id or "",
            "release": release or "",
        }

    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(one, brief) for brief in briefs if brief.get("id")]
        for future in as_completed(futures):
            set_id, meta = future.result()
            found[set_id] = meta
    return found


def is_pocket(set_id: str, meta: dict, rarity: str) -> bool:
    if POCKET_SET.fullmatch(set_id or ""):
        return True
    if (meta.get("serie") or "") == "tcgp":
        return True
    if rarity in POCKET_RARITIES:
        return True
    return False


def is_vintage(meta: dict) -> bool:
    if (meta.get("serie") or "") in VINTAGE_SERIES:
        return True
    release = meta.get("release") or ""
    return len(release) >= 4 and release[:4].isdigit() and int(release[:4]) <= 2003


def load_ids(rarity: str) -> list[str]:
    url = f"{API}/cards?rarity=eq:{urllib.parse.quote(rarity)}"
    rows = get_json(url)
    if not isinstance(rows, list):
        return []
    return [row["id"] for row in rows if isinstance(row, dict) and row.get("id")]


def main() -> int:
    sets = load_sets()
    chosen: dict[str, str] = {}
    for rarity in CHASE_RARITIES:
        for card_id in load_ids(rarity):
            chosen.setdefault(card_id, rarity)
    for rarity in VINTAGE_RARITIES:
        for card_id in load_ids(rarity):
            meta = sets.get(set_id_of(card_id), {})
            if is_vintage(meta):
                chosen.setdefault(card_id, rarity)

    physical = {}
    for card_id, rarity in chosen.items():
        meta = sets.get(set_id_of(card_id), {})
        if is_pocket(set_id_of(card_id), meta, rarity):
            continue
        physical[card_id] = rarity

    priced = []

    def one(item: tuple[str, str]):
        card_id, rarity = item
        try:
            card = get_json(f"{API}/cards/{urllib.parse.quote(card_id, safe='')}")
        except Exception:
            return None
        if not isinstance(card, dict):
            return None
        actual_rarity = card.get("rarity") or rarity
        meta = sets.get(set_id_of(card_id), {})
        if is_pocket(set_id_of(card_id), meta, actual_rarity):
            return None
        usd = quote_usd(card)
        eur = quote_eur(card)
        if usd <= 0 and eur <= 0:
            return None
        return {
            "id": card_id,
            "name": card.get("name") or "",
            "rarity": actual_rarity,
            "usd": round(usd, 2),
            "eur": round(eur, 2),
            "score": round(usd if usd > 0 else eur, 2),
            "unit": "USD" if usd > 0 else "EUR",
        }

    items = list(physical.items())
    with ThreadPoolExecutor(max_workers=24) as pool:
        futures = [pool.submit(one, item) for item in items]
        done = 0
        for future in as_completed(futures):
            done += 1
            if done % 500 == 0:
                print(f"priced {done}/{len(items)}", flush=True)
            row = future.result()
            if row:
                priced.append(row)

    priced.sort(key=lambda row: (-row["score"], -row["usd"], row["id"]))
    top = priced[:LIMIT]
    lines = [
        "# Ranked physical chase cards for scripts/sync_scrydex.py.",
        "# Built from TCGdex TCGplayer market prices. Cardmarket EUR average is the",
        "# rank only when a card has no TCGplayer market price. EUR is not converted.",
        "# A is the top 300, refreshed weekly. B is the rest, refreshed monthly.",
        "# Cards outside this list are not fetched by the daily job.",
        f"# {len(top)} cards. Pocket and digital sets are excluded.",
        "",
    ]
    for index, row in enumerate(top):
        tier = "A" if index < TIER_A else "B"
        lines.append(
            f"{tier} {row['id']}  # {row['name']} · {row['rarity']} · {row['score']:.2f} {row['unit']}"
        )
    lines.append("")
    SEED_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {len(top)} cards to {SEED_PATH}")
    if top:
        print(f"top {top[0]['id']} {top[0]['score']:.2f}")
        print(f"tier A floor {top[min(TIER_A, len(top)) - 1]['id']} {top[min(TIER_A, len(top)) - 1]['score']:.2f}")
        print(f"tier B floor {top[-1]['id']} {top[-1]['score']:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
