"""Laster produktene i en Shopify-CSV (fra lag_shopify_csv.py) rett inn i
Shopify-butikken via Admin API, med bildene fra produktbilder/.

lag_shopify_csv.py bruker dette automatisk. Du kan også kjøre det alene:
    python shopify_opplasting.py --sjekk                      test tilgangen
    python shopify_opplasting.py shopify-import/<fil>.csv     last opp en CSV

- Kort som ikke finnes fra før blir nye produkter (bilde, pris, lager,
  metafelt, kategori, SEO, temamalen «enkeltkort»), legges i samlingene i
  SAMLINGER og i seriesamlingen for settet («Hits - …» / «Reverse Holo - …»),
  og publiseres i nettbutikken.
- Kort der handle allerede finnes i butikken får lageret økt med antallet i
  CSV-en og legges i samlingene. Pris og tekst blir ikke endret.
- Handles som er lastet opp skrives i <fil>.csv.opplastet. Kjører du samme CSV
  på nytt, hoppes de over, så lageret ikke telles dobbelt.

Tilgang (én gang): se «Automatisk opplasting til Shopify» i README.md.
Nøklene står i shopify-tilgang.json, som ikke skal i repoet (.gitignore).
"""
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# ---------------------------------------------------------------- innstillinger
API_VERSJON = "2026-10"
TILGANGSFIL = "shopify-tilgang.json"
BILDEMAPPE = "produktbilder"
# Kategori i Shopifys taksonomi (vises som «Leker og spill > Spill > Kortspill»)
KATEGORI = "Toys & Games > Games > Card Games"
# Salgskanaler produktene publiseres i (navnet slik Shopify oppgir det)
SALGSKANALER = ["Online Store"]
# Temamal for nye produkter (templates/product.enkeltkort.json i temaet). "" = standard produktmal
TEMAMAL = "enkeltkort"
# Manuelle samlinger nye produkter legges i (tittelen slik den står i Shopify)
SAMLINGER = ["Alle Enkeltkort", "nylig-lagt-til"]
# Seriesamling per sett (Sword & Shield, Scarlet & Violet, Mega Evolution), brukes bare
# når samlingen finnes i butikken:
#   «Hits - <ekspansjon>»          for sjeldenhetene under og 30th Celebration-promoer
#   «Reverse Holo - <ekspansjon>»  for reverse holo-kort som ikke er hits
#   «Non Holo / Holo - <ekspansjon>» for resten (common, uncommon, rare, holo rare),
#                                  eller et av de andre navnene i VANLIG_PREFIKS
#   «<sjeldenhet> - <ekspansjon>»  hvis den finnes («Pikachu Rare - 30th Celebration»)
#   «<ekspansjon>»                 for eldre sett som ikke har slike samlinger (f.eks. «BREAKpoint»)
HITS = {"Double Rare", "Ultra Rare", "Illustration Rare", "Special Illustration Rare", "Hyper Rare",
        "Art Rare", "Super Rare", "Special Art Rare", "Shiny Rare", "Shiny Ultra Rare", "Mega Attack Rare",
        "Mega Hyper Rare", "Classic Collection", "Trainer Gallery", "Galarian Gallery", "Rare Holo V",
        "Holo Rare V", "Rare Holo VSTAR", "Holo Rare VSTAR", "Rare Holo VMAX", "Holo Rare VMAX",
        "Radiant Rare", "Rainbow Rare", "Secret Rare", "Amazing Rare", "Black White Rare"}
VANLIG_PREFIKS = ["Non Holo / Holo", "Common / Uncommon / Rare / Holo Rare",
                  "Common / Uncommon / Rare / Holo", "Common / Uncommon / Rare"]
# ------------------------------------------------------------------------------

TRENGER_TILGANG = {"write_products", "write_inventory", "read_locations",
                   "write_publications", "write_files"}

