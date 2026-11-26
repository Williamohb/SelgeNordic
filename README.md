# Innkjøpsportal for Pokémon-kort

Selgere søker opp kort, velger variant og tilstand og får en estimert utbetaling:
**TCGPlayer Market Price × 78 % (utbetaling) eller 83 % (innbytte) × tilstandstrekk × USD/NOK-kurs**.
Til slutt lager de en tilbudstekst som de sender deg.

## Filer

| Fil | Hva den gjør |
|---|---|
| `index.html` | Selve portalen. Innstillinger (satser, tilstandstrekk, bulkpriser, kontaktinfo) står i `CONFIG` øverst i skriptet. |
| `build_data.py` | Henter alle engelske og japanske kort og priser fra tcgcsv.com (TCGPlayer-data) og kursen fra Norges Bank → `cards.json` og `cards-jp.json` |
| `build_images.py` | Laster ned kortbilder og lager ett bildeark per sett → `img/` (engelske) og `img-jp/` (japanske) |
| `build_setlogos.py` | Henter settlogoer fra pokemontcg.io til settoversikten → `setlogos/` og `setlogos.json` (engelske sett) |
| `make_site.py` | Setter sammen nettsiden i `_site/` |
| `forhandsvis.py` | Lokal forhåndsvisning på <http://localhost:8791> som laster siden på nytt når `index.html` endres |
| `.github/workflows/pages.yml` | Kjører alt over hver natt og publiserer på GitHub Pages |
| `google-apps-script/Code.gs` | Tar imot tilbud fra portalen, lagrer dem i Google Regneark og sender e-post |

`cards.json`, `cards-jp.json`, `img/`, `img-jp/` og `_site/` lages automatisk og ligger ikke i repoet.

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

## Nye kort i Shopify-butikken fra TCGplayer-lenker

Scriptene som lager og laster opp enkeltkort til Shopify har flyttet til **PNordic**-repoet
(`lag_shopify_csv.py` og `shopify_opplasting.py`). Mappa `produktbilder/` blir liggende her, fordi
eldre produkter og manuell CSV-import bruker bildeadressene `https://selg.pokenordic.no/produktbilder/…`.

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

## Endelig tilbud og kjøpsbevis

Det selgeren laster ned fra portalen, er bare en **foreløpig tilbudsoversikt**. Det ekte kjøpsbeviset
lages fra regnearket når du har kontrollert kortene, og selgeren signerer det elektronisk.

**Arbeidsflyt for hvert kjøp:**
1. Kortene kommer i posten. Kontroller dem.
2. I fanen **Kort**, på radene med referansen:
   - la **Tilstand** stå. Den viser hva selgeren oppga.
   - hver innsending har sin egen blå ramme, og annenhver innsending har lys blå bakgrunn.
   - kryss av **Kontrollert** for hvert kort du har sjekket. Velger du justert tilstand, krysses det av automatisk.
     Kontrollerte kort flyttes nederst i innsendingen og får grå tekst, så de som gjenstår, står øverst.
     For eldre rader: velg **PokéNordic → Ordne fanen Kort** én gang.
     Når du sender det endelige tilbudet, sier bekreftelsen fra hvor mange linjer som ikke er krysset av.
   - velg **Justert tilstand** (NM, LP, MP, HP, DMG) i nedtrekkslista der kortet er i en annen tilstand, og rett
     **Antall** der det trengs (for bulk er Antall = kg). **Pris/stk (kr)** og **Sum (kr)** regnes ut på nytt av seg
     selv: markedspris (USD) × kursen og satsen fra tilbudet × tilstandstrekket (japanske kort får den japanske satsen).
     Tømmer du Justert tilstand, går prisen tilbake til **Innsendt pris/stk (kr)**. Du kan også skrive Pris/stk selv.
     Trekkene står både i `index.html` og øverst i `Code.gs` (`TILSTAND_FAKTOR`, `JP_SATS`); endrer du dem, endre begge.
   - i e-posten med det endelige tilbudet står det «(du oppga NM)» ved kort med justert tilstand,
   - sett **Status** til `Avvist` på kort du ikke kjøper (de sendes tilbake).
3. I fanen **Tilbud**: klikk på raden til tilbudet.
4. Velg menyen **PokéNordic → Send endelig tilbud for valgt tilbud** og bekreft.
   - Selgeren får e-post med endelig pris, kjøpsbevis (PDF) og knappene **Godta og signer** / **Avslå**.
   - Kjøpsbeviset «til godkjenning» lagres i Google Drive-mappa **PokéNordic kjøpsbevis**.
5. Selgeren godtar ved å skrive inn fullt navn (og foresattes navn hvis under 18) og hvor pengene skal betales.
   - Status blir **Godtatt**, det signerte kjøpsbeviset lagres i samme mappe, og både du og selgeren får det på e-post.
   - E-posten til deg sier hva som skal betales og til hvilket Vipps-nummer eller kontonummer.
