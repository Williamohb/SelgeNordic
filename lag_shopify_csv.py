"""Lager en Shopify-importfil (CSV) og 920x920-produktbilder fra TCGplayer-lenker.

1. Lim inn TCGplayer-lenker i nye_kort.txt, én per linje. Bak lenken kan du
   skrive valg (alle er frivillige):
       antall=2  pris=349  tilstand=LP  variant=reverse
2. Kjør:  python lag_shopify_csv.py
3. Bildene havner i produktbilder/. Push med GitHub Desktop, og vent til
   Actions-kjøringen er ferdig (bildene må ligge på nettsiden før importen).
4. Shopify: Produkter -> Importer -> velg fila i shopify-import/.

Kortdata (navn, sett, nummer, sjeldenhet, illustratør) hentes fra TCGplayer,
markedsprisen fra tcgcsv.com (samme kilde som innkjøpsportalen) og
USD/NOK-kursen fra Norges Bank. Kolonnene følger shopify-mal.csv, som er
overskriftsraden fra en produkteksport fra Shopify. Bytt den ut med en ny
eksport hvis Shopify endrer kolonnene.
"""
import csv
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime

from PIL import Image

# ---------------------------------------------------------------- innstillinger
PAASLAG = 1.30          # salgspris = markedspris (USD) x kurs x PAASLAG
MINSTEPRIS = 19         # laveste pris i kroner
STANDARD_ANTALL = 1     # lagerantall når du ikke skriver antall=
STANDARD_TILSTAND = "NM"
# TCGplayer-markedsprisen gjelder Near Mint. Andre tilstander får denne andelen:
TILSTAND_FAKTOR = {"NM": 1.00, "LP": 0.85, "MP": 0.70, "HP": 0.50, "DMG": 0.35}
BILDE_URL = "https://selg.pokenordic.no/produktbilder"  # der GitHub Pages publiserer produktbilder/

INNDATA = "nye_kort.txt"
MAL = "shopify-mal.csv"
BILDEMAPPE = "produktbilder"
UTMAPPE = "shopify-import"
# ------------------------------------------------------------------------------

TILSTANDER = {
    "NM": "Near Mint",
    "LP": "Lightly Played",
    "MP": "Moderately Played",
    "HP": "Heavily Played",
    "DMG": "Damaged",
}
UA = {"User-Agent": "card-buylist-builder/1.0"}
OUTPUT_WIDTH = OUTPUT_HEIGHT = 920


def get_bytes(url, attempts=4):
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:
            if i == attempts - 1:
                raise RuntimeError(f"klarte ikke å hente {url}: {e}") from e
            time.sleep(2 ** (i + 1))


def get_json(url):
    return json.loads(get_bytes(url).decode("utf-8"))


def usd_nok():
    text = get_bytes(
        "https://data.norges-bank.no/api/data/EXR/B.USD.NOK.SP"
        "?lastNObservations=1&format=csv"
    ).decode("utf-8")
    row = list(csv.DictReader(io.StringIO(text), delimiter=";"))[-1]
    return float(row["OBS_VALUE"]), row["TIME_PERIOD"]