# «Google Shopping / …»-kolonnene i CSV-en er metafelt hos Google-appen
GOOGLE = {
    "Google Shopping / Google Product Category": "google_product_category",
    "Google Shopping / Gender": "gender",
    "Google Shopping / Age Group": "age_group",
    "Google Shopping / MPN": "mpn",
    "Google Shopping / Condition": "condition",
    "Google Shopping / Custom Product": "custom_product",
    "Google Shopping / Custom Label 0": "custom_label_0",
    "Google Shopping / Custom Label 1": "custom_label_1",
    "Google Shopping / Custom Label 2": "custom_label_2",
    "Google Shopping / Custom Label 3": "custom_label_3",
    "Google Shopping / Custom Label 4": "custom_label_4",
}
VEKTENHET = {"g": "GRAMS", "kg": "KILOGRAMS", "lb": "POUNDS", "oz": "OUNCES"}

MAL_TILGANG = {
    "butikk": "DIN-BUTIKK.myshopify.com",
    "client_id": "",
    "client_secret": "",
}


class Feil(Exception):
    pass


# ---------------------------------------------------------------- HTTP
def _http(url, data=None, headers=None, kan_gjenta=False, forsok=5):
    """kan_gjenta=True betyr at forespørselen trygt kan sendes på nytt ved
    serverfeil (spørringer). 429 gjentas alltid, da er ingenting utført."""
    for i in range(forsok):
        req = urllib.request.Request(url, data=data, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if i < forsok - 1 and (e.code == 429 or (kan_gjenta and e.code >= 500)):
                time.sleep(float(e.headers.get("Retry-After") or 2 ** (i + 1)))
                continue
            raise Feil(f"HTTP {e.code} fra {urllib.parse.urlparse(url).netloc}: {body[:400]}") from None
        except urllib.error.URLError as e:
            if kan_gjenta and i < forsok - 1:
                time.sleep(2 ** (i + 1))
                continue
            raise Feil(f"fikk ikke kontakt med {urllib.parse.urlparse(url).netloc}: {e.reason}") from None


def _multipart(felter, filnavn, data, mime):
    grense = uuid.uuid4().hex
    deler = [f'--{grense}\r\nContent-Disposition: form-data; name="{n}"\r\n\r\n{v}\r\n'.encode()
             for n, v in felter]
    deler.append(f'--{grense}\r\nContent-Disposition: form-data; name="file"; '
                 f'filename="{filnavn}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + data + b"\r\n")
    deler.append(f"--{grense}--\r\n".encode())
    return b"".join(deler), f"multipart/form-data; boundary={grense}"


# ---------------------------------------------------------------- tilgang
def les_tilgang():
    cfg = {}
    if os.path.exists(TILGANGSFIL):
        with open(TILGANGSFIL, encoding="utf-8-sig") as f:
            cfg = json.load(f)
    for nøkkel, env in (("butikk", "SHOPIFY_BUTIKK"), ("client_id", "SHOPIFY_CLIENT_ID"),
                        ("client_secret", "SHOPIFY_CLIENT_SECRET"),
                        ("access_token", "SHOPIFY_ACCESS_TOKEN")):
        if os.environ.get(env):
            cfg[nøkkel] = os.environ[env]
    butikk = (cfg.get("butikk") or "").strip()
    har_nøkler = cfg.get("access_token") or (cfg.get("client_id") and cfg.get("client_secret"))
    if not butikk or "DIN-BUTIKK" in butikk or not har_nøkler:
        if not os.path.exists(TILGANGSFIL):
            with open(TILGANGSFIL, "w", encoding="utf-8") as f:
                json.dump(MAL_TILGANG, f, indent=2)
                f.write("\n")
            raise Feil(f"Lagde {TILGANGSFIL}. Fyll inn butikkadressen, client_id og client_secret "
                       "(se README.md) og kjør igjen.")
        raise Feil(f"{TILGANGSFIL} mangler butikk, client_id eller client_secret.")
    butikk = re.sub(r"^https?://", "", butikk).strip("/").split("/")[0]
    if "." not in butikk:
        butikk += ".myshopify.com"
    if not butikk.endswith(".myshopify.com"):
        raise Feil(f"«butikk» må være adressen som slutter på .myshopify.com, ikke {butikk}")
    cfg["butikk"] = butikk
    return cfg


class Shopify:
    def __init__(self, cfg):
        self.butikk = cfg["butikk"]
        self.cfg = cfg
        self.token = cfg.get("access_token") or self._hent_token()

    def _hent_token(self):
        # «Client credentials grant»: for apper fra Dev Dashboard installert i egen butikk.
        # Tokenet varer i 24 timer, så vi henter et nytt hver kjøring.
        data = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": self.cfg["client_id"],
            "client_secret": self.cfg["client_secret"],
        }).encode()
        try:
            _, body = _http(f"https://{self.butikk}/admin/oauth/access_token", data,
                            {"Content-Type": "application/x-www-form-urlencoded",
                             "Accept": "application/json"})
        except Feil as e:
            raise Feil(f"Shopify godtok ikke client_id/client_secret ({e}). Sjekk at appen er "
                       "installert i butikken og at nøklene er riktige.") from None
        return json.loads(body)["access_token"]

    def gql(self, query, variables=None, kan_gjenta=None):
        if kan_gjenta is None:
            kan_gjenta = not query.lstrip().startswith("mutation")
        url = f"https://{self.butikk}/admin/api/{API_VERSJON}/graphql.json"
        payload = json.dumps({"query": query, "variables": variables or {}}).encode()
        headers = {"Content-Type": "application/json", "X-Shopify-Access-Token": self.token}
        for i in range(6):
            _, body = _http(url, payload, headers, kan_gjenta=kan_gjenta)
            svar = json.loads(body)
            errors = svar.get("errors")
            if errors and any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errors):
                time.sleep(2 + i * 2)  # ikke utført, trygt å prøve igjen
                continue
            if errors:
                raise Feil("; ".join(e.get("message", str(e)) for e in errors))
            return svar["data"]
        raise Feil("Shopify struper forespørslene (THROTTLED), prøv igjen om litt")


