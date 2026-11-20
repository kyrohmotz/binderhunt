#!/usr/bin/env python3
"""Build data/pack-pools.json from the public TCGdex API.

No key, no Scrydex. Each booster set keeps the cards a pack can actually
deal: commons, uncommons, non-holo rares, holo rares, ultra rares, and
the illustration-style cards that fill a modern foil slot. Cards without
a usable image are left out. Re-run this when the set list should change,
then commit the JSON.
"""
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "pack-pools.json"
API = "https://api.tcgdex.net/v2/en"
UA = "binderhunt-pack-pools/1.0"
CTX = ssl.create_default_context()

# Exact rarity strings, lowercased. "Rare" is split separately because
# Wizards holos and some Black & White rares share that one word.
ART = {
    "illustration rare",
    "special illustration rare",
    "hyper rare",
    "mega hyper rare",
}
ULTRA = {
    "ultra rare",
    "secret rare",
    "shiny ultra rare",
    "shiny rare vmax",
    "ace spec rare",
    "amazing rare",
    "radiant rare",
    "rare prime",
    "legend",
    "classic collection",
    "full art trainer",
    "mega attack rare",
    "rare holo lv.x",
    "holo rare vmax",
    "holo rare vstar",
    "rare holo vmax",
    "rare holo vstar",
    "shiny rare vstar",
}
HOLO = {
    "holo rare",
    "rare holo",
    "holo rare v",
    "rare holo v",
    "shiny rare",
    "shiny rare v",
    "double rare",
    "rare holo ex",
}
QUERY_RARITIES = [
    "Common", "Uncommon", "Rare",
    "Holo Rare", "Rare Holo", "Rare Holo LV.X", "Rare Holo V", "Rare Holo VMAX", "Rare Holo VSTAR",
    "Holo Rare V", "Holo Rare VMAX", "Holo Rare VSTAR",
    "Double rare", "Ultra Rare", "Secret Rare",
    "Illustration rare", "Special illustration rare", "Hyper rare", "Mega Hyper Rare",
    "ACE SPEC Rare", "Amazing Rare", "Radiant Rare", "Rare PRIME", "LEGEND", "Classic Collection",
    "Shiny rare", "Shiny rare V", "Shiny rare VMAX", "Shiny Ultra Rare", "Shiny rare VSTAR",
    "Full Art Trainer", "Mega Attack Rare", "Rare Holo EX",
]

EXCLUDE_IDS = {
    "miscp", "basep", "wp", "jumbo", "si1", "sp", "bog", "np", "ex5.5", "exu",
    "dpp", "hgssp", "bwp", "xyp", "smp", "swshp", "svp", "mep",
    "sve", "mee", "mfb", "fut2020", "rc", "xya", "xy0", "dv1", "ru1", "det1",
    "cel25", "cel25cc", "30th-c", "dc1",
}


def excluded(set_id, name):
    if set_id in EXCLUDE_IDS:
        return True
    if set_id.startswith("tk-") or set_id.startswith("pop"):
        return True
    if set_id == "P-A" or re.match(r"^[AB]\d", set_id):
        return True
    if re.match(r"^(19|20)\d{2}", set_id):
        return True
    text = name.lower()
    needles = (
        "promo", "mcdonald", "trainer kit", "trainer gallery", "shiny vault",
        "galarian gallery", "classic collection", "jumbo", "sample", "futsal",
        "black star", "my first battle", "radiant collection", "dragon vault",
        "unown collection", "southern islands", "best of game",
    )
    if any(needle in text for needle in needles):
        return True
    if text.endswith(" energy"):
        return True
    return False


def get_json(url, tries=4):
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=40, context=CTX) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            last = err
            if err.code in (404, 400):
                return None
            time.sleep(0.4 * (attempt + 1))
        except Exception as err:
            last = err
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError("failed " + url + " " + str(last))


def head_ok(url, tries=3):
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=25, context=CTX) as res:
                kind = (res.headers.get("Content-Type") or "").lower()
                return res.status == 200 and kind.startswith("image/")
        except urllib.error.HTTPError as err:
            last = err
            if err.code == 404:
                return False
            # Some hosts reject HEAD. A tiny GET still proves the file exists.
            if err.code in (403, 405, 501):
                return get_ok(url)
            time.sleep(0.3 * (attempt + 1))
        except Exception as err:
            last = err
            time.sleep(0.3 * (attempt + 1))
    return False


