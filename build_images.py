"""Lager bildeark (sprites) med kortbilder, ett per sett, for innkjøpsportalen.

Leser cards.json (fra build_data.py), laster ned TCGPlayer-bildene til en
cache-mappe og skriver img/s<settindeks>.webp. Kortene ligger i samme
rekkefølge som i cards.json, COLS per rad, CELL_W x CELL_H piksler hver.

Kjør:  python build_images.py <cache-mappe>
"""
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

COLS = 20
CELL_W, CELL_H = 72, 100
QUALITY = 68
UA = {"User-Agent": "card-buylist-builder/1.0"}


def fetch(args):
    pid, cache = args
    path = os.path.join(cache, f"{pid}.jpg")
    if os.path.exists(path):
        return
    url = f"https://tcgplayer-cdn.tcgplayer.com/product/{pid}_200w.jpg"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
    except Exception:
        open(path + ".missing", "w").close()


def main():
    cache = sys.argv[1]
    os.makedirs(cache, exist_ok=True)
    os.makedirs("img", exist_ok=True)
    with open("cards.json", encoding="utf-8") as f:
        d = json.load(f)

    jobs = [(c[0], cache) for c in d["cards"]
            if not os.path.exists(os.path.join(cache, f"{c[0]}.jpg"))
            and not os.path.exists(os.path.join(cache, f"{c[0]}.jpg.missing"))]
    print(f"Laster ned {len(jobs)} bilder ...", flush=True)
    with ThreadPoolExecutor(max_workers=24) as pool:
        for i, _ in enumerate(pool.map(fetch, jobs), 1):
            if i % 2000 == 0:
                print(f"  {i}/{len(jobs)}", flush=True)

    by_set = {}
    for c in d["cards"]:
        by_set.setdefault(c[2], []).append(c[0])

    for f in os.listdir("img"):
        if f.endswith(".webp"):
            os.remove(os.path.join("img", f))

    total, missing = 0, 0
    for si, ids in by_set.items():
        rows = (len(ids) + COLS - 1) // COLS
        sheet = Image.new("RGB", (COLS * CELL_W, rows * CELL_H), (200, 205, 215))
        for i, pid in enumerate(ids):
            p = os.path.join(cache, f"{pid}.jpg")
            try:
                with Image.open(p) as im:
                    im = im.convert("RGB")
                    im.thumbnail((CELL_W * 3, CELL_H * 3))
                    # fyll cellen, behold proporsjoner (beskjær midt)
                    scale = max(CELL_W / im.width, CELL_H / im.height)
                    im = im.resize((max(CELL_W, round(im.width * scale)), max(CELL_H, round(im.height * scale))), Image.LANCZOS)
                    left = (im.width - CELL_W) // 2
                    top = (im.height - CELL_H) // 2
                    im = im.crop((left, top, left + CELL_W, top + CELL_H))
                    sheet.paste(im, ((i % COLS) * CELL_W, (i // COLS) * CELL_H))
            except Exception:
                missing += 1
        out = os.path.join("img", f"s{si}.webp")
        sheet.save(out, "WEBP", quality=QUALITY, method=6)
        total += os.path.getsize(out)

    print(f"{len(by_set)} bildeark, {total / 1e6:.1f} MB, {missing} kort uten bilde")


if __name__ == "__main__":
    main()