def _bruker_feil(resultat):
    feil = resultat.get("userErrors") or []
    if feil:
        raise Feil("; ".join(
            (".".join(str(x) for x in (e.get("field") or [])) + ": " if e.get("field") else "")
            + e["message"] for e in feil))


# ---------------------------------------------------------------- oppsett
class Butikk:
    """Slår opp det som er felles for alle produktene: lokasjon, salgskanaler,
    kategori og metafelt-typer."""

    def __init__(self, api):
        self.api = api
        d = api.gql("""{
          shop { name }
          currentAppInstallation { accessScopes { handle } }
          locations(first: 50) { nodes { id name } }
          metafieldDefinitions(first: 250, ownerType: PRODUCT) {
            nodes { namespace key type { name } }
          }
          taxonomy { categories(search: "Card Games", first: 25) { nodes { id fullName } } }
        }""")
        self.navn = d["shop"]["name"]
        self.tilganger = {s["handle"] for s in d["currentAppInstallation"]["accessScopes"]}
        lokasjoner = d["locations"]["nodes"]
        ønsket = (api.cfg.get("lokasjon") or "").strip().lower()
        valgt = [l for l in lokasjoner if l["name"].lower() == ønsket] if ønsket else lokasjoner
        if not valgt:
            raise Feil(f"fant ikke lokasjonen «{api.cfg.get('lokasjon')}» "
                       f"(har: {', '.join(l['name'] for l in lokasjoner)})")
        self.lokasjon = valgt[0]
        self.typer = {(m["namespace"], m["key"]): m["type"]["name"]
                      for m in d["metafieldDefinitions"]["nodes"]}
        self.kategori = next((c["id"] for c in d["taxonomy"]["categories"]["nodes"]
                              if c["fullName"] == KATEGORI), None)
        self.kanaler = self._kanaler()
        self.samlinger = self._samlinger()

    def _alle_samlinger(self):
        ut, etter = {}, None
        while True:
            d = self.api.gql("""query($e: String) { collections(first: 250, after: $e) {
              pageInfo { hasNextPage endCursor } nodes { id title ruleSet { appliedDisjunctively } } } }""",
                             {"e": etter})["collections"]
            for n in d["nodes"]:
                if not n["ruleSet"]:  # bare manuelle samlinger kan fylles
                    ut.setdefault(n["title"].strip().lower(), (n["id"], n["title"]))
            if not d["pageInfo"]["hasNextPage"]:
                return ut
            etter = d["pageInfo"]["endCursor"]

    def seriesamlinger(self, rad):
        """«Hits - <sett>» eller «Reverse Holo - <sett>» for kortet, hvis samlingen finnes."""
        if not hasattr(self, "_alle"):
            self._alle = self._alle_samlinger()
        felt = lambda nøkkel: next((v.strip() for k, v in rad.items()
                                    if k and k.endswith(f"(product.metafields.custom.{nøkkel})") and v), "")
        eksp, sjelden = felt("ekspansjon"), felt("sjeldenhet")
        variant = (rad.get("Google Shopping / Custom Label 4") or "").strip()
        if not eksp:
            return []
        finnes = lambda navn: navn.lower() in self._alle
        vanlige = [f"{p} - {eksp}" for p in VANLIG_PREFIKS]
        if sjelden == "Promo" and rad.get("Handle", "").endswith("-30th-celebration"):
            navn = "Hits - 30th Celebration"  # promoene med «(30th Celebration)»
        elif sjelden and finnes(f"{sjelden} - {eksp}"):
            navn = f"{sjelden} - {eksp}"  # egen samling for sjeldenheten («Pikachu Rare - 30th Celebration»)
        elif not any(finnes(n) for n in [f"Hits - {eksp}", f"Reverse Holo - {eksp}"] + vanlige):
            # Eldre sett uten Hits-/Reverse-samlinger: samlingen med settets navn («BREAKpoint»)
            navn = eksp
        elif sjelden in HITS:
            navn = f"Hits - {eksp}"
        elif variant.startswith("Reverse"):
            navn = f"Reverse Holo - {eksp}"
        else:  # common, uncommon, rare, holo rare
            navn = next((n for n in vanlige if finnes(n)), "")
        treff = self._alle.get(navn.lower())
        return [treff] if treff else []

    def _samlinger(self):
        ut = []
        for tittel in SAMLINGER:
            noder = self.api.gql("""query($q: String!) { collections(first: 10, query: $q) {
              nodes { id title ruleSet { appliedDisjunctively } } } }""",
                                 {"q": f"title:'{tittel}'"})["collections"]["nodes"]
            treff = [n for n in noder if n["title"].strip().lower() == tittel.strip().lower()]
            if not treff:
                raise Feil(f"fant ikke samlingen «{tittel}»")
            if treff[0]["ruleSet"]:
                raise Feil(f"«{tittel}» er en automatisk samling, den kan ikke fylles fra scriptet. "
                           "Fjern den fra SAMLINGER i shopify_opplasting.py")
            ut.append((treff[0]["id"], treff[0]["title"]))
        return ut

    def _kanaler(self):
        try:
            noder = self.api.gql("{ publications(first: 50) { nodes { id name } } }")["publications"]["nodes"]
            navn = {n["id"]: n["name"] for n in noder}
        except Feil:  # eldre/nyere API uten Publication.name
            noder = self.api.gql("{ publications(first: 50) { nodes { id catalog { title } } } }")["publications"]["nodes"]
            navn = {n["id"]: (n.get("catalog") or {}).get("title") or "" for n in noder}
        return [(pid, n) for pid, n in navn.items() if n in SALGSKANALER]

    def mangler(self):
        mangler = sorted(TRENGER_TILGANG - self.tilganger)
        # write_* gir også read_*, og write_files dekkes av write_products for produktbilder
        return [m for m in mangler if not (m == "write_files" and "write_products" in self.tilganger)]


