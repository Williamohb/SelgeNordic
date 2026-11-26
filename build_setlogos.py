"""Henter settlogoer til settoversikten («Legg inn et helt sett») i portalen.

    python build_setlogos.py [cachemappe]        (standard: card_img_cache)

Logoene kommer fra pokemontcg.io (bare engelske sett) og kobles til settene i cards.json på settkoden
(PTCGO-koden, f.eks. MEW) eller navnet. Hver logo lagres som en liten webp i setlogos/, og
setlogos.json sier hvilket sett som har hvilken logo. Rå logoer og API-svaret mellomlagres i
<cachemappe>/setlogos/, så bare nye sett hentes. Feiler API-et, brukes forrige svar; feiler alt,
får settene bare tekst. Byggingen stopper aldri på grunn av logoene.
"""
import io
import json
import os
import re
import sys
import time
import urllib.request

from PIL import Image

API = "https://api.pokemontcg.io/v2/sets?pageSize=250&orderBy=-releaseDate"
UT = "setlogos"
MAKS = (240, 80)   # vist i ca. 120 x 40 px, dobbel oppløsning for skarpe skjermer

# TCGplayer-navn som ikke ligner navnet hos pokemontcg.io (normalisert navn -> pokemontcg.io-id)
ALIAS = {
    "scarletvioletpromocards": "svp", "swordshieldpromocards": "swshp", "sunmoonpromos": "smp", "smpromos": "smp",
    "xypromos": "xyp", "blackandwhitepromos": "bwp", "bwpromos": "bwp", "hgsspromos": "hsp", "heartgoldsoulsilverpromos": "hsp",
    "diamondandpearlpromos": "dpp", "dppromos": "dpp", "nintendopromos": "np", "wotcpromo": "basep", "wizardsblackstarpromos": "basep",
    "swordshieldbaseset": "swsh1", "sunmoonbaseset": "sm1", "scarletvioletbaseset": "sv1", "xybaseset": "xy1",
    "scarletvioletenergies": "sve", "megaevolutionenergies": "mee", "mcdonalds25thanniversarypromos": "mcd21",
    "smbaseset": "sm1", "basesetshadowless": "base1", "rumble": "ru1",
}


def norm(navn):
    # «SV: Scarlet & Violet 151», «SM - Cosmic Eclipse», «SWSH01: Sword & Shield Base Set» -> uten kodeprefiks
    navn = re.sub(r"^(?:[A-Za-z0-9.]+\s*:\s*|(?:SM|XY|BW|DP|HGSS|SWSH|SV|ME)\s*-\s*)", "", navn)
    return re.sub(r"[^a-z0-9]", "", navn.lower())


def hent(url, forsøk=4):
    for i in range(forsøk):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "PokeNordic-innkjop"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # pokemontcg.io svarer av og til 500
            if i == forsøk - 1:
                raise
            time.sleep(2 * (i + 1))


def api_sett(cache):
    sti = os.path.join(cache, "api.json")
    try:
        data = json.loads(hent(API))["data"]
        with open(sti, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        return data
    except Exception as e:
        if os.path.exists(sti):
            print(f"  pokemontcg.io svarte ikke ({e}), bruker forrige svar")
            with open(sti, encoding="utf-8") as f:
                return json.load(f)
        print(f"  pokemontcg.io svarte ikke ({e}), ingen logoer denne gangen")
        return []


def koble(sett, api):
    """{settnavn i cards.json: pokemontcg.io-sett}"""
    på_kode = {s["ptcgoCode"]: s for s in api if s.get("ptcgoCode")}
    på_navn = {norm(s["name"]): s for s in api}
    på_id = {s["id"]: s for s in api}
    ut = {}
    for navn, kode, dato, _ in sett:
        n = norm(navn)
        s = (på_id.get(ALIAS.get(n, "")) or på_navn.get(n) or på_kode.get(kode)
             or (på_id.get("mcd" + m.group(1)[-2:]) if (m := re.match(r"mcdonaldspromos(\d{4})$", n)) else None))
        # samme kode brukes av hovedsett og undersett (30th Celebration / Classic Collection): navnet vinner
        if s and (s.get("images") or {}).get("logo"):
            ut[navn] = s
    return ut


def main():
    cache = os.path.join(sys.argv[1] if len(sys.argv) > 1 else "card_img_cache", "setlogos")
    os.makedirs(cache, exist_ok=True)
    os.makedirs(UT, exist_ok=True)
    with open("cards.json", encoding="utf-8") as f:
        sett = json.load(f)["sets"]
    api = api_sett(cache)
    koblet = koble(sett, api)
    kart, feil = {}, 0
    for navn, s in koblet.items():
        rå = os.path.join(cache, s["id"] + ".png")
        mål = os.path.join(UT, s["id"] + ".webp")
        try:
            if not os.path.exists(rå):
                with open(rå, "wb") as f:
                    f.write(hent(s["images"]["logo"]))
            if not os.path.exists(mål):
                with Image.open(rå) as im:
                    im = im.convert("RGBA")
                    im.thumbnail(MAKS, Image.LANCZOS)
                    im.save(mål, "WEBP", quality=88, method=6)
            kart[navn] = f"{UT}/{s['id']}.webp"
        except Exception as e:
            feil += 1
            print(f"  fikk ikke logoen til {navn}: {e}")
    with open("setlogos.json", "w", encoding="utf-8") as f:
        json.dump({"en": kart}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Settlogoer: {len(kart)} av {len(sett)} engelske sett" + (f", {feil} feilet" if feil else ""))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # logoene skal aldri stoppe publiseringen
        print(f"Settlogoer hoppet over: {e}")
        if not os.path.exists("setlogos.json"):
            with open("setlogos.json", "w", encoding="utf-8") as f:
                f.write('{"en":{}}')
