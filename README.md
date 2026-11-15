# Innkjøpsportal for Pokémon-kort

Selgere søker opp kort, velger variant og tilstand og får en estimert utbetaling:
**TCGPlayer Market Price × 75 % (utbetaling) eller 80 % (innbytte) × tilstandstrekk × USD/NOK-kurs**.
Til slutt lager de en tilbudstekst som de sender deg.

## Filer

| Fil | Hva den gjør |
|---|---|
| `index.html` | Selve portalen. Innstillinger (satser, tilstandstrekk, bulkpriser, kontaktinfo) står i `CONFIG` øverst i skriptet. |
| `build_data.py` | Henter alle kort og priser fra tcgcsv.com (TCGPlayer-data) og kursen fra Norges Bank → `cards.json` |
| `build_images.py` | Laster ned kortbilder og lager ett bildeark per sett → `img/` |
| `make_site.py` | Setter sammen nettsiden i `_site/` |
| `.github/workflows/pages.yml` | Kjører alt over hver natt og publiserer på GitHub Pages |
| `google-apps-script/Code.gs` | Tar imot tilbud fra portalen, lagrer dem i Google Regneark og sender e-post |

`cards.json`, `img/` og `_site/` lages automatisk og ligger ikke i repoet.

## Oppsett med GitHub Desktop (én gang)

1. Installer GitHub Desktop fra <https://desktop.github.com> og logg inn med GitHub-kontoen din.
2. **File → Add local repository…** og velg denne mappa. Når den sier at mappa ikke er et repo, trykk **create a repository**, og deretter **Create repository**.
3. Trykk **Publish repository**. Fjern haken for **Keep this code private** (gratis GitHub Pages krever offentlig repo), og trykk **Publish**.
4. På github.com, i repoet: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. Gå til **Actions**-fanen, velg **Oppdater priser og publiser**, og trykk **Run workflow**. Første kjøring tar 10–15 minutter fordi alle bildene lastes ned.
6. Lenken til portalen står under **Settings → Pages**, typisk `https://<brukernavn>.github.io/<repo>/`.

## Daglig bruk

- **Priser** oppdateres av seg selv hver natt kl. 06/07 norsk tid.
- **Endringer i portalen:** rediger filene, og trykk i GitHub Desktop **Commit to main** og deretter **Push origin**. Siden publiseres på nytt innen et par minutter.

## Automatisk innsending (Google Regneark + e-post)

Når dette er satt opp, trykker selgeren **Send tilbudet**. Tilbudet lagres i et Google Regneark
(fanene «Tilbud» og «Kort», med varenummer per kort), og du får det på e-post til
kundeservice@pokenordic.no. Skriptet ligger i `google-apps-script/Code.gs`.

1. Gå til <https://sheets.google.com> og lag et nytt, tomt regneark. Kall det f.eks. «PokéNordic innkjøp».
2. I regnearket: **Utvidelser → Apps Script**.
3. Slett alt i `Code.gs` der, og lim inn hele innholdet fra `google-apps-script/Code.gs`. Trykk **Lagre** (diskettikonet).
4. Trykk **Distribuer → Ny distribusjon**. Velg tannhjulet ved «Velg type» → **Nettapp**.
   - **Kjør som:** Meg
   - **Hvem har tilgang:** Alle
   - Trykk **Distribuer**, og godkjenn tilgangene Google spør om (regneark og sende e-post).
     Får du «Google har ikke bekreftet denne appen», trykk **Avansert → Gå til … (utrygt)**. Det er ditt eget skript.
5. Kopier **nettapp-adressen** (slutter på `/exec`).
6. Lim adressen inn i `index.html` som `submitUrl: "https://script.google.com/macros/s/…/exec",` i `CONFIG`, og push med GitHub Desktop.

Tips:
- Fanene «Tilbud» og «Kort» lages automatisk ved første innsending. Kolonnen **Status** kan du bruke selv (mottatt, kontrollert, betalt, solgt).
- Vil du at selgeren skal få en kopi på e-post, sett `SEND_SELLER_COPY = true` øverst i skriptet. Kopien sendes fra Google-kontoen du satte opp skriptet med.
- Endrer du skriptet senere: **Distribuer → Administrer distribusjoner → rediger (blyant) → Versjon: Ny versjon → Distribuer**. Da beholder du samme adresse.
- Innsending virker bare på den offentlige nettsiden, ikke inne i Claude-visningen. Der får selgeren en tekst å kopiere i stedet.

## Kjøre lokalt

```
pip install pillow
python build_data.py
python build_images.py card_img_cache
python make_site.py
python -m http.server 8000 --directory _site
```

Åpne deretter <http://localhost:8000>.