# ---------------------------------------------------------------- per produkt
def _metafelt(header, rad, typer):
    ut, sett = [], set()
    for h in header:
        verdi = (rad.get(h) or "").strip()
        if not verdi:
            continue
        m = re.search(r"\(product\.metafields\.([^.)]+)\.([^)]+)\)$", h)
        if m:
            ns, key = m.groups()
        elif h in GOOGLE:
            ns, key = "mm-google-shopping", GOOGLE[h]
        else:
            continue
        # app--…, shopify.* (kategori-metafelt med metaobjekter) og shopify--… er reservert
        if ns.startswith("app--") or ns.startswith("shopify") or (ns, key) in sett:
            continue
        type_ = typer.get((ns, key), "single_line_text_field")
        if "reference" in type_:
            continue
        if type_ == "boolean":
            verdi = verdi.lower()
        elif type_.startswith("list.") and not verdi.startswith("["):
            verdi = json.dumps([v.strip() for v in verdi.split(",")], ensure_ascii=False)
        sett.add((ns, key))
        ut.append({"namespace": ns, "key": key, "type": type_, "value": verdi})
    return ut


def _last_opp_bilde(api, sti):
    data = open(sti, "rb").read()
    filnavn = os.path.basename(sti)
    mime = "image/png" if filnavn.lower().endswith(".png") else "image/jpeg"
    d = api.gql("""mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }""", {"input": [{"filename": filnavn, "mimeType": mime, "resource": "IMAGE",
                      "httpMethod": "POST", "fileSize": str(len(data))}]})["stagedUploadsCreate"]
    _bruker_feil(d)
    mål = d["stagedTargets"][0]
    body, ctype = _multipart([(p["name"], p["value"]) for p in mål["parameters"]], filnavn, data, mime)
    _http(mål["url"], body, {"Content-Type": ctype})
    return mål["resourceUrl"]


