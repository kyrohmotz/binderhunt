#!/usr/bin/env python3
"""Build data/daily.json, a year of Daily Drop cards.

Reads the public TCGdex catalog and the committed Scrydex cache. It does not
call Scrydex and does not use an API key. A card is kept only when TCGdex has
a TCGplayer market price, the same number the profile shows for its cheapest
printing. Cardmarket trend is not a price. America/New_York dates are assigned
in order, so the file is the puzzle: the site does not re-roll a day that is
already scheduled.

The committed price is a fallback for when the live card cannot be loaded.
Playing the drop asks TCGdex again and locks that answer on the first guess.

    python3 scripts/build_daily.py           # new year from today
    python3 scripts/build_daily.py --extend  # append days once fewer than 60 remain
"""

from __future__ import annotations

import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "daily.json"
SCRYDEX = ROOT / "data" / "scrydex.json"
FX = ROOT / "data" / "fx.json"
API = "https://api.tcgdex.net/v2/en"
DAYS = 400
POOL_FLOOR = 1.0
POOL_CAP = 20000.0
FX_FALLBACK = 1.1253
POCKET_SET = re.compile(r"^(?:P-A|[AB]\d+[a-z]*)$")
POCKET_RARITIES = {
    "One Diamond", "Two Diamond", "Three Diamond", "Four Diamond",
    "One Star", "Two Star", "Three Star", "One Shiny", "Two Shiny", "Crown",
}
IMAGELESS = {
    "2011bw", "2012bw", "2014xy", "2015xy", "2016xy", "2017sm", "2018sm",
    "2019sm", "2021swsh", "2022swsh", "2023sv", "2024sv", "30th-c", "bog",
    "cel25cc", "ex5.5", "exu", "jumbo", "mee", "mep", "mfb", "miscp", "rc",
    "sm3.5", "sm7.5", "sp", "sve", "swsh10tg", "swsh11tg", "swsh12.5gg",
    "swsh12tg", "swsh4.5sv", "swsh9tg", "tk-bw-e", "tk-bw-z", "tk-dp-l",
    "tk-dp-m", "tk-ex-latia", "tk-ex-latio", "tk-ex-m", "tk-ex-p", "tk-hs-g",
    "tk-hs-r", "tk-sm-l", "tk-sm-r", "tk-xy-b", "tk-xy-latia", "tk-xy-latio",
    "tk-xy-n", "tk-xy-p", "tk-xy-su", "tk-xy-sy", "tk-xy-w", "wp", "xya",
}
TAKE_ALL = [
    "Rare Holo",
    "Rare Holo LV.X",
    "Rare PRIME",
    "LEGEND",
    "Amazing Rare",
    "Radiant Rare",
    "ACE SPEC Rare",
    "Classic Collection",
]
TAKE_SAMPLE = {
    "Holo Rare": 220,
    "Illustration rare": 48,
    "Special illustration rare": 16,
    "Hyper rare": 12,
    "Secret Rare": 24,
    "Shiny rare": 16,
    "Shiny Ultra Rare": 10,
    "Double rare": 20,
}
# Mid-era holos are mostly filed as Ultra Rare. Take them per era so the
# year is not only vintage holos and modern illustration rares.
ULTRA_BY_ERA = {
    "Black & White": 28,
    "XY": 28,
    "Sun & Moon": 28,
    "Sword & Shield": 16,
    "Scarlet & Violet": 12,
    "Mega Evolution": 8,
    "EX": 8,
}
GEM_SETS = {"ecard2", "ecard3"}
ECARD_SETS = ("ecard1", "ecard2", "ecard3")
GRADE_SLOTS = (("PSA", "10"), ("PSA", "9"), ("CGC", "10"), ("BGS", "9.5"))
BUCKETS = ("wotc", "swsh", "ex", "sv", "dp", "sm", "bw", "xy", "other")


def get_json(url: str, attempts: int = 4):
    delay = 0.35
    last = None
    for attempt in range(attempts):
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "BinderHunt-daily"})
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:
            last = error
            if attempt == attempts - 1:
                break
            time.sleep(delay)
            delay *= 2
    raise last


