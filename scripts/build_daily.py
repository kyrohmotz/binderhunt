#!/usr/bin/env python3
"""Build data/daily.json, a year of Daily Drop cards.

Reads the public TCGdex catalog and the committed Scrydex cache. It does not
call Scrydex and does not use an API key. Cards with no usable raw price are
skipped. America/New_York dates are assigned in order from today, so the file
is the puzzle: the site does not re-roll it.

Re-run when you want a fresh year. Prices are a snapshot, on purpose.
"""

from __future__ import annotations

import json
import random
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
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


def choose_price(card: dict, fx: float):
    table = ((card.get("pricing") or {}).get("tcgplayer") or {})
    options = []
    if isinstance(table, dict):
        for key, value in table.items():
            if not isinstance(value, dict):
                continue
            market = positive(value.get("marketPrice"))
            if market:
                options.append((key, market))
    def priced(pred):
        return [item for item in options if pred(flags(item[0])) and not flags(item[0])["first"]]

    holos = priced(lambda flag: flag["holo"] and not flag["reverse"])
    reverses = priced(lambda flag: flag["holo"] and flag["reverse"])
    plain = priced(lambda flag: True) or options
    pool = holos or reverses or plain
    if pool:
        pool.sort(key=lambda item: (item[1], item[0]))
        key, price = pool[0]
        return round(price, 2), key, "tcgplayer"
    market = (card.get("pricing") or {}).get("cardmarket") or {}
    eur = 0.0
    if isinstance(market, dict):
        for field in ("avg", "trend", "avg7", "avg30", "avg1"):
            eur = max(eur, positive(market.get(field)))
    if eur > 0 and fx > 0:
        return round(eur * fx, 2), "cardmarket", "cardmarket", round(eur, 2)
    return None


def trend_points(card: dict, fx: float):
    market = (card.get("pricing") or {}).get("cardmarket") or {}
    if not isinstance(market, dict) or fx <= 0:
        return []
    points = []
    for label, field in (("30-day avg", "avg30"), ("7-day avg", "avg7"), ("1-day avg", "avg1")):
        value = positive(market.get(field))
        if not value:
            continue
        points.append({"label": label, "value": round(value * fx, 2)})
    return points


def quote_eur(card: dict) -> float:
    market = (card.get("pricing") or {}).get("cardmarket") or {}
    if isinstance(market, dict):
        for field in ("avg", "trend", "avg7", "avg30", "avg1"):
            value = positive(market.get(field))
            if value:
                return round(value, 2)
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


def schedule(rows: list[dict]) -> list[str]:
    buckets = defaultdict(list)
    for row in rows:
        buckets[row["bucket"]].append(row)
    queues = {name: weave(cards) for name, cards in buckets.items()}
    gems = weave([card for card in queues.get("wotc", []) if card.get("gem")])
    plain = weave([card for card in queues.get("wotc", []) if not card.get("gem")])
    queues["wotc"] = plain
    queues["gem"] = gems
    days = []
    used = set()
    turns = 0
    previous = ""
    guard = 0
    while len(days) < DAYS and guard < DAYS * 6:
        guard += 1
        placed = False
        for name in BUCKETS:
            key = name
            if name == "wotc":
                turns += 1
                key = "gem" if turns % 2 == 0 and queues.get("gem") else "wotc"
                if not queues.get(key):
                    key = "gem" if key == "wotc" else "wotc"
            card = pop_named(queues.get(key) or [], previous)
            if not card or card["id"] in used or card["price"] < POOL_FLOOR:
                continue
            used.add(card["id"])
            days.append(card["id"])
            previous = card["name"]
            placed = True
            if len(days) >= DAYS:
                break
        if not placed:
            break
    return days


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


def build_row(card_id: str, fx: float, cache: dict):
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
    quoted = choose_price(card, fx)
    if not quoted:
        return None
    if len(quoted) == 4:
        price, variant, source, eur = quoted
    else:
        price, variant, source = quoted
        eur = quote_eur(card)
    if price < POOL_FLOOR or price >= POOL_CAP:
        return None
    era = era_of(sid)
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
        "source": source,
        "gem": sid in GEM_SETS,
    }
    if eur:
        row["eur"] = eur
    points = trend_points(card, fx)
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


def main() -> int:
    fx = load_fx()
    cache = {}
    try:
        payload = json.loads(SCRYDEX.read_text(encoding="utf-8"))
        cache = payload.get("cards") or {}
    except Exception as error:
        print(f"scrydex cache unread: {error}", flush=True)
    briefs = brief_lists()
    print(f"fetching {len(briefs)} cards", flush=True)
    rows = []
    done = 0
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(build_row, card_id, fx, cache) for card_id in briefs]
        for future in as_completed(futures):
            done += 1
            if done % 100 == 0:
                print(f"priced {done}/{len(briefs)} kept {len(rows)}", flush=True)
            row = future.result()
            if row:
                rows.append(row)
    print(f"kept {len(rows)}", flush=True)
    days = schedule(rows)
    if len(days) < 365:
        raise SystemExit(f"only scheduled {len(days)} days")
    by_id = {row["id"]: row for row in rows}
    pool = [public_card(by_id[card_id]) for card_id in days]
    epoch = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    document = {
        "v": 1,
        "tz": "America/New_York",
        "epoch": epoch,
        "generated": epoch,
        "fx": fx,
        "days": days,
        "pool": pool,
    }
    OUT.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    eras = sorted({card["era"] for card in pool})
    gems = sum(1 for card in pool if card["setId"] in GEM_SETS)
    graded = sum(1 for card in pool if card.get("grades"))
    under = sum(1 for card in pool if card["price"] < 50)
    print(f"wrote {len(days)} days from {epoch}")
    print(f"eras {eras}")
    print(f"gems {gems} graded {graded} under50 {under}")
    print(f"day1 {pool[0]['id']} {pool[0]['name']} {pool[0]['price']} {pool[0]['set']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