def _finnes(api, handle, lokasjon_id):
    d = api.gql("""query($handle: String!, $loc: ID!) {
      productByIdentifier(identifier: {handle: $handle}) {
        id title
        variants(first: 2) { nodes {
          inventoryItem { id inventoryLevel(locationId: $loc) {
            quantities(names: ["available"]) { name quantity }
          } }
        } }
      }
    }""", {"handle": handle, "loc": lokasjon_id})
    return d["productByIdentifier"]


def _øk_lager(api, produkt, antall, butikk):
    varianter = produkt["variants"]["nodes"]
    if len(varianter) != 1:
        raise Feil(f"«{produkt['title']}» har {len(varianter)} varianter, øk lageret manuelt")
    item = varianter[0]["inventoryItem"]
    nivå = item["inventoryLevel"]
    if not nivå:
        raise Feil(f"«{produkt['title']}» lagerføres ikke på {butikk.lokasjon['name']}, øk lageret manuelt")
    nå = next(q["quantity"] for q in nivå["quantities"] if q["name"] == "available")
    d = api.gql("""mutation($input: InventoryAdjustQuantitiesInput!, $key: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }""", {"key": str(uuid.uuid4()), "input": {
        "reason": "received", "name": "available",
        "changes": [{"inventoryItemId": item["id"], "locationId": butikk.lokasjon["id"],
                     "delta": antall, "changeFromQuantity": nå}]}})["inventoryAdjustQuantities"]
    _bruker_feil(d)
    return nå, nå + antall


def _legg_i_samling(api, samling_id, produkt_id):
    d = api.gql("""mutation($id: ID!, $p: [ID!]!) { collectionAddProducts(id: $id, productIds: $p) {
      userErrors { field message } } }""", {"id": samling_id, "p": [produkt_id]})["collectionAddProducts"]
    _bruker_feil(d)