def positive(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    number = float(value)
    if number != number or number <= 0 or number >= 99999:
        return 0.0
    return number


def set_id_of(card_id: str) -> str:
    return card_id.rsplit("-", 1)[0]


def era_of(set_id: str) -> str:
    text = set_id or ""
    if text.startswith("me"):
        return "Mega Evolution"
    if text.startswith("sv"):
        return "Scarlet & Violet"
    if text.startswith("swsh"):
        return "Sword & Shield"
    if text.startswith("sm"):
        return "Sun & Moon"
    if text.startswith("xy"):
        return "XY"
    if text.startswith("bw"):
        return "Black & White"
    if text.startswith("hgss") or text.startswith("col"):
        return "HeartGold & SoulSilver"
    if text.startswith("dp") or text.startswith("pl"):
        return "Diamond & Pearl"
    if text.startswith("ex"):
        return "EX"
    if re.match(r"^(base|gym|neo|ecard|pop|np|si|lc)", text):
        return "WOTC"
    return "Other"


def bucket_of(era: str) -> str:
    return {
        "WOTC": "wotc",
        "EX": "ex",
        "Diamond & Pearl": "dp",
        "HeartGold & SoulSilver": "dp",
        "Black & White": "bw",
        "XY": "xy",
        "Sun & Moon": "sm",
        "Sword & Shield": "swsh",
        "Scarlet & Violet": "sv",
        "Mega Evolution": "sv",
    }.get(era, "other")


def pocket(set_id: str, rarity: str) -> bool:
    if POCKET_SET.fullmatch(set_id or ""):
        return True
    if rarity in POCKET_RARITIES:
        return True
    return False


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def flags(name: str) -> dict:
    raw = norm(name)
    return {
        "raw": raw,
        "first": "firstedition" in raw or "1stedition" in raw,
        "shadowless": "shadowless" in raw,
        "reverse": "reverse" in raw,
        "unlimited": "unlimited" in raw,
        "holo": "holo" in raw,
    }


def printing_match(label: str, key: str) -> bool:
    left, right = flags(label), flags(key)
    if left["first"] != right["first"]:
        return False
    if left["shadowless"] != right["shadowless"]:
        return False
    if left["reverse"] != right["reverse"]:
        return False
    if left["holo"] != right["holo"]:
        return False
    return True


def variant_label(key: str) -> str:
    if key == "cardmarket":
        return "Cardmarket average"
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", key or "")
    text = text.replace("-", " ").replace("_", " ")
    return " ".join(part.capitalize() for part in text.split()) or "Raw"


SPECIES_SKIP = {
    "dark", "light", "shining", "shiny", "team", "rocket", "rockets",
    "radiant", "amazing", "galarian", "alolan", "hisuian", "paldean",
    "the", "an", "ex", "gx", "v", "vmax", "vstar",
}


def species_of(name: str) -> str:
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", name or "")
    kept = []
    for word in words:
        token = word.lower().replace("'s", "").replace("’s", "")
        if token in SPECIES_SKIP or len(token) <= 1:
            continue
        kept.append(word)
    return kept[-1].lower() if kept else ""


def choose_price(card: dict):
    """Cheapest TCGplayer market, matching the profile's default printing."""
    table = ((card.get("pricing") or {}).get("tcgplayer") or {})
    options = []
    if isinstance(table, dict):
        for key, value in table.items():
            if not isinstance(value, dict) or key in {"updated", "unit"}:
                continue
            market = positive(value.get("marketPrice"))
            if market:
                options.append((key, market))
    if not options:
        return None
    options.sort(key=lambda item: (item[1], item[0]))
    key, price = options[0]
    return round(price, 2), key, len(options)


def trend_points(card: dict):
    market = (card.get("pricing") or {}).get("cardmarket") or {}
    if not isinstance(market, dict):
        return []
    points = []
    for label, field in (("30-day avg", "avg30"), ("7-day avg", "avg7"), ("1-day avg", "avg1")):
        value = positive(market.get(field))
        if not value:
            continue
        points.append({"label": label, "eur": round(value, 2)})
    return points


def quote_eur(card: dict) -> float:
    """First Cardmarket average, matching the profile. Never trend or avg7/30/1."""
    detailed = card.get("variants_detailed") or []
    if isinstance(detailed, list):
        for variant in detailed:
            if not isinstance(variant, dict):
                continue
            market = ((variant.get("pricing") or {}).get("cardmarket") or {})
            if isinstance(market, dict):
                avg = positive(market.get("avg"))
                if avg:
                    return round(avg, 2)
    market = ((card.get("pricing") or {}).get("cardmarket") or {})
    if isinstance(market, dict):
        avg = positive(market.get("avg"))
        if avg:
            return round(avg, 2)
    return 0.0


def score_of(row: dict) -> float:
    price = row["price"]
    if 8 <= price <= 40:
        band = 34
    elif 3 <= price < 8:
        band = 26
    elif 40 < price <= 120:
        band = 24
    elif 120 < price <= 400:
        band = 14
    elif 1 <= price < 3:
        band = 12
    else:
        band = 6
    rarity = row["rarity"]
    rarity_bonus = 10
    if rarity in {"Rare Holo", "Holo Rare"}:
        rarity_bonus = 24
    elif rarity == "Rare" and row["setId"] in GEM_SETS:
        rarity_bonus = 22
    elif rarity in {"Rare Holo LV.X", "Rare PRIME", "LEGEND", "Amazing Rare", "Radiant Rare"}:
        rarity_bonus = 18
    elif "Illustration" in rarity or rarity in {"Ultra Rare", "Double rare", "Shiny rare"}:
        rarity_bonus = 12
    gem = 16 if row["setId"] in GEM_SETS else 0
    cached = 4 if row.get("grades") or row.get("history") else 0
    chart = 8 if row.get("trend") or row.get("history") else 0
    return band + rarity_bonus + gem + cached + chart


def spread_sample(briefs: list[dict], limit: int, seed: str) -> list[dict]:
    rng = random.Random(seed)
    groups = defaultdict(list)
    for card in briefs:
        if not isinstance(card, dict) or not card.get("id") or not card.get("image"):
            continue
        groups[set_id_of(card["id"])].append(card)
    for key in sorted(groups):
        groups[key].sort(key=lambda card: card["id"])
        rng.shuffle(groups[key])
    keys = sorted(groups)
    rng.shuffle(keys)
    picked = []
    while keys and len(picked) < limit:
        nxt = []
        for key in keys:
            bag = groups[key]
            if not bag:
                continue
            picked.append(bag.pop())
            if bag:
                nxt.append(key)
            if len(picked) >= limit:
                break
        keys = nxt
    return picked


def weave(cards: list[dict]) -> list[dict]:
    bands = {"low": [], "mid": [], "high": [], "spice": []}
    for card in cards:
        price = card["price"]
        if price < 8:
            bands["low"].append(card)
        elif price < 40:
            bands["mid"].append(card)
        elif price < 150:
            bands["high"].append(card)
        else:
            bands["spice"].append(card)
    for name in bands:
        bands[name].sort(key=lambda card: (-card["score"], card["id"]))
    order = ["mid", "low", "high", "mid", "spice", "low", "mid", "high"]
    out = []
    while any(bands.values()):
        for name in order:
            if bands[name]:
                out.append(bands[name].pop(0))
    return out


def pop_named(queue: list[dict], previous: str):
    if not queue:
        return None
    previous = (previous or "").lower()

    def take(require_chart: bool):
        for index, card in enumerate(queue):
            if card["name"].lower() == previous:
                continue
            if require_chart and not (card.get("trend") or card.get("history")):
                continue
            return queue.pop(index)
        return None

    return take(True) or take(False) or queue.pop(0)


def load_fx() -> float:
    try:
        raw = json.loads(FX.read_text(encoding="utf-8"))
        rate = positive(raw.get("eurUsd"))
        if 0.2 < rate < 5:
            return rate
    except Exception:
        pass
    return FX_FALLBACK


def attach_scrydex(row: dict, cache: dict):
    rec = cache.get(row["id"])
    if not isinstance(rec, dict) or rec.get("missing"):
        return
    key = row["variant"]
    names = []
    for collection in ("graded", "history"):
        for item in rec.get(collection) or []:
            if isinstance(item, dict) and item.get("variant") and item["variant"] not in names:
                names.append(item["variant"])
            if isinstance(item, dict) and item.get("v") and item["v"] not in names:
                names.append(item["v"])
    matches = [name for name in names if printing_match(name, key)]
    if not matches:
        return
    exact = next((name for name in matches if flags(name)["raw"] == flags(key)["raw"]), None)
    unlimited = next((name for name in matches if flags(name)["unlimited"]), None)
    chosen = exact or unlimited or matches[0]
    grades = []
    for company, grade in GRADE_SLOTS:
        for item in rec.get("graded") or []:
            if not isinstance(item, dict):
                continue
            if item.get("variant") != chosen or item.get("company") != company:
                continue
            if str(item.get("grade")) != grade:
                continue
            market = positive(item.get("market"))
            if market:
                grades.append({"company": company, "grade": grade, "market": round(market, 2)})
                break
    history = []
    for item in rec.get("history") or []:
        if not isinstance(item, dict) or item.get("v") != chosen:
            continue
        market = positive(item.get("m"))
        day = str(item.get("d") or "")
        if market and re.match(r"^\d{4}[/-]\d{2}[/-]\d{2}$", day):
            history.append((day.replace("/", "-")[:10], round(market, 2)))
    history.sort()
    dedup = []
    for day, market in history:
        if dedup and dedup[-1][0] == day:
            dedup[-1] = (day, market)
        else:
            dedup.append((day, market))
    if len(dedup) > 16:
        last = len(dedup) - 1
        indexes = []
        for step in range(16):
            indexes.append(round(step * last / 15))
        slim = []
        for index in indexes:
            if not slim or slim[-1] != dedup[index]:
                slim.append(dedup[index])
        dedup = slim
    if grades:
        row["grades"] = grades
    if len(dedup) >= 2:
        row["history"] = [{"d": day, "m": market} for day, market in dedup]


def schedule(rows: list[dict], limit: int, recent=None, ecard: int = 0, ecard_cap: int | None = None, used=None) -> tuple[list[str], list[str], int]:
    buckets = defaultdict(list)
    for row in rows:
        if used and row["id"] in used:
            continue
        buckets[row["bucket"]].append(row)
    queues = {name: weave(cards) for name, cards in buckets.items()}
    gems = weave([card for card in queues.get("wotc", []) if card.get("gem")])
    plain = weave([card for card in queues.get("wotc", []) if not card.get("gem")])
    queues["wotc"] = plain
    queues["gem"] = gems
    days = []
    seen = set(used or [])
    history = list(recent or [])
    turns = 0
    window = 30
    cap = ecard_cap if ecard_cap is not None else max(1, int(limit * 0.08))
    guard = 0
    ecard_ids = {row["id"] for row in rows if str(row.get("setId") or "").startswith("ecard")}

    def fits(card: dict) -> bool:
        if card["id"] in seen or card["price"] < POOL_FLOOR:
            return False
        species = card.get("species") or ""
        if species and species in history[-window:]:
            return False
        if card["id"] in ecard_ids and ecard + sum(1 for card_id in days if card_id in ecard_ids) >= cap:
            return False
        return True

    def pop_from(queue: list[dict]):
        for index, card in enumerate(queue):
            if fits(card):
                return queue.pop(index)
        return None

    while len(days) < limit and guard < limit * 8:
        guard += 1
        placed = False
        for name in BUCKETS:
            key = name
            if name == "wotc":
                turns += 1
                key = "gem" if turns % 2 == 0 and queues.get("gem") else "wotc"
                if not queues.get(key):
                    key = "gem" if key == "wotc" else "wotc"
            card = pop_from(queues.get(key) or [])
            if not card:
                continue
            seen.add(card["id"])
            days.append(card["id"])
            if card.get("species"):
                history.append(card["species"])
            placed = True
            if len(days) >= limit:
                break
        if not placed:
            break
    placed_ecard = ecard + sum(1 for card_id in days if card_id in ecard_ids)
    return days, history, placed_ecard


def brief_lists() -> dict[str, dict]:
    chosen = {}

    def remember(card: dict):
        if not isinstance(card, dict) or not card.get("id") or not card.get("image"):
            return
        sid = set_id_of(card["id"])
        if sid in IMAGELESS or pocket(sid, ""):
            return
        chosen.setdefault(card["id"], card)

    for rarity in TAKE_ALL:
        try:
            rows = get_json(API + "/cards?rarity=eq:" + urllib.parse.quote(rarity))
        except Exception as error:
            print(f"skip rarity {rarity}: {error}", flush=True)
            continue
        if isinstance(rows, list):
            for card in rows:
                remember(card)
        print(f"rarity {rarity}: pool {len(chosen)}", flush=True)

    try:
        ultra = get_json(API + "/cards?rarity=eq:" + urllib.parse.quote("Ultra Rare"))
    except Exception as error:
        ultra = []
        print(f"skip rarity Ultra Rare: {error}", flush=True)
    if isinstance(ultra, list):
        grouped = defaultdict(list)
        for card in ultra:
            if isinstance(card, dict) and card.get("id"):
                grouped[era_of(set_id_of(card["id"]))].append(card)
        for era, limit in ULTRA_BY_ERA.items():
            for card in spread_sample(grouped.get(era, []), limit, "binderhunt-daily-ultra-" + era):
                remember(card)
        print(f"sample Ultra Rare: pool {len(chosen)}", flush=True)

    for rarity, limit in TAKE_SAMPLE.items():
        try:
            rows = get_json(API + "/cards?rarity=eq:" + urllib.parse.quote(rarity))
        except Exception as error:
            print(f"skip rarity {rarity}: {error}", flush=True)
            continue
        if not isinstance(rows, list):
            continue
        for card in spread_sample(rows, limit, "binderhunt-daily-" + rarity):
            remember(card)
        print(f"sample {rarity}: pool {len(chosen)}", flush=True)

    for sid in ECARD_SETS:
        try:
            payload = get_json(f"{API}/sets/{sid}")
        except Exception as error:
            print(f"skip set {sid}: {error}", flush=True)
            continue
        cards = payload.get("cards") if isinstance(payload, dict) else None
        if isinstance(cards, list):
            for card in cards:
                remember(card)
        print(f"set {sid}: pool {len(chosen)}", flush=True)
    return chosen


def build_row(card_id: str, cache: dict):
    try:
        card = get_json(f"{API}/cards/{urllib.parse.quote(card_id, safe='')}")
    except Exception:
        return None
    if not isinstance(card, dict):
        return None
    rarity = card.get("rarity") or ""
    sid = ((card.get("set") or {}).get("id")) or set_id_of(card_id)
    if pocket(sid, rarity) or sid in IMAGELESS:
        return None
    if card.get("category") == "Energy":
        return None
    image = card.get("image") or ""
    if not str(image).startswith("https://assets.tcgdex.net/"):
        return None
    if sid in {"ecard1", "ecard2", "ecard3"} and rarity not in {"Rare", "Rare Holo", "Holo Rare"} and "Holo" not in rarity:
        return None
    quoted = choose_price(card)
    if not quoted:
        return None
    price, variant, alts = quoted
    if price < POOL_FLOOR or price >= POOL_CAP:
        return None
    era = era_of(sid)
    types = [item for item in (card.get("types") or []) if isinstance(item, str)]
    row = {
        "id": card_id,
        "name": card.get("name") or card_id,
        "set": ((card.get("set") or {}).get("name")) or sid,
        "setId": sid,
        "num": str(card.get("localId") or ""),
        "rarity": rarity or "—",
        "era": era,
        "bucket": bucket_of(era),
        "image": image,
        "price": price,
        "variant": variant,
        "printing": variant_label(variant),
        "source": "tcgplayer",
        "alts": alts,
        "types": types,
        "species": species_of(card.get("name") or ""),
        "gem": sid in GEM_SETS,
    }
    eur = quote_eur(card)
    if eur:
        row["eur"] = eur
    points = trend_points(card)
    if len(points) >= 2:
        row["trend"] = points
    attach_scrydex(row, cache)
    row["score"] = score_of(row)
    return row


def public_card(row: dict) -> dict:
    out = {
        "id": row["id"],
        "name": row["name"],
        "set": row["set"],
        "setId": row["setId"],
        "num": row["num"],
        "rarity": row["rarity"],
        "era": row["era"],
        "image": row["image"],
        "price": row["price"],
        "variant": row["variant"],
        "printing": row["printing"],
        "source": row["source"],
        "alts": row.get("alts") or 1,
        "types": row.get("types") or [],
    }
    if row.get("eur"):
        out["eur"] = row["eur"]
    if row.get("grades"):
        out["grades"] = row["grades"]
    if row.get("history"):
        out["history"] = row["history"]
    if row.get("trend"):
        out["trend"] = row["trend"]
    return out


def ny_today() -> str:
    return datetime.now(ZoneInfo("America/New_York")).date().isoformat()


def add_iso(iso: str, delta: int) -> str:
    year, month, day = (int(part) for part in iso.split("-"))
    return (datetime(year, month, day) + timedelta(days=delta)).date().isoformat()


def days_between(start: str, end: str) -> int:
    return (datetime.fromisoformat(end) - datetime.fromisoformat(start)).days


def load_cache() -> dict:
    try:
        payload = json.loads(SCRYDEX.read_text(encoding="utf-8"))
        return payload.get("cards") or {}
    except Exception as error:
        print(f"scrydex cache unread: {error}", flush=True)
        return {}


def fetch_rows(cache: dict) -> list[dict]:
    briefs = brief_lists()
    print(f"fetching {len(briefs)} cards", flush=True)
    rows = []
    done = 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(build_row, card_id, cache) for card_id in briefs]
        for future in as_completed(futures):
            done += 1
            if done % 100 == 0:
                print(f"priced {done}/{len(briefs)} kept {len(rows)}", flush=True)
            row = future.result()
            if row:
                rows.append(row)
    print(f"kept {len(rows)}", flush=True)
    return rows


