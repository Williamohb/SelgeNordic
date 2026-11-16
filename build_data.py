"""Bygger kortdataene for innkjøpsportalen.

Henter alle Pokémon-kort med TCGPlayer-markedspris fra tcgcsv.com (daglig
speil av TCGPlayer-data) og dagens USD/NOK-kurs fra Norges Bank.

Lager to filer:
  cards.json     engelske kort  (TCGPlayer-kategori 3)
  cards-jp.json  japanske kort  (TCGPlayer-kategori 85)

Kjør:  python build_data.py
"""
import csv
import io
import json
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

UA = {"User-Agent": "card-buylist-builder/1.0"}

# (TCGPlayer-kategori, utfil, beskrivelse)
CATEGORIES = [
    (3, "cards.json", "engelske"),
    (85, "cards-jp.json", "japanske"),
]

# Kortvarianter -> kort kode i datafila
VARIANTS = {
    "Normal": "N",
    "Holofoil": "H",
    "Reverse Holofoil": "R",
    "1st Edition": "1",
    "1st Edition Holofoil": "1H",
    "1st Edition Normal": "1",
    "Unlimited": "U",
    "Unlimited Holofoil": "UH",
}


def get_text(url, attempts=5):
    """Henter en URL, og prøver på nytt ved nettverksfeil (2, 4, 8, 16 s pause)."""
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            if i == attempts - 1:
                raise RuntimeError(f"Klarte ikke å hente {url}: {e}") from e
            print(f"  Feil mot {url} ({e}), prøver igjen ...", flush=True)
            time.sleep(2 ** (i + 1))


def get_json(url):
    return json.loads(get_text(url))


NUM_SUFFIX = re.compile(r" - [A-Za-z]*\d+[A-Za-z]*(?:/[A-Za-z0-9-]+)?(?=\s|$)")


def clean_name(name, number):
    # "Charizard ex - 199/165" -> "Charizard ex"
    # "Charizard - 20/149 (Cosmos Holo)" -> "Charizard (Cosmos Holo)"
    return re.sub(r"\s{2,}", " ", NUM_SUFFIX.sub("", name)).strip()


def release_date(g):
    """Settets utgivelsesdato (ÅÅÅÅ-MM-DD), eller "" når den er ukjent.

    For en del eldre sett mangler TCGPlayer dato, og tcgcsv fyller da inn
    tidspunktet for siste oppdatering (med klokkeslett og «Z»). Slike
    datoer er ikke ekte utgivelsesdatoer og blir ignorert.
    """
    p = g.get("publishedOn") or ""
    if not p or p.endswith("Z") or "." in p or p[:10] > (g.get("modifiedOn") or "9999")[:10]:
        return ""
    return p[:10]


def build(category, outfile, label, updated, usd_nok, rate_date):
    base = f"https://tcgcsv.com/tcgplayer/{category}"
    groups = get_json(f"{base}/groups")["results"]

    def fetch_group(g):
        gid = g["groupId"]
        products = get_json(f"{base}/{gid}/products")["results"]
        prices = get_json(f"{base}/{gid}/prices")["results"]
        return g, products, prices

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(fetch_group, groups))

    # Nyeste sett først (sett uten kjent utgivelsesdato havner sist)
    results.sort(key=lambda x: release_date(x[0]), reverse=True)

    sets, cards = [], []
    for g, products, prices in results:
        by_pid = {}
        for p in prices:
            mp = p.get("marketPrice")
            code = VARIANTS.get(p.get("subTypeName"), p.get("subTypeName"))
            by_pid.setdefault(p["productId"], []).append(
                [code, round(mp, 2) if mp is not None else None]
            )
        set_cards = []
        for prod in products:
            ext = {e["name"]: e["value"] for e in prod.get("extendedData") or []}
            number = (ext.get("Number") or "").strip()
            rarity = (ext.get("Rarity") or "").strip()
            if not number or rarity == "Code Card":
                continue
            variants = by_pid.get(prod["productId"], [])
            if not variants:
                continue
            set_cards.append([
                prod["productId"],
                clean_name(prod["name"], number),
                len(sets),
                number,
                rarity,
                variants,
            ])
        if set_cards:
            sets.append([
                g["name"],
                g.get("abbreviation") or "",
                release_date(g),
                1 if g.get("isSupplemental") else 0,  # 1 = promo-/tilleggssett
            ])
            cards.extend(set_cards)

    out = {
        "updated": updated,
        "usdNok": usd_nok,
        "rateDate": rate_date,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sets": sets,
        "cards": cards,
    }
    with open(outfile, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{outfile}: {len(cards)} {label} kort i {len(sets)} sett")


def main():
    updated = get_text("https://tcgcsv.com/last-updated.txt").strip()
    rate_csv = get_text(
        "https://data.norges-bank.no/api/data/EXR/B.USD.NOK.SP"
        "?lastNObservations=1&format=csv"
    )
    row = list(csv.DictReader(io.StringIO(rate_csv), delimiter=";"))[-1]
    usd_nok = float(row["OBS_VALUE"])
    rate_date = row["TIME_PERIOD"]

    for category, outfile, label in CATEGORIES:
        build(category, outfile, label, updated, usd_nok, rate_date)
    print(f"Kurs {usd_nok} ({rate_date}), priser {updated}")


if __name__ == "__main__":
    main()