def _nytt_produkt(api, header, rad, butikk, bildemappe):
    sant = lambda k: (rad.get(k) or "").strip().lower() == "true"
    handle, tittel = rad["Handle"], rad["Title"]
    status = (rad.get("Status") or "active").strip().upper()
    opt_navn = rad.get("Option1 Name") or "Title"
    opt_verdi = rad.get("Option1 Value") or "Default Title"

    filer = []
    if rad.get("Image Src"):
        sti = os.path.join(bildemappe, os.path.basename(urllib.parse.urlparse(rad["Image Src"]).path))
        if os.path.exists(sti):
            kilde = _last_opp_bilde(api, sti)
        else:  # bildet ligger ikke lokalt: la Shopify hente det fra adressen i CSV-en
            print(f"    fant ikke {sti}, bruker {rad['Image Src']}")
            kilde = rad["Image Src"]
        filer.append({"originalSource": kilde, "alt": rad.get("Image Alt Text") or tittel,
                      "contentType": "IMAGE"})

    gram = float(rad.get("Variant Grams") or 0)
    variant = {
        "optionValues": [{"optionName": opt_navn, "name": opt_verdi}],
        "inventoryPolicy": "CONTINUE" if rad.get("Variant Inventory Policy") == "continue" else "DENY",
        "taxable": sant("Variant Taxable"),
        "inventoryItem": {
            "sku": rad.get("Variant SKU") or None,
            "tracked": rad.get("Variant Inventory Tracker") == "shopify",
            "requiresShipping": sant("Variant Requires Shipping"),
            "measurement": {"weight": {"value": gram, "unit": "GRAMS"}},
        },
        "inventoryQuantities": [{"locationId": butikk.lokasjon["id"], "name": "available",
                                 "quantity": int(rad.get("Variant Inventory Qty") or 0)}],
    }
    if rad.get("Variant Price"):
        variant["price"] = rad["Variant Price"]
    if rad.get("Variant Compare At Price"):
        variant["compareAtPrice"] = rad["Variant Compare At Price"]

    inn = {
        "handle": handle,
        "title": tittel,
        "descriptionHtml": rad.get("Body (HTML)") or "",
        "vendor": rad.get("Vendor") or "",
        "productType": rad.get("Type") or "",
        "tags": [t.strip() for t in (rad.get("Tags") or "").split(",") if t.strip()],
        "status": status if status in ("ACTIVE", "DRAFT", "ARCHIVED") else "ACTIVE",
        "seo": {"title": rad.get("SEO Title") or tittel, "description": rad.get("SEO Description") or ""},
        "productOptions": [{"name": opt_navn, "values": [{"name": opt_verdi}]}],
        "variants": [variant],
        "files": filer,
    }
    if butikk.kategori:
        inn["category"] = butikk.kategori
    if TEMAMAL:
        inn["templateSuffix"] = TEMAMAL

    d = api.gql("""mutation($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id handle }
        userErrors { field message }
      }
    }""", {"input": inn})["productSet"]
    _bruker_feil(d)
    pid = d["product"]["id"]
    if d["product"]["handle"] != handle:
        print(f"    obs: Shopify ga produktet handle «{d['product']['handle']}»")

    advarsler = []
    metafelt = [dict(m, ownerId=pid) for m in _metafelt(header, rad, butikk.typer)]
    sett_mf = """mutation($m: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $m) { userErrors { field message } }
    }"""
    if metafelt:
        try:
            _bruker_feil(api.gql(sett_mf, {"m": metafelt})["metafieldsSet"])
        except Feil:  # alt-eller-ingenting: prøv én og én for å finne den som feiler
            for m in metafelt:
                try:
                    _bruker_feil(api.gql(sett_mf, {"m": [m]})["metafieldsSet"])
                except Feil as e:
                    advarsler.append(f"metafelt {m['namespace']}.{m['key']}: {e}")

    for sid, stittel in butikk.samlinger + butikk.seriesamlinger(rad):
        try:
            _legg_i_samling(api, sid, pid)
        except Feil as e:
            advarsler.append(f"samlingen «{stittel}»: {e}")

    if sant("Published"):
        if butikk.kanaler:
            d = api.gql("""mutation($id: ID!, $input: [PublicationInput!]!) {
              publishablePublish(id: $id, input: $input) { userErrors { field message } }
            }""", {"id": pid, "input": [{"publicationId": k} for k, _ in butikk.kanaler]})
            try:
                _bruker_feil(d["publishablePublish"])
            except Feil as e:
                advarsler.append(f"publisering: {e}")
        else:
            advarsler.append(f"fant ingen salgskanal som heter {', '.join(SALGSKANALER)}, "
                             "produktet er ikke publisert")
    return advarsler


# ---------------------------------------------------------------- hovedløp
def logg_sti(csv_sti):
    return csv_sti + ".opplastet"