def get_ok(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-32"})
    try:
        with urllib.request.urlopen(req, timeout=25, context=CTX) as res:
            kind = (res.headers.get("Content-Type") or "").lower()
            return res.status in (200, 206) and (kind.startswith("image/") or "webp" in kind or "png" in kind)
    except Exception:
        return False


def rarity_cards(set_id, rarity):
    found = []
    page = 1
    while page <= 6:
        query = urllib.parse.urlencode({
            "set": "eq:" + set_id,
            "rarity": "eq:" + rarity,
            "pagination:page": str(page),
            "pagination:itemsPerPage": "300",
        }, safe=":")
        data = get_json(API + "/cards?" + query)
        if not isinstance(data, list) or not data:
            break
        found.extend(data)
        if len(data) < 300:
            break
        page += 1
    return found


def clean_name(name):
    text = re.sub(r"\s+", " ", str(name or "")).strip()
    text = text.replace("\t", " ").replace("|", "/")
    return text[:80]


def natural(local_id):
    parts = re.split(r"(\d+)", str(local_id))
    key = []
    for part in parts:
        key.append(int(part) if part.isdigit() else part.lower())
    return key


def bucket_for(rarity):
    key = str(rarity or "").strip().lower()
    if key in ART:
        return "a"
    if key in ULTRA:
        return "x"
    if key in HOLO:
        return "h"
    if key == "rare":
        return "rare"
    if key == "uncommon":
        return "u"
    if key == "common":
        return "c"
    return ""


def ecard_holo_png(set_id, local_id):
    if set_id not in ("ecard2", "ecard3"):
        return ""
    if not re.fullmatch(r"[Hh]\d+", str(local_id or "")):
        return ""
    number = str(int(re.sub(r"\D", "", local_id)))
    return "https://images.pokemontcg.io/" + set_id + "/H" + number + ".png"


def serie_from_image(url):
    parts = str(url or "").split("/")
    if "en" not in parts:
        return ""
    index = parts.index("en")
    if index + 1 >= len(parts):
        return ""
    return parts[index + 1]


def main():
    sets = get_json(API + "/sets") or []
    chosen = []
    for row in sets:
        set_id = str(row.get("id") or "")
        name = str(row.get("name") or set_id)
        if not set_id or excluded(set_id, name):
            continue
        chosen.append((set_id, name))
    print("sets to read", len(chosen))

    unknown = {}
    drafts = {}

    def read_set(item):
        set_id, name = item
        payload = get_json(API + "/sets/" + urllib.parse.quote(set_id))
        if not isinstance(payload, dict):
            return set_id, None
        by_id = {}
        serie = ""
        for card in payload.get("cards") or []:
            card_id = str(card.get("id") or "")
            if not card_id or "-" not in card_id:
                continue
            image = str(card.get("image") or "")
            if image and not serie:
                serie = serie_from_image(image)
            by_id[card_id] = {
                "id": card_id,
                "local": str(card.get("localId") or card_id.split("-", 1)[-1]),
                "name": clean_name(card.get("name") or "Card"),
                "image": image,
            }
        grouped = {key: [] for key in ("c", "u", "r", "h", "x", "a")}
        rare_rows = []
        has_distinct_holo = False
        has_art_family = False
        local_unknown = []
        for rarity in QUERY_RARITIES:
            rows = rarity_cards(set_id, rarity)
            kind = bucket_for(rarity)
            if not rows:
                continue
            if kind == "h":
                has_distinct_holo = True
            if kind == "a":
                has_art_family = True
            if kind == "":
                local_unknown.append((rarity, len(rows)))
                continue
            if kind == "rare":
                rare_rows = rows
                continue
            for row in rows:
                card = by_id.get(row.get("id"))
                if not card:
                    continue
                stamped = dict(card)
                stamped["rarity"] = rarity
                grouped[kind].append(stamped)
        return set_id, {
            "name": name,
            "serie": serie,
            "grouped": grouped,
            "rare_rows": rare_rows,
            "by_id": by_id,
            "has_distinct_holo": has_distinct_holo,
            "has_art_family": has_art_family,
            "unknown": local_unknown,
        }

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(read_set, item) for item in chosen]
        done = 0
        for future in as_completed(futures):
            set_id, draft = future.result()
            done += 1
            if draft:
                drafts[set_id] = draft
                for rarity, count in draft["unknown"]:
                    unknown.setdefault(rarity, 0)
                    unknown[rarity] += count
            if done % 20 == 0:
                print("read", done, "/", len(chosen))

    # "Rare" means two different things. When the set already has a Holo Rare
    # (or Double Rare / illustration rare) line, plain Rare is the usual
    # rare-slot card. Vintage and Black & White mix holo-only and non-holo
    # cards under that one word, so those cards are opened one by one.
    need_variants = []
    for set_id, draft in drafts.items():
        if not draft["rare_rows"]:
            continue
        if draft["has_distinct_holo"] or draft["has_art_family"]:
            # Plain Rare is the usual rare-slot card when the set also has a
            # real holo line, a Double Rare, or an illustration rare.
            if draft["has_art_family"] and not draft["has_distinct_holo"]:
                sample_ids = [row.get("id") for row in draft["rare_rows"][:8] if row.get("id")]
                sample = []
                for card_id in sample_ids:
                    full = get_json(API + "/cards/" + urllib.parse.quote(str(card_id)))
                    variants = (full or {}).get("variants") or {}
                    sample.append(bool(variants.get("holo")) and not bool(variants.get("normal")))
                if not (sample and all(sample)):
                    for row in draft["rare_rows"]:
                        card = draft["by_id"].get(row.get("id"))
                        if card:
                            need_variants.append((set_id, card["id"]))
                    continue
            for row in draft["rare_rows"]:
                card = draft["by_id"].get(row.get("id"))
                if not card:
                    continue
                stamped = dict(card)
                stamped["rarity"] = "Rare"
                draft["grouped"]["r"].append(stamped)
            continue
        for row in draft["rare_rows"]:
            card = draft["by_id"].get(row.get("id"))
            if card:
                need_variants.append((set_id, card["id"]))

    print("variant lookups", len(need_variants))

    def read_variant(item):
        set_id, card_id = item
        full = get_json(API + "/cards/" + urllib.parse.quote(card_id)) or {}
        variants = full.get("variants") or {}
        holo = bool(variants.get("holo")) and not bool(variants.get("normal"))
        return set_id, card_id, holo

    holo_only = set()
    if need_variants:
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = [pool.submit(read_variant, item) for item in need_variants]
            done = 0
            for future in as_completed(futures):
                set_id, card_id, holo = future.result()
                done += 1
                if holo:
                    holo_only.add((set_id, card_id))
                if done % 200 == 0:
                    print("variants", done, "/", len(need_variants))
    for set_id, card_id in need_variants:
        draft = drafts[set_id]
        card = draft["by_id"].get(card_id)
        if not card:
            continue
        stamped = dict(card)
        if (set_id, card_id) in holo_only:
            stamped["rarity"] = "Holo Rare"
            draft["grouped"]["h"].append(stamped)
        else:
            stamped["rarity"] = "Rare"
            draft["grouped"]["r"].append(stamped)

    def image_job(job):
        kind, url = job
        return kind, url, head_ok(url)

    jobs = []
    for set_id, draft in drafts.items():
        for key, cards in draft["grouped"].items():
            for card in cards:
                png = ecard_holo_png(set_id, card["local"])
                if card["image"]:
                    jobs.append((("tcg", set_id, card["id"]), card["image"] + "/low.webp"))
                elif png:
                    jobs.append((("ptcg", set_id, card["id"]), png))
                    card["ptcg"] = png
                else:
                    card["drop"] = True
    print("image checks", len(jobs))
    good = set()
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(image_job, job) for job in jobs]
        done = 0
        for future in as_completed(futures):
            kind, url, ok = future.result()
            done += 1
            if ok:
                good.add(kind)
            if done % 1000 == 0:
                print("images", done, "/", len(jobs))

    result = {"v": 1, "source": "tcgdex", "sets": {}}
    kept_sets = 0
    dropped_images = 0
    for set_id, name in chosen:
        draft = drafts.get(set_id)
        if not draft or not draft["serie"]:
            continue
        packed = {}
        for key in ("c", "u", "r", "h", "x", "a"):
            rows = []
            seen = set()
            for card in sorted(draft["grouped"][key], key=lambda item: natural(item["local"])):
                if card["id"] in seen or card.get("drop"):
                    continue
                token = ("tcg", set_id, card["id"]) if card.get("image") else ("ptcg", set_id, card["id"])
                if token not in good:
                    dropped_images += 1
                    continue
                seen.add(card["id"])
                rarity = card.get("rarity") or {"c": "Common", "u": "Uncommon", "r": "Rare", "h": "Holo Rare", "x": "Ultra Rare", "a": "Illustration Rare"}[key]
                rows.append(card["local"] + "\t" + card["name"] + "\t" + rarity)
            packed[key] = rows
        # A set is a pack only when the common slots and the rare slot can
        # be filled without borrowing holos.
        if len(packed["c"]) < 4 or len(packed["u"]) < 2 or not (packed["r"] or packed["h"] or packed["x"]):
            continue
        result["sets"][set_id] = {
            "name": draft["name"],
            "serie": draft["serie"],
            "c": packed["c"],
            "u": packed["u"],
            "r": packed["r"],
            "h": packed["h"],
            "x": packed["x"],
            "a": packed["a"],
        }
        kept_sets += 1

    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("wrote", OUT, "sets", kept_sets, "dropped images", dropped_images, "bytes", OUT.stat().st_size)
    if unknown:
        print("unknown rarities", unknown)
    for sample in ("base1", "ecard2", "ecard3", "ex1", "dp1", "bw1", "swsh7", "sv01", "sv08", "me02"):
        row = result["sets"].get(sample)
        if not row:
            print(sample, "MISSING")
            continue
        print(sample, {key: len(row[key]) for key in ("c", "u", "r", "h", "x", "a")}, row["serie"])


if __name__ == "__main__":
    main()