def write_doc(epoch: str, days: list[str], pool: list[dict]) -> None:
    today = ny_today()
    document = {
        "v": 1,
        "tz": "America/New_York",
        "epoch": epoch,
        "generated": today,
        "days": days,
        "pool": pool,
    }
    OUT.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    eras = sorted({card["era"] for card in pool})
    gems = sum(1 for card in pool if card.get("setId") in GEM_SETS)
    ecards = sum(1 for card in pool if str(card.get("setId") or "").startswith("ecard"))
    graded = sum(1 for card in pool if card.get("grades"))
    under = sum(1 for card in pool if card["price"] < 50)
    print(f"wrote {len(days)} days from {epoch}")
    print(f"eras {eras}")
    print(f"gems {gems} ecard {ecards} graded {graded} under50 {under}")
    print(f"day1 {pool[0]['id']} {pool[0]['name']} {pool[0]['price']} {pool[0]['printing']}")


def main() -> int:
    extend = "--extend" in sys.argv
    today = ny_today()
    old = None
    if extend and OUT.exists():
        old = json.loads(OUT.read_text(encoding="utf-8"))
        epoch = old.get("epoch") or today
        existing = list(old.get("days") or [])
        last = add_iso(epoch, max(0, len(existing) - 1)) if existing else epoch
        left = days_between(today, last)
        if existing and left >= 60 and "--force" not in sys.argv:
            print(f"schedule runs through {last} ({left} days left)")
            return 0
    cache = load_cache()
    rows = fetch_rows(cache)
    by_id = {row["id"]: row for row in rows}
    if extend and old and old.get("days"):
        epoch = old.get("epoch") or today
        existing = list(old["days"])
        old_pool = {card["id"]: card for card in old.get("pool") or [] if isinstance(card, dict) and card.get("id")}
        target = days_between(epoch, today) + DAYS
        if len(existing) >= target:
            print(f"schedule already covers {len(existing)} days")
            return 0
        recent = []
        ecard = 0
        for card_id in existing[-30:]:
            card = old_pool.get(card_id) or by_id.get(card_id) or {}
            species = card.get("species") or species_of(card.get("name") or "")
            if species:
                recent.append(species)
        for card_id in existing:
            card = old_pool.get(card_id) or {}
            if str(card.get("setId") or "").startswith("ecard"):
                ecard += 1
        added, _, _ = schedule(
            rows,
            target - len(existing),
            recent=recent,
            ecard=ecard,
            ecard_cap=max(1, int(target * 0.08)),
            used=set(existing),
        )
        if not added:
            raise SystemExit("no new priced cards to extend the schedule")
        days = existing + added
        pool = []
        for card_id in days:
            if card_id in old_pool and card_id not in added:
                pool.append(old_pool[card_id])
            elif card_id in by_id:
                pool.append(public_card(by_id[card_id]))
            else:
                raise SystemExit(f"missing card {card_id}")
        write_doc(epoch, days, pool)
        print(f"extended by {len(added)} days through {add_iso(epoch, len(days) - 1)}")
        return 0
    days, _, _ = schedule(rows, DAYS)
    if len(days) < 365:
        raise SystemExit(f"only scheduled {len(days)} days")
    pool = [public_card(by_id[card_id]) for card_id in days]
    write_doc(today, days, pool)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