def last_opp_csv(csv_sti, bildemappe=BILDEMAPPE):
    """Laster opp alle rader i CSV-en. Returnerer (handles som gikk bra, feilmeldinger)."""
    with open(csv_sti, encoding="utf-8-sig", newline="") as f:
        leser = csv.DictReader(f)
        header, rader = leser.fieldnames, [r for r in leser if r.get("Handle")]

    ferdige = set()
    if os.path.exists(logg_sti(csv_sti)):
        with open(logg_sti(csv_sti), encoding="utf-8") as f:
            ferdige = {l.strip() for l in f if l.strip()}

    api = Shopify(les_tilgang())
    butikk = Butikk(api)
    if butikk.mangler():
        raise Feil(f"appen mangler tilgangene {', '.join(butikk.mangler())}. Legg dem til i "
                   "Dev Dashboard, lag en ny versjon og godkjenn oppdateringen i butikken.")
    print(f"\nLaster opp til {butikk.navn} ({api.butikk}), lager på {butikk.lokasjon['name']}")
    if not butikk.kategori:
        print(f"  obs: fant ikke kategorien «{KATEGORI}», produktene får ingen kategori")

    ok, feil = set(), []
    for rad in rader:
        handle, tittel = rad["Handle"], rad["Title"]
        antall = int(rad.get("Variant Inventory Qty") or 0)
        if handle in ferdige:
            print(f"  {tittel}: lastet opp før, hopper over")
            ok.add(handle)
            continue
        try:
            finnes = _finnes(api, handle, butikk.lokasjon["id"])
            if finnes and antall <= 0:
                print(f"  {tittel}: fantes fra før, antall 0, ingenting endret")
            elif finnes:
                før, etter = _øk_lager(api, finnes, antall, butikk)
                print(f"  {tittel}: fantes fra før, lager {før} -> {etter}")
                # påfyll skal også inn i samlingene (f.eks. «nylig-lagt-til»)
                for sid, stittel in butikk.samlinger + butikk.seriesamlinger(rad):
                    try:
                        _legg_i_samling(api, sid, finnes["id"])
                    except Feil as e:
                        print(f"    advarsel: samlingen «{stittel}»: {e}")
            else:
                advarsler = _nytt_produkt(api, header, rad, butikk, bildemappe)
                print(f"  {tittel}: nytt produkt ({antall} stk)")
                for a in advarsler:
                    print(f"    advarsel: {a}")
            ok.add(handle)
            with open(logg_sti(csv_sti), "a", encoding="utf-8") as f:
                f.write(handle + "\n")
        except Exception as e:  # ett kort som feiler skal ikke stoppe resten
            feil.append(f"{tittel}: {e}")
    return ok, feil


def sjekk():
    api = Shopify(les_tilgang())
    b = Butikk(api)
    print(f"Butikk:      {b.navn} ({api.butikk})")
    print(f"Lokasjon:    {b.lokasjon['name']}")
    print(f"Salgskanal:  {', '.join(n for _, n in b.kanaler) or 'FANT INGEN (' + ', '.join(SALGSKANALER) + ')'}")
    print(f"Kategori:    {KATEGORI if b.kategori else 'FANT IKKE ' + KATEGORI}")
    print(f"Samlinger:   {', '.join(t for _, t in b.samlinger) or '-'}")
    print(f"Temamal:     {TEMAMAL or 'standard'}")
    print(f"Metafelt:    {len(b.typer)} definisjoner")
    print(f"Tilganger:   {'OK' if not b.mangler() else 'MANGLER ' + ', '.join(b.mangler())}")


def main():
    args = sys.argv[1:]
    try:
        if args == ["--sjekk"]:
            sjekk()
            return
        if len(args) != 1 or not os.path.exists(args[0]):
            sys.exit(__doc__)
        ok, feil = last_opp_csv(args[0])
    except Feil as e:
        sys.exit(f"Feil: {e}")
    print(f"\n{len(ok)} kort lastet opp.")
    if feil:
        print("\nFikk ikke lastet opp:")
        for f_ in feil:
            print("  " + f_)
        sys.exit(1)


if __name__ == "__main__":
    main()