# ---------------------------------------------------------------- bilder
def make_padded_image(img, width=OUTPUT_WIDTH, height=OUTPUT_HEIGHT):
    """Legger bildet sentrert på hvit 920x920-bakgrunn uten å strekke det.
    Transparente områder (f.eks. avrundede hjørner) blir hvite."""
    img = img.convert("RGBA")
    img.thumbnail((width, height), Image.Resampling.LANCZOS)
    background = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    background.alpha_composite(img, ((width - img.width) // 2, (height - img.height) // 2))
    return background.convert("RGB")


def lag_bilde(pid, filnavn):
    path = os.path.join(BILDEMAPPE, filnavn)
    if os.path.exists(path):
        return path
    data = get_bytes(f"https://tcgplayer-cdn.tcgplayer.com/product/{pid}_in_1000x1000.jpg")
    with Image.open(io.BytesIO(data)) as img:
        make_padded_image(img).save(path, quality=95, subsampling=0)
    return path


# ---------------------------------------------------------------- tekst
def slug(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def rens_settnavn(name):
    # "ME06: Delta Reign" -> "Delta Reign", "XY - BREAKpoint" -> "BREAKpoint"
    return re.sub(r"^[A-Za-z0-9]+(?::| -)\s+", "", name).strip()


NUM_SUFFIX = re.compile(r" - [A-Za-z]*\d+[A-Za-z]*(?:/[A-Za-z0-9-]+)?(?=\s|$)")


def del_navn(product_name):
    # "Espeon ex - 108 (30th Celebration)" -> ("Espeon ex", "(30th Celebration)")
    name = re.sub(r"\s{2,}", " ", NUM_SUFFIX.sub("", product_name)).strip()
    m = re.match(r"^(.*?)\s*(\([^()]*\))?$", name)
    return m.group(1), m.group(2) or ""


def variant_etikett(subtype):
    return subtype.replace("Holofoil", "Holo")


def variant_sku(subtype):
    if subtype.startswith("Reverse"):
        return "-RH"
    if subtype.startswith("1st Edition"):
        return "-1E"
    if subtype.startswith("Unlimited"):
        return "-UL"
    return ""


def pris_nok(usd, kurs, tilstand):
    kr = usd * kurs * PAASLAG * TILSTAND_FAKTOR[tilstand]
    kr = max(MINSTEPRIS, kr)
    return math.ceil((kr + 1) / 10) * 10 - 1  # rund opp til nærmeste ...9


# ---------------------------------------------------------------- inndata
def les_linjer():
    if not os.path.exists(INNDATA):
        with open(INNDATA, "w", encoding="utf-8") as f:
            f.write(
                "# Én TCGplayer-lenke per linje. Valg bak lenken (frivillig):\n"
                "#   antall=2  pris=349  tilstand=NM|LP|MP|HP|DMG  variant=normal|holo|reverse\n"
                "# Linjer som starter med # hoppes over.\n"
            )
        sys.exit(f"Lagde {INNDATA}. Lim inn lenkene der og kjør igjen.")
    jobs = []
    with open(INNDATA, encoding="utf-8-sig") as f:
        for nr, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            m = re.search(r"/product/(\d+)", parts[0]) or re.fullmatch(r"(\d+)", parts[0])
            if not m:
                print(f"  Linje {nr}: fant ingen TCGplayer-produktlenke, hopper over")
                continue
            query = urllib.parse.parse_qs(urllib.parse.urlparse(parts[0]).query)
            opts = {"linje": nr, "pid": int(m.group(1)),
                    "språk": (query.get("Language") or ["English"])[0],
                    "printing": (query.get("Printing") or [""])[0]}
            for p in parts[1:]:
                if "=" in p:
                    k, v = p.split("=", 1)
                    opts[k.lower()] = v
            jobs.append(opts)
    return jobs


def velg_variant(prices, ønsket):
    """prices: {subTypeName: marketPrice}. Returnerer (subtype, er_standard)."""
    subtypes = list(prices)
    if not subtypes:
        return None, True
    standard = next((s for s in ("Holofoil", "Normal") if s in prices), subtypes[0])
    if ønsket:
        alias = {"normal": "Normal", "holo": "Holofoil", "reverse": "Reverse Holofoil",
                 "rh": "Reverse Holofoil"}.get(ønsket.lower(), ønsket)
        treff = [s for s in subtypes if s.lower() == alias.lower()] or \
                [s for s in subtypes if alias.lower() in s.lower()]
        if not treff:
            raise ValueError(f"varianten «{ønsket}» finnes ikke (har: {', '.join(subtypes)})")
        return treff[0], treff[0] == standard
    return standard, True


# ---------------------------------------------------------------- hovedløp
def main():
    jobs = les_linjer()
    if not jobs:
        sys.exit(f"Ingen lenker i {INNDATA}.")

    with open(MAL, encoding="utf-8", newline="") as f:
        header = next(csv.reader(f))
    # Metafelt-kolonner slås opp på nøkkelen i parentes, så navnet foran kan variere
    col = {}
    for i, h in enumerate(header):
        m = re.search(r"\(product\.metafields\.([^)]+)\)$", h)
        col[m.group(1) if m else h] = i

    os.makedirs(BILDEMAPPE, exist_ok=True)
    os.makedirs(UTMAPPE, exist_ok=True)
    kurs, kursdato = usd_nok()
    print(f"USD/NOK {kurs} ({kursdato}), påslag {PAASLAG}")

    pris_cache = {}
    rows, by_handle, feil = [], {}, []
    for job in jobs:
        nr, pid = job["linje"], job["pid"]
        try:
            if job["språk"].lower() != "english":
                raise ValueError(f"bare engelske kort støttes (lenken har Language={job['språk']})")
            tilstand = job.get("tilstand", STANDARD_TILSTAND).upper()
            if tilstand not in TILSTANDER:
                raise ValueError(f"ukjent tilstand «{tilstand}» (bruk {', '.join(TILSTANDER)})")
            antall = int(job.get("antall", STANDARD_ANTALL))

            d = get_json(f"https://mp-search-api.tcgplayer.com/v1/product/{pid}/details")
            ca = d.get("customAttributes") or {}
            fa = d.get("formattedAttributes") or {}
            group = int(d["setId"])
            if group not in pris_cache:
                pris_cache[group] = get_json(f"https://tcgcsv.com/tcgplayer/3/{group}/prices")["results"]
            prices = {p["subTypeName"]: p.get("marketPrice")
                      for p in pris_cache[group] if p["productId"] == pid}
            subtype, er_standard = velg_variant(prices, job.get("variant") or job["printing"])

            navn, ekstra = del_navn(d["productName"])
            nummer = (ca.get("number") or "").strip()
            sett = rens_settnavn(d["setName"])
            kode = d.get("setCode") or ""
            sjelden = d.get("rarityName") or ""
            artist = fa.get("Artist") or ""
            etikett = variant_etikett(subtype) if subtype else ""

            tittel = navn
            if nummer:
                tittel += f" {nummer}"
            if ekstra:
                tittel += f" {ekstra}"
            if subtype and not er_standard:
                tittel += f" ({etikett})"
            tittel += f" - {sett}"
            handle = slug(tittel)
            tnavn = TILSTANDER[tilstand]
            if tilstand != "NM":
                handle += f"-{tilstand.lower()}"

            if handle in by_handle:  # samme kort to ganger: legg sammen antallet
                r = rows[by_handle[handle]]
                r[col["Variant Inventory Qty"]] = str(int(r[col["Variant Inventory Qty"]]) + antall)
                print(f"  Linje {nr}: {tittel} står flere ganger, la sammen antallet")
                continue

            if "pris" in job:
                pris = float(job["pris"].replace(",", "."))
            elif prices.get(subtype) is not None:
                pris = pris_nok(prices[subtype], kurs, tilstand)
            else:
                pris = None

            bildefil = f"{handle}.jpg"
            lag_bilde(pid, bildefil)

            row = [""] * len(header)

            def put(key, value):
                if key in col:
                    row[col[key]] = value

            put("Handle", handle)
            put("Title", tittel)
            put("Body (HTML)", "")
            put("Vendor", "Pokémon")
            put("Product Category", "Leker og spill > Spill > Kortspill")
            put("Type", "Pokémon Single")
            put("Tags", ", ".join(t for t in [sett, kode, "enkeltkort", sjelden, "Pokémon", "Pokémon Single"] if t))
            put("Published", "true")
            put("Option1 Name", "Title")
            put("Option1 Value", "Default Title")
            put("Variant SKU", f"{kode}-{nummer.split('/')[0]}{variant_sku(subtype or '')}-{tilstand}")
            put("Variant Grams", "2.0")
            put("Variant Inventory Tracker", "shopify")
            put("Variant Inventory Qty", str(antall))
            put("Variant Inventory Policy", "deny")
            put("Variant Fulfillment Service", "manual")
            put("Variant Price", f"{pris:.2f}" if pris is not None else "")
            put("Variant Requires Shipping", "true")
            put("Variant Taxable", "true")
            put("Image Src", f"{BILDE_URL}/{bildefil}")
            put("Image Position", "1")
            put("Image Alt Text", f"{tittel} (Engelsk / {tnavn})")
            put("Gift Card", "false")
            put("SEO Title", tittel)
            put("SEO Description", " ".join(f"{t}." for t in
                [f"Pokémon enkeltkort fra {sett}", sjelden, "Engelsk", tnavn] if t))
            put("Google Shopping / Google Product Category", "toys & games > games > card games")
            put("Google Shopping / Condition", "Used")
            put("Google Shopping / Custom Product", "FALSE")
            put("Google Shopping / Custom Label 0", kode)
            put("Google Shopping / Custom Label 1", sjelden)
            put("Google Shopping / Custom Label 2", "English")
            put("Google Shopping / Custom Label 3", tnavn)
            put("Google Shopping / Custom Label 4", etikett)
            put("custom.custom_card_artist", artist)
            put("custom.ekspansjon", sett)
            put("custom.sjeldenhet", sjelden)
            put("custom.sprak", "Engelsk")
            put("custom.tilstand", tnavn)
            put("mm-google-shopping.custom_product", "FALSE")
            put("Variant Weight Unit", "g")
            put("Status", "active" if pris is not None else "draft")

            by_handle[handle] = len(rows)
            rows.append(row)
            usd = prices.get(subtype)
            pris_tekst = f"{pris:.0f} kr" if pris is not None else "INGEN PRIS (lagres som utkast)"
            usd_tekst = f" (marked ${usd})" if usd is not None and "pris" not in job else ""
            print(f"  {tittel} | {etikett or '-'} | {tnavn} | {antall} stk | {pris_tekst}{usd_tekst}")
        except Exception as e:
            feil.append(f"Linje {nr} (produkt {pid}): {e}")

    if rows:
        ut = os.path.join(UTMAPPE, f"nye_kort_{datetime.now():%Y-%m-%d_%H%M}.csv")
        with open(ut, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(header)
            w.writerows(rows)
        print(f"\n{len(rows)} kort skrevet til {ut}")
        print(f"Bildene ligger i {BILDEMAPPE}/. Push med GitHub Desktop og vent til "
              "nettsiden er publisert før du importerer fila i Shopify.")
    if feil:
        print("\nFikk ikke lagt til:")
        for f_ in feil:
            print("  " + f_)


if __name__ == "__main__":
    main()