6. Når du har betalt: klikk på raden og velg **PokéNordic → Merk valgt tilbud som betalt**.
   Da kan kortene legges ut i nettbutikken (se «Nettbutikken» under).

Avslår selgeren, blir status **Avslått**, og du får e-post med adressen kortene skal sendes tilbake til.

**Oppdatere skriptet til denne versjonen (én gang):**
1. Lim inn hele den nye `google-apps-script/Code.gs` i Apps Script og trykk **Lagre**.
   Sjekk at `WEBAPP_URL` øverst er nettapp-adressen din (slutter på `/exec`). Lenkene til selgeren bruker den.
2. **Distribuer → Administrer distribusjoner → blyant → Versjon: Ny versjon → Distribuer.** Adressen blir den samme.
3. Google ber om nye tillatelser (Google Drive, for kjøpsbevisene). Godkjenn.
4. Last inn regnearket på nytt. Menyen **PokéNordic** dukker opp øverst.

## Sende e-post fra kundeservice@pokenordic.no

Skriptet sender fra adressen i `FROM_ADDRESS` (kundeservice@pokenordic.no), men bare når adressen er
godkjent som «Send e-post som» i Gmail-kontoen som eier skriptet. Ellers sendes det fra kontoens egen adresse.

1. Åpne Gmail med kontoen som eier regnearket og skriptet.
2. **Tannhjulet → Se alle innstillingene → Kontoer og import → Send e-post som → Legg til en annen e-postadresse.**
3. Navn: `PokéNordic`, e-post: `kundeservice@pokenordic.no`. La «Behandle som et alias» være avkrysset. Trykk **Neste trinn**.
4. Fyll inn SMTP-innstillingene fra den som leverer e-posten for pokenordic.no (server, port, brukernavn og passord for kundeservice-kontoen).
5. Gmail sender en bekreftelseskode til kundeservice@pokenordic.no. Lim den inn.
6. Lim inn den nye `Code.gs`, trykk **Lagre**, og distribuer **Ny versjon**. Godkjenn den nye Gmail-tillatelsen.

Fra da av kommer alle e-poster fra skriptet fra kundeservice@pokenordic.no.

## Utseende

Portalen ser ut som nettbutikken: samme toppstripe, meny, bunn, farger og skrift (butikkstilen, se `.butikkstil`
i `index.html`). Den gamle utgaven med egen logolinje og lys/mørk modus etter systemet finnes på
`selg.pokenordic.no/?stil=standard`.

## Portalen inne i nettbutikken (pokenordic.no/pages/selg)

Portalen kan vises som en side i Shopify-butikken, med butikkens meny og bunn rundt. Butikksiden laster
`https://selg.pokenordic.no/?i=butikk` i en ramme som fyller skjermen under menyen. Med `?i=butikk` skjuler
portalen sin egen logolinje og knappen «Til nettbutikken». Portalen oppdateres fortsatt bare her.

1. Shopify: **Nettbutikk → Temaer → Tilpass**. Velg **Sider** øverst, og **Opprett mal**. Kall den `selg` og baser den på standard sidemal.
2. I den nye malen: fjern seksjonen med sidens tittel og innhold, og **Legg til seksjon → Egendefinert Liquid**.
   Lim inn hele innholdet i `shopify/selg-side.liquid`. Sett topp- og bunnmarg på seksjonen til 0, og trykk **Lagre**.
3. **Nettbutikk → Sider → Legg til side**: tittel «Selg kort», nettadresse `selg`, og velg malen **selg** til høyre. Lagre.
4. Lim inn den nye `shopify/header.liquid` i temaet (Rediger kode → header). «Selg til oss» i menyen går da til `/pages/selg`.

`shopify/` ligger ikke i det offentlige repoet. selg.pokenordic.no virker fortsatt alene, for eksempel for lenker i Facebook-grupper.

## Nettbutikken: utlegging og avanse-logg

Når et tilbud er merket som betalt, legges kortene ut i Shopify fra fanen **Innkjøp** på PNordic-opplastingssiden,
uten mva (avansemetoden). Oppsett og regler står i README-en i PNordic («Innkjøpte kort (avansemetoden)»).

I regnearket gir det:
- kolonnene **Shopify** («Lagt ut» eller «Backlog»), **Shopify-info** og **Solgt** i fanen «Kort»,
- fanen **Avanse**: én rad per solgt avanse-kort (ordre, innkjøp, salg, avanse, mva 20 % av avansen, termin),
- fanen **Avanse per termin**: summene per mva-termin. «MVA å betale» er beløpet til mva-meldingen.

Nettbutikken snakker med regnearket gjennom nettappen, med en nøkkel du lager under
**PokéNordic → Nøkkel for nettbutikken (PNordic)**. Nøkkelen lagres i skriptets egenskaper, ikke i koden.

## Kjøre lokalt

```
pip install pillow
python build_data.py
python build_images.py card_img_cache
python build_images.py card_img_cache cards-jp.json img-jp
python make_site.py
python -m http.server 8000 --directory _site
```

Åpne deretter <http://localhost:8000>.
