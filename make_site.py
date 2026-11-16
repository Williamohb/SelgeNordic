"""Setter sammen nettsiden i _site/ for GitHub Pages.

index.html er skrevet uten <!doctype>/<head> (slik Claude-artifacts vil ha
den). Her pakkes den inn i et fullstendig HTML-dokument, og cards.json og
img/ og logo.webp kopieres ved siden av.

Kjør etter build_data.py og build_images.py:  python make_site.py
"""
import os
import shutil

HEAD = (
    '<!doctype html><html lang="nb"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);"
    "padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}"
    "img{max-width:100%}[hidden]{display:none!important}</style></head><body>"
)
FOOT = "</body></html>\n"


def main():
    shutil.rmtree("_site", ignore_errors=True)
    os.makedirs("_site")
    with open("index.html", encoding="utf-8") as f:
        page = f.read()
    with open(os.path.join("_site", "index.html"), "w", encoding="utf-8") as f:
        f.write(HEAD + page + FOOT)
    shutil.copy("cards.json", os.path.join("_site", "cards.json"))
    shutil.copy("logo.webp", os.path.join("_site", "logo.webp"))
    shutil.copytree("img", os.path.join("_site", "img"))
    # Produktbilder til Shopify-import (lages av lag_shopify_csv.py)
    if os.path.isdir("produktbilder"):
        shutil.copytree("produktbilder", os.path.join("_site", "produktbilder"))
    print("Nettsiden er klar i _site/")


if __name__ == "__main__":
    main()
