/**
 * PokéNordic innkjøp – mottak av tilbud, endelig tilbud og kjøpsbevis.
 *
 * 1. doPost: tar imot tilbud fra portalen, lagrer dem i fanene «Tilbud» og
 *    «Kort» og sender e-post til OWNER_EMAIL.
 * 2. Menyen «PokéNordic» i regnearket: når kortene er kontrollert, sender du
 *    det endelige tilbudet med kjøpsbevis (PDF) til selgeren.
 * 3. doGet: siden selgeren åpner fra e-posten for å godta (signere) eller
 *    avslå. Signert kjøpsbevis lagres i Google Drive.
 *
 * Oppsett og arbeidsflyt: se README.md i prosjektet.
 */

// ======== INNSTILLINGER ========
const OWNER_EMAIL = "kundeservice@pokenordic.no";  // her kommer tilbudene
const SEND_SELLER_COPY = true;   // true = selgeren får en bekreftelse på e-post når tilbudet er sendt inn
const SENDER_NAME = "PokéNordic innkjøp";
// Avsenderadresse på e-postene. Må være lagt til som «Send e-post som» i Gmail-kontoen som eier skriptet
// (se README). Er den ikke godkjent der ennå, sendes e-posten fra kontoens egen adresse som før.
const FROM_ADDRESS = "kundeservice@pokenordic.no";
const BUYER = {
  name: "PokeNordic Hornberg",
  orgnr: "936 651 623 MVA",
  address: "Vestneshaugen 35, 6390 Vestnes",
  phone: "+47 936 50 613"
};
const DRIVE_FOLDER = "PokéNordic kjøpsbevis";  // mappe i Google Drive for kjøpsbevis (lages automatisk)
// Den offentlige nettapp-adressen (…/exec). Brukes i lenkene til selgeren. Må være satt:
// når menyen kjøres fra regnearket, gir Google ellers en intern adresse som selgeren ikke kan åpne.
const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyOrUEZMHXJOSA4ucmxWsHVLEwqXFM5vXmBnRpMGjryA_JTpCKbX8BMdy7_Ds5n5PKBeg/exec";
const TZ = "Europe/Oslo";
// ===============================

const OFFER_HEADERS = [
  "Mottatt", "Referanse", "Status", "Selger", "Kontakt", "Adresse", "Postnr", "Poststed",
  "Under 18", "Foresatt", "Foresatt kontakt", "Oppgjør", "Sats", "Antall kort",
  "Estimert sum (kr)", "Alternativ sum (kr)", "USD/NOK", "Prisdato", "Kommentar"
];
// Kolonner som legges til automatisk når de trengs (også i regneark laget med eldre versjon)
const OFFER_EXTRA = ["Endelig sum (kr)", "Endelig tilbud sendt", "Token", "Signert av", "Signert tidspunkt", "Utbetaling til", "Kjøpsbevis",
  "Krever godkjenning", "Sporing"];
// Statusene i fanen «Tilbud», i rekkefølge. Selgeren ser dem på statussiden i portalen (se del 5).
const STATUSER = ["Ny", "Venter på godkjenning", "Godkjent", "Under transport", "Mottatt", "Endelig tilbud sendt", "Godtatt", "Avslått", "Betalt"];
const PORTAL_URL = "https://selg.pokenordic.no";  // statussiden: PORTAL_URL + "/?ref=REF#status"
const CARD_HEADERS = [
  "Mottatt", "Referanse", "Varenr", "Kort", "Sett", "Nummer", "Variant", "Tilstand",
  "Antall", "Markedspris (USD)", "Pris/stk (kr)", "Sum (kr)", "TCGPlayer-ID", "Status"
];
// «Tilstand» er det selgeren oppga. «Justert tilstand» fyller du inn når du kontrollerer kortet;
// da regnes «Pris/stk (kr)» automatisk ut på nytt (se onEdit).
// «Kontrollert» er en avkrysningsboks du bruker for å holde styr på hvilke kort du har sjekket.
const CARD_EXTRA = ["Kontrollert", "Justert tilstand", "Innsendt pris/stk (kr)"];

/* ======================================================================
   1. Mottak av tilbud fra portalen
   ====================================================================== */

function doPost(e) {
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (d.api) return api_(d);  // nettbutikken (PNordic), se del 4
    if (d.handling === "status") return statusOppslag_(d);  // statussiden i portalen, se del 5
    if (d.handling === "sendt") return pakkeSendt_(d);
    if (d.website) return json_({ ok: true, ref: d.ref }); // honningfelle mot roboter
    validate_(d);

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const offers = sheet_(ss, "Tilbud", OFFER_HEADERS);
      const cards = sheet_(ss, "Kort", CARD_HEADERS);
      const now = new Date();
      const s = d.seller;
      offers.appendRow([
        now, d.ref, d.needsApproval ? "Venter på godkjenning" : "Ny", s.name, s.contact, s.street, s.zip, s.city,
        s.minor ? "Ja" : "Nei", s.guardianName || "", s.guardianContact || "",
        d.modeName, d.rate, d.count, d.total, d.altTotal, d.usdNok, d.pricesDate, s.note || ""
      ].map(safe_));
      setOffer_(ss, offers.getLastRow(), { "Krever godkjenning": d.needsApproval ? "Ja" : "Nei" });
      const rows = d.lines.map((l) => [
        now, d.ref, l.nr, l.name, l.set, l.number, l.variant, l.cond,
        l.qty, l.usd, l.each, l.sum, l.tcgId, "Ny"
      ].map(safe_));
      if (rows.length) {
        const start = cards.getLastRow() + 1;
        cards.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
        // Ta vare på prisen selgeren fikk oppgitt, og gi «Justert tilstand» en nedtrekksliste
        const c = cols_(cards, CARD_EXTRA);
        cards.getRange(start, c["Innsendt pris/stk (kr)"], rows.length, 1).setValues(d.lines.map((l) => [l.each]));
        condValidation_(cards.getRange(start, c["Justert tilstand"], rows.length, 1));
        checkbox_(cards.getRange(start, c["Kontrollert"], rows.length, 1));
        cards.getRange(start, c["Kontrollert"], rows.length, 1).setValues(rows.map(() => [false]));
        // Gi den nye innsendingen sin egen ramme og farge
        try { formatRef_(cards, c, d.ref); } catch (fmtErr) {}
      }
    } finally {
      lock.releaseLock();
    }

    sendMail_({
      to: OWNER_EMAIL,
      subject: (d.needsApproval ? "⚠ KREVER GODKJENNING – " : "") + "Nytt tilbud #" + d.ref + " – " + d.seller.name + " – " + kr_(d.total) + " (" + d.modeName.toLowerCase() + ")",
      htmlBody: mailHtml_(d, true),
      replyTo: isEmail_(d.seller.contact) ? d.seller.contact : OWNER_EMAIL,
      name: SENDER_NAME
    });
    if (SEND_SELLER_COPY && isEmail_(d.seller.contact)) {
      sendMail_({
        to: d.seller.contact,
        subject: "Vi har mottatt tilbudet ditt #" + d.ref,
        htmlBody: mailHtml_(d, false),
        replyTo: OWNER_EMAIL,
        name: SENDER_NAME
      });
    }
    return json_({ ok: true, ref: d.ref });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ======================================================================
   2. Meny i regnearket: send endelig tilbud
   ====================================================================== */

function condValidation_(range) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(TILSTAND_FAKTOR), true)
    .setAllowInvalid(false)
    .setHelpText("Velg tilstanden du fant ved kontroll. Pris/stk regnes ut på nytt. Tøm feltet for å gå tilbake til innsendt tilstand.")
    .build();
  range.setDataValidation(rule);
}

// Avkrysningsboks som ikke endrer verdier som allerede står der
function checkbox_(range) {
  range.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

function num_(x) {
  return Number(String(x == null ? "" : x).replace(/\s/g, "").replace(",", ".")) || 0;
}

/* ---------- Fanen «Kort»: én ramme per innsending, og sortering etter «Kontrollert» ---------- */

const GROUP_COLORS = ["#FFFFFF", "#EEF4FD"];  // annenhver innsending får lys blå bakgrunn
const GROUP_BORDER = "#1E6FDA";
const CHECKED_FONT = "#8A94A6";               // kontrollerte kort vises med grå tekst
const NORMAL_FONT = "#0F1A2E";

// Sammenhengende rader med samme referanse = én innsending
function groups_(sh, c) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const refs = sh.getRange(2, c["Referanse"], last - 1, 1).getValues().map((r) => String(r[0]));
  const out = [];
  refs.forEach((ref, i) => {
    const row = i + 2;
    const prev = out[out.length - 1];
    if (prev && prev.ref === ref) prev.last = row;
    else if (ref) out.push({ ref: ref, first: row, last: row, index: out.length });
  });
  return out;
}

function formatGroup_(sh, c, g) {
  const n = g.last - g.first + 1, w = sh.getLastColumn();
  const range = sh.getRange(g.first, 1, n, w);
  const checked = sh.getRange(g.first, c["Kontrollert"], n, 1).getValues().map((r) => r[0] === true);
  range.setBackgrounds(checked.map(() => new Array(w).fill(GROUP_COLORS[g.index % 2])));
  range.setFontColors(checked.map((ok) => new Array(w).fill(ok ? CHECKED_FONT : NORMAL_FONT)));
  range.setBorder(true, true, true, true, false, false, GROUP_BORDER, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

function formatRef_(sh, c, ref) {
  groups_(sh, c).filter((g) => g.ref === ref).forEach((g) => formatGroup_(sh, c, g));
}

// Ukontrollerte kort øverst i innsendingen, kontrollerte nederst (ellers i varenummer-rekkefølge)
function sortRef_(sh, c, ref) {
  groups_(sh, c).filter((g) => g.ref === ref).forEach((g) => {
    const n = g.last - g.first + 1;
    if (n < 2) return;
    const box = sh.getRange(g.first, c["Kontrollert"], n, 1);
    box.setValues(box.getValues().map((r) => [r[0] === true]));  // tomme bokser = false, så de sorteres riktig
    sh.getRange(g.first, 1, n, sh.getLastColumn()).sort([
      { column: c["Kontrollert"], ascending: true },
      { column: c["Varenr"], ascending: true }
    ]);
  });
}

// Menyvalg: rydd hele fanen (sorter alle innsendinger og gi dem ramme og farge)
function tidyCards() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Kort");
  if (!sh || sh.getLastRow() < 2) return;
  const c = cols_(sh, CARD_EXTRA);
  checkbox_(sh.getRange(2, c["Kontrollert"], sh.getLastRow() - 1, 1));
  const refs = [...new Set(groups_(sh, c).map((g) => g.ref))];
  refs.forEach((ref) => sortRef_(sh, c, ref));
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).setBorder(false, false, false, false, false, false);
  groups_(sh, c).forEach((g) => formatGroup_(sh, c, g));
}

function onOpen() {
  // Sørg for at fanen Kort har de nye kolonnene og nedtrekkslista (også for eldre regneark)
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Kort");
    if (sh && sh.getLastRow() >= 2) {
      const c = cols_(sh, CARD_EXTRA);
      condValidation_(sh.getRange(2, c["Justert tilstand"], sh.getLastRow() - 1, 1));
      checkbox_(sh.getRange(2, c["Kontrollert"], sh.getLastRow() - 1, 1));
    }
  } catch (err) {}
  // Nedtrekksliste med statusene i fanen Tilbud (andre verdier er fortsatt lov)
  try {
    const t = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Tilbud");
    if (t && t.getLastRow() >= 2) {
      const tc = cols_(t, OFFER_EXTRA);
      t.getRange(2, tc["Status"], t.getLastRow() - 1, 1)
        .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSER, true).setAllowInvalid(true).build());
    }
  } catch (err) {}
  SpreadsheetApp.getUi()
    .createMenu("PokéNordic")
    .addItem("Godkjenn valgt innsending (kan sendes)", "approveOffer")
    .addItem("Merk valgt tilbud som mottatt", "markReceived")
    .addItem("Send endelig tilbud for valgt tilbud", "sendFinalOffer")
    .addItem("Merk valgt tilbud som betalt", "markPaid")
    .addSeparator()
    .addItem("Ordne fanen Kort (ramme og sortering)", "tidyCards")
    .addItem("Nøkkel for nettbutikken (PNordic)", "makeApiKey")
    .addItem("Slik fungerer det", "showHelp")
    .addToUi();
}

/* Tilstandstrekk og japanske satser, samme som CONFIG i index.html. Endrer du dem der, endre dem her også. */
const TILSTAND_FAKTOR = { NM: 1.00, LP: 0.80, MP: 0.60, HP: 0.45, DMG: 0.25 };
const TILSTAND_KODE = { "near mint": "NM", "lightly played": "LP", "moderately played": "MP", "heavily played": "HP", "damaged": "DMG" };
const JP_SATS = { "Utbetaling": 0.72, "Innbytte": 0.80 };

// «Tilstand» = det selgeren oppga (rør den ikke). «Justert tilstand» = det du fant ved kontroll.
// Når du endrer Justert tilstand, Antall eller Pris/stk i fanen «Kort», regnes Pris/stk og Sum ut på nytt:
//   Pris/stk = markedspris (USD) × kurs × sats × tilstandstrekk for justert tilstand,
// med kursen og satsen fra tilbudet (japanske kort får den japanske satsen).
// Tømmer du Justert tilstand, går prisen tilbake til innsendt pris. Bulk (per kg) får bare ny Sum.
// Pris/stk du skriver selv, beholdes til du endrer justert tilstand igjen.
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== "Kort") return;
    const c = cols_(sh, CARD_EXTRA);
    const fra = e.range.getColumn(), til = e.range.getLastColumn();
    const berørt = (h) => c[h] && c[h] >= fra && c[h] <= til;
    const nyTilstand = berørt("Justert tilstand");
    const kontroll = berørt("Kontrollert");
    if (!nyTilstand && !kontroll && !berørt("Antall") && !berørt("Pris/stk (kr)")) return;
    const ss = sh.getParent();
    const tilbud = {};
    const sortRefs = new Set();  // innsendinger som skal sorteres og få ny farge etterpå
    const r1 = Math.max(2, e.range.getRow()), r2 = e.range.getLastRow();
    if (r2 < r1) return;
    const data = sh.getRange(r1, 1, r2 - r1 + 1, sh.getLastColumn()).getValues();
    data.forEach((r, i) => {
      const rad = r1 + i;
      const g = (h) => r[c[h] - 1];
      const ref = String(g("Referanse"));
      if (!ref) return;
      let each = num_(g("Pris/stk (kr)"));
      const bulk = String(g("Variant")) === "per kg";

      if (nyTilstand && !bulk) {
        // Ta vare på innsendt pris første gang (også for rader fra før denne versjonen)
        let innsendt = g("Innsendt pris/stk (kr)");
        if (innsendt === "" || innsendt === null) {
          innsendt = each;
          sh.getRange(rad, c["Innsendt pris/stk (kr)"]).setValue(innsendt);
        }
        const kode = tilstandKode_(g("Justert tilstand"));
        if (!kode) {
          each = num_(innsendt);  // tømt felt = tilbake til innsendt pris
        } else {
          const usd = num_(g("Markedspris (USD)"));
          if (!(ref in tilbud)) {
            const rowNum = findOfferRow_(ss, ref);
            const ts = ss.getSheetByName("Tilbud"), tc = cols_(ts, []);
            const v = rowNum ? ts.getRange(rowNum, 1, 1, ts.getLastColumn()).getValues()[0] : null;
            tilbud[ref] = v ? { kurs: num_(v[tc["USD/NOK"] - 1]), sats: num_(v[tc["Sats"] - 1]), modus: String(v[tc["Oppgjør"] - 1]) } : null;
          }
          const o = tilbud[ref];
          if (usd > 0 && o && o.kurs > 0 && o.sats > 0) {
            const japansk = /\(japansk\)\s*$/i.test(String(g("Sett")));
            const sats = japansk && JP_SATS[o.modus] ? JP_SATS[o.modus] : o.sats;
            each = round2_(usd * sats * TILSTAND_FAKTOR[kode] * o.kurs);
          } else {
            // mangler markedspris eller tilbudsdata: skaler innsendt pris med forholdet mellom tilstandene
            const fraKode = tilstandKode_(g("Tilstand")) || (/usikker/i.test(String(g("Tilstand"))) ? "LP" : "");  // «Usikker» er priset som LP
            if (fraKode) each = round2_(num_(innsendt) * TILSTAND_FAKTOR[kode] / TILSTAND_FAKTOR[fraKode]);
          }
        }
        sh.getRange(rad, c["Pris/stk (kr)"]).setValue(each);
        if (kode) {
          sh.getRange(rad, c["Kontrollert"]).setValue(true);  // justert tilstand = kortet er sjekket
          sortRefs.add(ref);
        }
      }
      if (kontroll) sortRefs.add(ref);
      sh.getRange(rad, c["Sum (kr)"]).setValue(round2_(num_(g("Antall")) * each));
    });
    // Kontrollerte kort flyttes nederst i innsendingen og blir grå
    sortRefs.forEach((ref) => { sortRef_(sh, c, ref); formatRef_(sh, c, ref); });
  } catch (err) {
    // en feil her skal aldri stoppe redigeringen i regnearket
  }
}

// «LP», «lp» eller «Lightly Played» -> «LP». Ukjent eller tomt -> "".
function tilstandKode_(t) {
  const s = String(t == null ? "" : t).trim();
  if (!s) return "";
  if (TILSTAND_FAKTOR[s.toUpperCase()] != null) return s.toUpperCase();
  return TILSTAND_KODE[s.toLowerCase()] || "";
}

function showHelp() {
  SpreadsheetApp.getUi().alert(
    "Slik sender du endelig tilbud",
    "1. Kontroller kortene.\n" +
    "2. I fanen «Kort»: la «Tilstand» stå (det selgeren oppga). Velg «Justert tilstand» (NM, LP, MP, HP, DMG) der kortet er annerledes, og rett Antall der det trengs. " +
    "Pris/stk og Sum regnes ut på nytt av seg selv; du kan også skrive Pris/stk selv. Tøm Justert tilstand for å gå tilbake til innsendt pris. " +
    "Kort du ikke kjøper, får Status «Avvist».\n" +
    "3. I fanen «Tilbud»: klikk på raden til tilbudet.\n" +
    "4. Velg PokéNordic → «Send endelig tilbud for valgt tilbud».\n\n" +
    "Selgeren får e-post med kjøpsbevis og en lenke for å godta eller avslå. " +
    "Når selgeren godtar, lagres det signerte kjøpsbeviset i Google Drive-mappa «" + DRIVE_FOLDER + "», og du får e-post om hvor pengene skal betales.",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function sendFinalOffer() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  if (sh.getName() !== "Tilbud") { ui.alert("Gå til fanen «Tilbud» og klikk på raden til tilbudet først."); return; }
  const rowNum = sh.getActiveRange().getRow();
  if (rowNum < 2) { ui.alert("Klikk på raden til tilbudet du vil sende (ikke overskriften)."); return; }

  const offer = readOffer_(ss, rowNum);
  if (!offer.ref) { ui.alert("Fant ingen referanse på denne raden."); return; }
  if (["Godtatt", "Betalt"].indexOf(offer.status) >= 0) { ui.alert("Tilbud #" + offer.ref + " er allerede " + offer.status.toLowerCase() + "."); return; }
  if (!isEmail_(offer.contact)) { ui.alert("Selgeren har ingen gyldig e-postadresse: " + offer.contact); return; }

  const lines = readLines_(ss, offer.ref, true);
  if (!lines.length) { ui.alert("Fant ingen kort for #" + offer.ref + " i fanen «Kort» (eller alle er avvist)."); return; }
  const total = round2_(lines.reduce((s, l) => s + l.sum, 0));

  // «Usikker»: selgeren lot oss vurdere tilstanden. Da må Justert tilstand være satt før tilbudet går ut.
  const uvurdert = lines.filter((l) => !l.bulk && !tilstandKode_(l.cond));
  if (uvurdert.length) {
    ui.alert("Tilstanden mangler",
      uvurdert.length + " kort har tilstand «" + uvurdert[0].cond + "» og må vurderes først:\n\n" +
      uvurdert.slice(0, 15).map((l) => "• " + l.nr + " " + l.name).join("\n") + (uvurdert.length > 15 ? "\n…" : "") +
      "\n\nVelg Justert tilstand (NM, LP, MP, HP, DMG) på dem i fanen «Kort», og send igjen.", ui.ButtonSet.OK);
    return;
  }

  const unchecked = lines.filter((l) => !l.checked).length;
  const answer = ui.alert(
    "Send endelig tilbud #" + offer.ref + "?",
    offer.name + " (" + offer.contact + ")\n" +
    lines.length + " linjer · " + offer.mode + "\n" +
    "Estimert: " + kr_(offer.estimate) + "\nEndelig: " + kr_(total) + "\n\n" +
    (unchecked ? "⚠ " + unchecked + " av " + lines.length + " linjer er ikke krysset av som kontrollert.\n\n" : "✓ Alle linjene er kontrollert.\n\n") +
    "Selgeren får e-post med kjøpsbevis og lenke for å godta eller avslå.",
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;

  const token = offer.token || Utilities.getUuid();
  const pdf = receiptPdf_(offer, lines, total, null);
  const file = folder_().createFile(pdf);

  setOffer_(ss, rowNum, {
    "Status": "Endelig tilbud sendt",
    "Endelig sum (kr)": total,
    "Endelig tilbud sendt": new Date(),
    "Token": token,
    "Kjøpsbevis": file.getUrl()
  });

  const base = WEBAPP_URL;
  const link = (a) => base + "?a=" + a + "&ref=" + encodeURIComponent(offer.ref) + "&t=" + encodeURIComponent(token);
  sendMail_({
    to: offer.contact,
    subject: "Endelig tilbud #" + offer.ref + " fra PokéNordic – " + kr_(total),
    htmlBody: finalOfferMail_(offer, lines, total, link("godta"), link("avsla")),
    attachments: [pdf],
    replyTo: OWNER_EMAIL,
    name: SENDER_NAME
  });
  ui.alert("Sendt til " + offer.contact + ".\nKjøpsbeviset (til godkjenning) ligger i Google Drive-mappa «" + DRIVE_FOLDER + "».");
}

function markPaid() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  if (sh.getName() !== "Tilbud") { ui.alert("Gå til fanen «Tilbud» og klikk på raden først."); return; }
  const rowNum = sh.getActiveRange().getRow();
  if (rowNum < 2) return;
  const offer = readOffer_(ss, rowNum);
  if (offer.status !== "Godtatt") { ui.alert("Bare godtatte tilbud kan merkes som betalt. Status nå: " + offer.status); return; }
  setOffer_(ss, rowNum, { "Status": "Betalt" });
  ui.alert("Tilbud #" + offer.ref + " er merket som betalt.\n\nKortene kan nå lastes opp fra fanen «Innkjøp» på PNordic-opplastingssiden.");
}

/* ======================================================================
   5. Status på innsendingen (statussiden i portalen) og nye menyvalg
   ====================================================================== */
// Selgeren slår opp innsendingen med referanse + e-postadressen fra innsendingen. Svaret har ingen
// personopplysninger utover det selgeren selv sendte inn. Statusflyten:
//   Venter på godkjenning -> Godkjent -> (selgeren trykker «Jeg har sendt pakken») Under transport -> Mottatt
//   -> Endelig tilbud sendt -> Godtatt -> Betalt          (uten godkjenning starter den på «Ny»)
const statusLenke_ = (ref) => PORTAL_URL + "/?ref=" + encodeURIComponent(ref) + "#status";

function finnInnsending_(ss, d) {
  const ref = String(d.ref || "").trim().toUpperCase().replace(/^#/, "");
  const epost = String(d.e || "").trim().toLowerCase();
  if (!/^[A-Z0-9]{5}$/.test(ref) || !epost) return null;
  const rowNum = findOfferRow_(ss, ref);
  const o = rowNum ? readOffer_(ss, rowNum) : null;
  return o && o.contact.toLowerCase() === epost ? o : null;
}

function statusOppslag_(d) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const o = finnInnsending_(ss, d);
  if (!o) {
    Utilities.sleep(500);  // gjør det tregt å prøve mange referanser
    return json_({ ok: false, error: "Fant ingen innsending med denne referansen og e-postadressen. Sjekk at begge er skrevet riktig." });
  }
  const endelig = ["Endelig tilbud sendt", "Godtatt", "Betalt", "Avslått"].indexOf(o.status) >= 0;
  return json_({
    ok: true, ref: o.ref, status: o.status, needsApproval: o.needsApproval, tracking: o.tracking, mode: o.mode,
    received: o.received instanceof Date ? Utilities.formatDate(o.received, TZ, "dd.MM.yyyy") : String(o.received || ""),
    estimate: o.estimate, finalTotal: endelig ? o.finalTotal : 0, final: endelig,
    shipTo: { name: BUYER.name, address: BUYER.address, phone: BUYER.phone },
    lines: statusLinjer_(ss, o.ref, endelig)
  });
}

// Kortene i innsendingen. Før det endelige tilbudet vises det selgeren oppga (tilstand og innsendt pris), så
// kontrollen ikke vises halvferdig; etterpå justert tilstand, endelig pris og kort vi ikke kjøper.
function statusLinjer_(ss, ref, endelig) {
  const sh = ss.getSheetByName("Kort");
  if (!sh || sh.getLastRow() < 2) return [];
  const c = cols_(sh, []);
  const out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach((r) => {
    const g = (h) => (c[h] ? r[c[h] - 1] : "");
    if (String(g("Referanse")) !== String(ref)) return;
    const bulk = String(g("Variant")) === "per kg";
    const given = String(g("Tilstand")), adjusted = bulk ? "" : String(g("Justert tilstand") || "").trim();
    const qty = num_(g("Antall"));
    const innsendt = g("Innsendt pris/stk (kr)") === "" ? num_(g("Pris/stk (kr)")) : num_(g("Innsendt pris/stk (kr)"));
    const each = endelig ? num_(g("Pris/stk (kr)")) : innsendt;
    out.push({
      nr: String(g("Varenr")), name: String(g("Kort")), set: String(g("Sett")), number: String(g("Nummer")), variant: String(g("Variant")),
      givenCond: given, cond: endelig && adjusted ? adjusted : given, changed: endelig && !!adjusted && adjusted.toUpperCase() !== given.toUpperCase(),
      qty: qty, each: each, sum: round2_(qty * each), bulk: bulk, rejected: endelig && /avvist/i.test(String(g("Status")))
    });
  });
  return out;
}

// «Jeg har sendt pakken» på statussiden: status Under transport, med sporingsnummer hvis selgeren oppga det
function pakkeSendt_(d) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const o = finnInnsending_(ss, d);
    if (!o) return json_({ ok: false, error: "Fant ingen innsending med denne referansen og e-postadressen." });
    if (o.status === "Venter på godkjenning") return json_({ ok: false, error: "Vent med å sende til vi har godkjent innsendingen. Du får e-post fra oss." });
    if (["Ny", "Godkjent"].indexOf(o.status) < 0) return json_({ ok: true, status: o.status });
    const sporing = String(d.tracking || "").trim().slice(0, 60);
    setOffer_(ss, o.row, { "Status": "Under transport", "Sporing": safe_(sporing) });
    sendMail_({ to: OWNER_EMAIL, subject: "📦 Pakke sendt – tilbud #" + o.ref + " – " + o.name, name: SENDER_NAME,
      htmlBody: "<p>" + esc_(o.name) + " har sendt kortene for tilbud #" + esc_(o.ref) + ".</p>" +
        (sporing ? "<p>Sporingsnummer: <b>" + esc_(sporing) + "</b></p>" : "<p>Ingen sporingsnummer oppgitt.</p>") +
        "<p>Velg PokéNordic → «Merk valgt tilbud som mottatt» når pakken kommer.</p>" });
    return json_({ ok: true, status: "Under transport" });
  } finally {
    lock.releaseLock();
  }
}

// Menyvalg: tilbud som ventet på godkjenning, kan sendes. Selgeren får e-post med adressen.
function approveOffer() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  if (sh.getName() !== "Tilbud") { ui.alert("Gå til fanen «Tilbud» og klikk på raden først."); return; }
  const rowNum = sh.getActiveRange().getRow();
  if (rowNum < 2) return;
  const o = readOffer_(ss, rowNum);
  if (o.status !== "Venter på godkjenning") { ui.alert("Bare tilbud som venter på godkjenning, kan godkjennes. Status nå: " + o.status); return; }
  if (ui.alert("Godkjenne tilbud #" + o.ref + "?", o.name + " får e-post om at kortene kan sendes.", ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  setOffer_(ss, rowNum, { "Status": "Godkjent" });
  if (isEmail_(o.contact)) {
    sendMail_({ to: o.contact, subject: "Du kan nå sende kortene – tilbud #" + o.ref, replyTo: OWNER_EMAIL, name: SENDER_NAME,
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111"><p>Hei ' + esc_(o.name) + "!</p>" +
        "<p>Vi har gått gjennom tilbud <b>#" + esc_(o.ref) + "</b>, og du kan nå sende kortene til oss med Posten. Legg ved en lapp med referansen.</p>" +
        '<p style="background:#F2F6FC;border:1px solid #D6DFEC;padding:10px 12px;border-radius:6px"><b>Send til:</b><br>' + esc_(BUYER.name) + "<br>" +
        esc_(BUYER.address).replace(", ", "<br>") + (BUYER.phone ? "<br>" + esc_(BUYER.phone) : "") + "</p>" +
        '<p>Følg innsendingen og trykk «Jeg har sendt pakken» når den er sendt: <a href="' + statusLenke_(o.ref) + '">' + statusLenke_(o.ref) + "</a></p>" +
        "<p>Hilsen PokéNordic</p></div>" });
  }
  ui.alert("Tilbud #" + o.ref + " er godkjent" + (isEmail_(o.contact) ? ", og " + o.contact + " har fått e-post." : "."));
}

// Menyvalg: pakken har kommet. Selgeren ser «under kontroll (1–3 virkedager)» på statussiden og får e-post.
function markReceived() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  if (sh.getName() !== "Tilbud") { ui.alert("Gå til fanen «Tilbud» og klikk på raden først."); return; }
  const rowNum = sh.getActiveRange().getRow();
  if (rowNum < 2) return;
  const o = readOffer_(ss, rowNum);
  if (["Ny", "Venter på godkjenning", "Godkjent", "Under transport"].indexOf(o.status) < 0) {
    ui.alert("Tilbud #" + o.ref + " har status «" + o.status + "», så det kan ikke merkes som mottatt."); return;
  }
  setOffer_(ss, rowNum, { "Status": "Mottatt" });
  if (isEmail_(o.contact)) {
    sendMail_({ to: o.contact, subject: "Vi har mottatt kortene dine – tilbud #" + o.ref, replyTo: OWNER_EMAIL, name: SENDER_NAME,
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111"><p>Hei ' + esc_(o.name) + "!</p>" +
        "<p>Pakken med kortene for tilbud <b>#" + esc_(o.ref) + "</b> har kommet fram. Vi kontrollerer kortene, og du får det endelige tilbudet på e-post innen 1–3 virkedager.</p>" +
        '<p>Følg innsendingen: <a href="' + statusLenke_(o.ref) + '">' + statusLenke_(o.ref) + "</a></p><p>Hilsen PokéNordic</p></div>" });
  }
  ui.alert("Tilbud #" + o.ref + " er merket som mottatt" + (isEmail_(o.contact) ? ", og selgeren har fått e-post." : "."));
}

/* ======================================================================
   4. Nettbutikken (PNordic): betalte kort ut, status og salg inn
   ====================================================================== */
// PNordic-opplastingen henter kortene fra betalte tilbud, legger dem ut i Shopify uten mva (avansemetoden)
// og skriver tilbake «Lagt ut» eller «Backlog» i fanen «Kort». Den nattlige avanse-loggen sender salgene
// hit, og de lagres i fanen «Avanse» (oppsummert per termin i «Avanse per termin»).
// Alt krever nøkkelen fra menyen PokéNordic → «Nøkkel for nettbutikken», som lagres i skriptets egenskaper.
const SHOP_COLS = ["Shopify", "Shopify-info", "Solgt"];
const AVANSE_HEADERS = ["Dato", "Ordre", "Linje-ID", "Varenr", "Kort", "Tilstand", "Antall", "Innkjøp (kr)",
  "Salg (kr)", "Avanse (kr)", "MVA (kr)", "Termin", "Referanse"];
const AVANSE_MVA = 0.20;  // avansen regnes inkludert mva: 25 % mva = 20 % av avansen
const TERMIN_NAVN = ["jan–feb", "mar–apr", "mai–jun", "jul–aug", "sep–okt", "nov–des"];

function makeApiKey() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty("API_NOKKEL");
  if (key) {
    const a = ui.alert("Nøkkel for nettbutikken", "Det finnes allerede en nøkkel:\n\n" + key +
      "\n\nVil du lage en ny? Da slutter den gamle å virke, og du må lime inn den nye i PNordic.", ui.ButtonSet.YES_NO);
    if (a !== ui.Button.YES) return;
  }
  key = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  props.setProperty("API_NOKKEL", key);
  ui.alert("Nøkkel for nettbutikken", "Lim denne inn som \"nokkel\" i innkjop-tilgang.json i PNordic " +
    "(og som secret INNKJOP_NOKKEL på GitHub):\n\n" + key, ui.ButtonSet.OK);
}

function api_(d) {
  const key = PropertiesService.getScriptProperties().getProperty("API_NOKKEL");
  if (!key || String(d.key || "") !== key) return json_({ ok: false, error: "Feil nøkkel" });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (d.api === "kort") return json_({ ok: true, kort: paidCards_(ss, d.bare) });
    if (d.api === "status") return json_({ ok: true, oppdatert: setShopStatus_(ss, d.rader || []) });
    if (d.api === "salg") return json_(Object.assign({ ok: true }, addSales_(ss, d.rader || [])));
    return json_({ ok: false, error: "Ukjent handling: " + d.api });
  } finally {
    lock.releaseLock();
  }
}

// Kort fra betalte tilbud som ikke er lagt ut. bare = "nye" (aldri forsøkt), "backlog" eller tomt (begge).
function paidCards_(ss, bare) {
  const offers = ss.getSheetByName("Tilbud"), sh = ss.getSheetByName("Kort");
  if (!offers || !sh || offers.getLastRow() < 2 || sh.getLastRow() < 2) return [];
  const oc = cols_(offers, []);
  const paid = {};
  offers.getRange(2, 1, offers.getLastRow() - 1, offers.getLastColumn()).getValues().forEach((r) => {
    if (String(r[oc["Status"] - 1]).trim() === "Betalt") paid[String(r[oc["Referanse"] - 1])] = String(r[oc["Oppgjør"] - 1]);
  });
  const want = bare === "nye" ? [""] : bare === "backlog" ? ["Backlog"] : ["", "Backlog"];
  const c = cols_(sh, SHOP_COLS);
  const out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach((r) => {
    const g = (h) => (c[h] ? r[c[h] - 1] : "");
    const ref = String(g("Referanse"));
    if (!(ref in paid)) return;
    if (/avvist/i.test(String(g("Status"))) || String(g("Variant")) === "per kg") return;
    const shop = String(g("Shopify")).trim();
    if (want.indexOf(shop) < 0) return;
    const qty = num_(g("Antall"));
    const tcg = String(g("TCGPlayer-ID")).trim();
    if (!(qty > 0) || !/^\d+$/.test(tcg)) return;
    const justert = c["Justert tilstand"] ? String(g("Justert tilstand")).trim() : "";
    out.push({
      nr: String(g("Varenr")), ref: ref, tcgId: Number(tcg), kort: String(g("Kort")), sett: String(g("Sett")),
      // «Usikker» uten Justert tilstand gir tom tilstand: opplastingen nekter da å legge ut kortet
      nummer: String(g("Nummer")), variant: String(g("Variant")),
      tilstand: tilstandKode_(justert || g("Tilstand")) || (/usikker/i.test(String(g("Tilstand"))) ? "" : "NM"),
      antall: Math.round(qty), innkjop: num_(g("Pris/stk (kr)")), shopify: shop, info: String(g("Shopify-info")), oppgjor: paid[ref]
    });
  });
  return out;
}

// rader: [{ nr, status: "Lagt ut" | "Backlog" | "Feil", info }]. «Feil» lar Shopify-feltet stå tomt, så kortet prøves igjen.
function setShopStatus_(ss, rader) {
  const sh = ss.getSheetByName("Kort");
  if (!sh || !rader.length || sh.getLastRow() < 2) return 0;
  const c = cols_(sh, SHOP_COLS);
  const nrs = sh.getRange(1, c["Varenr"], sh.getLastRow(), 1).getValues().map((r) => String(r[0]));
  let n = 0;
  rader.forEach((x) => {
    const i = nrs.indexOf(String(x.nr));
    const st = String(x.status || "");
    if (i < 1 || ["Lagt ut", "Backlog", "Feil"].indexOf(st) < 0) return;
    sh.getRange(i + 1, c["Shopify"]).setValue(st === "Feil" ? "" : st);
    sh.getRange(i + 1, c["Shopify-info"]).setValue(safe_(String(x.info || "").slice(0, 500)));
    n++;
  });
  return n;
}

// rader: [{ linjeId, ordre, dato, nr, antall, salg }] fra Shopify-ordrene. salg = hva kunden betalte for linjen (etter rabatt).
// Innkjøpsprisen hentes fra fanen «Kort» (Pris/stk × antall). Linjer som er logget før, hoppes over.
function addSales_(ss, rader) {
  const av = sheet_(ss, "Avanse", AVANSE_HEADERS);
  avanseSummary_(ss);
  const ac = cols_(av, []);
  const seen = {};
  if (av.getLastRow() >= 2) av.getRange(2, ac["Linje-ID"], av.getLastRow() - 1, 1).getValues().forEach((r) => { seen[String(r[0])] = true; });
  const sh = ss.getSheetByName("Kort");
  const c = sh ? cols_(sh, SHOP_COLS) : {};
  const byNr = {};
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach((r, i) => {
      byNr[skuNr_(r[c["Varenr"] - 1])] = { row: i + 2, r: r };
    });
  }
  const nye = [], ukjente = [];
  let fantes = 0;
  rader.forEach((x) => {
    const id = String(x.linjeId || "");
    if (!id) return;
    if (seen[id]) { fantes++; return; }
    const hit = byNr[skuNr_(x.nr)];
    if (!hit) { ukjente.push(String(x.nr)); return; }
    const g = (h) => (c[h] ? hit.r[c[h] - 1] : "");
    const antall = Number(x.antall) || 0;
    const salg = round2_(Number(x.salg) || 0);
    const innkjop = round2_(num_(g("Pris/stk (kr)")) * antall);
    const avanse = round2_(salg - innkjop);
    const dato = new Date(x.dato);
    nye.push([dato, safe_(String(x.ordre || "")), id, String(g("Varenr")), String(g("Kort")),
      tilstandKode_(String(g("Justert tilstand") || "").trim() || g("Tilstand")), antall, innkjop, salg, avanse,
      round2_(Math.max(0, avanse) * AVANSE_MVA), termin_(dato), String(g("Referanse"))]);
    seen[id] = true;
    const solgt = num_(g("Solgt")) + antall;
    sh.getRange(hit.row, c["Solgt"]).setValue(solgt);
    hit.r[c["Solgt"] - 1] = solgt;
  });
  if (nye.length) av.getRange(av.getLastRow() + 1, 1, nye.length, nye[0].length).setValues(nye);
  return { lagtTil: nye.length, fantes: fantes, ukjente: ukjente };
}

// Varenr slik det står i SKU-en: «ABCDE-03–05» blir «ABCDE-03_05» (SKU-er bør ikke ha tankestrek)
function skuNr_(nr) {
  return String(nr == null ? "" : nr).trim().toUpperCase().replace(/[–—]/g, "_");
}

// Mva-terminer på to måneder: «2026 T6 (nov–des)»
function termin_(d) {
  const ym = Utilities.formatDate(d, TZ, "yyyy-M").split("-");
  const t = Math.floor((Number(ym[1]) - 1) / 2);
  return ym[0] + " T" + (t + 1) + " (" + TERMIN_NAVN[t] + ")";
}

function avanseSummary_(ss) {
  if (ss.getSheetByName("Avanse per termin")) return;
  const sh = ss.insertSheet("Avanse per termin");
  sh.getRange(1, 1).setFormula('=QUERY(Avanse!A:M, "select L, count(C), sum(G), sum(H), sum(I), sum(J), sum(K) ' +
    "where L is not null group by L order by L label count(C) 'Salgslinjer', sum(G) 'Kort solgt', sum(H) 'Innkjøp (kr)', " +
    "sum(I) 'Salg (kr)', sum(J) 'Avanse (kr)', sum(K) 'MVA å betale (kr)'\", 1)");
  sh.getRange(1, 9).setValue("MVA = 20 % av avansen per kort (salg − innkjøp). Kort med negativ avanse gir 0 kr og trekkes ikke fra de andre.");
}

/* ======================================================================
   3. Siden selgeren åpner fra e-posten: godta (signere) eller avslå
   ====================================================================== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.a) return json_({ ok: true, service: "PokéNordic innkjøp" });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rowNum = findOfferRow_(ss, p.ref);
  const offer = rowNum ? readOffer_(ss, rowNum) : null;
  if (!offer || !offer.token || p.t !== offer.token) {
    return page_("Fant ikke tilbudet", "<p>Lenken er ugyldig eller utløpt. Ta kontakt på <b>" + OWNER_EMAIL + "</b> og oppgi referansen.</p>");
  }
  if (offer.status === "Godtatt" || offer.status === "Betalt") {
    return page_("Tilbudet er godtatt", "<p>Du har allerede godtatt tilbud <b>#" + esc_(offer.ref) + "</b>. Takk!</p>");
  }
  if (offer.status === "Avslått") {
    return page_("Tilbudet er avslått", "<p>Du har avslått tilbud <b>#" + esc_(offer.ref) + "</b>. Vi sender kortene tilbake til deg.</p>");
  }
  if (offer.status !== "Endelig tilbud sendt") {
    return page_("Tilbudet er ikke klart", "<p>Tilbud <b>#" + esc_(offer.ref) + "</b> venter ikke på svar akkurat nå. Ta kontakt på <b>" + OWNER_EMAIL + "</b>.</p>");
  }

  const lines = readLines_(ss, offer.ref, true);
  const total = offer.finalTotal || round2_(lines.reduce((s, l) => s + l.sum, 0));
  const base = WEBAPP_URL;

  if (p.a === "avsla") {
    if (p.ok !== "1") {
      return page_("Avslå tilbudet?",
        "<p>Vil du avslå tilbud <b>#" + esc_(offer.ref) + "</b> på <b>" + kr_(total) + "</b>?</p>" +
        "<p>Vi sender da kortene tilbake til deg, og du betaler returfrakten.</p>" +
        '<form method="get" action="' + esc_(base) + '" target="_top">' + hidden_({ a: "avsla", ref: offer.ref, t: p.t, ok: "1" }) +
        '<button class="btn danger" type="submit">Ja, avslå tilbudet</button></form>');
    }
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try { setOffer_(ss, rowNum, { "Status": "Avslått" }); } finally { lock.releaseLock(); }
    sendMail_({ to: OWNER_EMAIL, subject: "Tilbud #" + offer.ref + " er AVSLÅTT – send kortene tilbake", name: SENDER_NAME,
      htmlBody: "<p>" + esc_(offer.name) + " har avslått det endelige tilbudet #" + esc_(offer.ref) + " (" + kr_(total) + ").</p><p>Send kortene tilbake til:<br>" +
        esc_(offer.name) + "<br>" + esc_(offer.street) + "<br>" + esc_(offer.zip + " " + offer.city) + "</p><p>Selgeren betaler returfrakten.</p>" });
    return page_("Tilbudet er avslått", "<p>Takk for svaret. Vi sender kortene tilbake til deg så snart som mulig. Returfrakten betaler du, og vi tar kontakt om det.</p>");
  }

  if (p.a === "godta") {
    const cash = offer.mode === "Utbetaling";
    const errors = [];
    if (p.ok === "1") {
      if (String(p.name || "").trim().length < 3) errors.push("Skriv inn fullt navn som signatur.");
      if (offer.minor && String(p.gname || "").trim().length < 3) errors.push("Foresatt må skrive inn fullt navn.");
      if (cash && String(p.payto || "").trim().length < 5) errors.push("Skriv inn Vipps-nummer eller kontonummer.");
      if (p.confirm !== "1") errors.push("Kryss av for at kortene er dine og at opplysningene stemmer.");
    }
    if (p.ok !== "1" || errors.length) {
      return page_("Godta tilbud #" + offer.ref,
        (errors.length ? '<p class="err">' + errors.map(esc_).join("<br>") + "</p>" : "") +
        summary_(offer, lines, total) +
        '<form method="get" action="' + esc_(base) + '" target="_top">' + hidden_({ a: "godta", ref: offer.ref, t: p.t, ok: "1" }) +
        (cash ? '<label>Utbetal til (Vipps-nummer eller kontonummer)<input name="payto" required value="' + esc_(p.payto || "") + '"></label>'
              : "<p>Beløpet blir gitt som butikkreditt (tilgode) i nettbutikken. Vi sender deg koden på e-post.</p>") +
        '<label>Ditt fulle navn (signatur)<input name="name" required autocomplete="name" value="' + esc_(p.name || "") + '"></label>' +
        (offer.minor ? '<label>Foresattes fulle navn (signatur)<input name="gname" required value="' + esc_(p.gname || "") + '"></label>' : "") +
        '<label class="check"><input type="checkbox" name="confirm" value="1"' + (p.confirm === "1" ? " checked" : "") + "> Jeg godtar tilbudet, og bekrefter at kortene er mine og at opplysningene stemmer.</label>" +
        '<button class="btn" type="submit">Godta og signer</button></form>' +
        '<p class="small">Vil du heller avslå? <a href="' + esc_(base + "?a=avsla&ref=" + encodeURIComponent(offer.ref) + "&t=" + encodeURIComponent(p.t)) + '" target="_top">Avslå tilbudet</a></p>');
    }

    // Godtatt: lagre signatur, lag signert kjøpsbevis, send e-post
    const signedAt = new Date();
    const sig = {
      name: String(p.name).trim(),
      guardian: offer.minor ? String(p.gname || "").trim() : "",
      at: signedAt,
      email: offer.contact
    };
    const payto = cash ? String(p.payto).trim() : "Butikkreditt";
    const pdf = receiptPdf_(offer, lines, total, sig);
    const file = folder_().createFile(pdf);
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      setOffer_(ss, rowNum, {
        "Status": "Godtatt",
        "Signert av": sig.name + (sig.guardian ? " / foresatt: " + sig.guardian : ""),
        "Signert tidspunkt": signedAt,
        "Utbetaling til": safe_(payto),
        "Kjøpsbevis": file.getUrl()
      });
    } finally { lock.releaseLock(); }

    sendMail_({ to: offer.contact, subject: "Kjøpsbevis #" + offer.ref + " – takk for handelen!", attachments: [pdf], replyTo: OWNER_EMAIL, name: SENDER_NAME,
      htmlBody: "<div style=\"font-family:Arial,sans-serif;font-size:14px\"><p>Hei " + esc_(offer.name) + "!</p><p>Takk, du har godtatt tilbud <b>#" + esc_(offer.ref) +
        "</b> på <b>" + kr_(total) + "</b>. Det signerte kjøpsbeviset ligger vedlagt.</p><p>" +
        (cash ? "Vi starter utbetalingen i dag." : "Du får butikkreditten på e-post i dag.") + "</p><p>Hilsen PokéNordic</p></div>" });
    sendMail_({ to: OWNER_EMAIL, subject: "✅ Tilbud #" + offer.ref + " GODTATT – " + (cash ? "betal " : "gi butikkreditt ") + kr_(total), attachments: [pdf], name: SENDER_NAME,
      htmlBody: "<div style=\"font-family:Arial,sans-serif;font-size:14px\"><p><b>" + esc_(offer.name) + "</b> har godtatt og signert tilbud #" + esc_(offer.ref) + ".</p>" +
        "<p><b>" + (cash ? "Utbetal " + kr_(total) + " til: " + esc_(payto) : "Gi butikkreditt på " + kr_(total) + " til " + esc_(offer.contact)) + "</b></p>" +
        '<p>Kjøpsbevis: <a href="' + esc_(file.getUrl()) + '">' + esc_(file.getName()) + "</a></p>" +
        "<p>Merk tilbudet som betalt i regnearket (PokéNordic → «Merk valgt tilbud som betalt») når det er gjort.</p></div>" });
    return page_("Takk! Tilbudet er godtatt", "<p>Du har godtatt og signert tilbud <b>#" + esc_(offer.ref) + "</b> på <b>" + kr_(total) + "</b>.</p>" +
      "<p>Det signerte kjøpsbeviset er sendt til <b>" + esc_(offer.contact) + "</b>. " + (cash ? "Utbetalingen starter i dag." : "Butikkreditten får du på e-post i dag.") + "</p>");
  }

  return page_("Ukjent handling", "<p>Lenken er ugyldig. Ta kontakt på <b>" + OWNER_EMAIL + "</b>.</p>");
}

/* ======================================================================
   Lesing og skriving i regnearket
   ====================================================================== */

// Kolonnenummer (1-basert) per overskrift. Mangler en kolonne i «needed», legges den til bakerst.
function cols_(sh, needed) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  (needed || []).forEach((h) => {
    if (head.indexOf(h) < 0) {
      head.push(h);
      sh.getRange(1, head.length).setValue(h).setFontWeight("bold");
    }
  });
  const map = {};
  head.forEach((h, i) => { if (h) map[h] = i + 1; });
  return map;
}

function readOffer_(ss, rowNum) {
  const sh = ss.getSheetByName("Tilbud");
  const c = cols_(sh, OFFER_EXTRA);
  const v = sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0];
  const g = (h) => (c[h] ? v[c[h] - 1] : "");
  return {
    row: rowNum, ref: String(g("Referanse")), status: String(g("Status")), name: String(g("Selger")), contact: String(g("Kontakt")).trim(),
    street: String(g("Adresse")), zip: String(g("Postnr")), city: String(g("Poststed")),
    minor: String(g("Under 18")) === "Ja", guardian: String(g("Foresatt")), guardianContact: String(g("Foresatt kontakt")),
    mode: String(g("Oppgjør")), estimate: Number(g("Estimert sum (kr)")) || 0, finalTotal: Number(g("Endelig sum (kr)")) || 0,
    token: String(g("Token") || ""), received: g("Mottatt"),
    needsApproval: String(g("Krever godkjenning")) === "Ja" || ["Venter på godkjenning", "Godkjent"].indexOf(String(g("Status"))) >= 0,
    tracking: String(g("Sporing") || "")
  };
}

function setOffer_(ss, rowNum, values) {
  const sh = ss.getSheetByName("Tilbud");
  const c = cols_(sh, OFFER_EXTRA.concat(Object.keys(values)));
  Object.keys(values).forEach((h) => sh.getRange(rowNum, c[h]).setValue(values[h]));
}

function findOfferRow_(ss, ref) {
  const sh = ss.getSheetByName("Tilbud");
  if (!sh || !ref) return 0;
  const c = cols_(sh, []);
  const refs = sh.getRange(1, c["Referanse"], sh.getLastRow(), 1).getValues();
  for (let i = refs.length - 1; i >= 1; i--) if (String(refs[i][0]) === String(ref)) return i + 1;
  return 0;
}

// Kortlinjene for en referanse. Antall × Pris/stk regnes ut på nytt (og skrives tilbake), så endringene dine telles med.
function readLines_(ss, ref, writeBack) {
  const sh = ss.getSheetByName("Kort");
  if (!sh) return [];
  const c = cols_(sh, []);
  const data = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const g = (h) => r[c[h] - 1];
    if (String(g("Referanse")) !== String(ref)) continue;
    if (/avvist/i.test(String(g("Status")))) continue;
    const qty = Number(String(g("Antall")).replace(",", ".")) || 0;
    const each = Number(String(g("Pris/stk (kr)")).replace(",", ".")) || 0;
    const sum = round2_(qty * each);
    if (writeBack && Number(g("Sum (kr)")) !== sum) sh.getRange(i + 1, c["Sum (kr)"]).setValue(sum);
    const given = String(g("Tilstand"));
    const adjusted = c["Justert tilstand"] && String(g("Variant")) !== "per kg" ? String(g("Justert tilstand")).trim() : "";
    out.push({
      nr: String(g("Varenr")), name: String(g("Kort")), set: String(g("Sett")), number: String(g("Nummer")),
      variant: String(g("Variant")), cond: adjusted || given, givenCond: given, changed: !!adjusted && adjusted.toUpperCase() !== given.toUpperCase(),
      checked: c["Kontrollert"] ? g("Kontrollert") === true || String(g("Kontrollert")).toUpperCase() === "TRUE" : false,
      qty: qty, each: each, sum: sum, bulk: String(g("Variant")) === "per kg"
    });
  }
  return out;
}

function folder_() {
  const it = DriveApp.getFoldersByName(DRIVE_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_FOLDER);
}

/* ======================================================================
   Kjøpsbevis (PDF), e-post og sider
   ====================================================================== */

// Lager kjøpsbeviset som PDF. sig = null gir «til godkjenning», ellers signert versjon.
function receiptPdf_(o, lines, total, sig) {
  const fmt = (d) => Utilities.formatDate(d, TZ, "dd.MM.yyyy");
  const fmtT = (d) => Utilities.formatDate(d, TZ, "dd.MM.yyyy 'kl.' HH:mm");
  const td = "padding:6px 5px;border-bottom:1px solid #ccc;vertical-align:top;font-size:11px";
  const tdr = td + ";text-align:right;white-space:nowrap";
  const rows = lines.map((l) =>
    "<tr><td style=\"" + td + ";font-family:monospace\">" + esc_(l.nr) + "</td><td style=\"" + td + "\">" + esc_(l.name) +
    "<br><span style=\"color:#555\">" + esc_([l.set, l.number, l.bulk ? "" : l.variant].filter(String).join(" · ")) + "</span></td>" +
    "<td style=\"" + td + "\">" + esc_(l.cond) + "</td><td style=\"" + tdr + "\">" + esc_(l.bulk ? String(l.qty).replace(".", ",") + " kg" : l.qty) +
    "</td><td style=\"" + tdr + "\">" + kr_(l.each) + (l.bulk ? "/kg" : "") + "</td><td style=\"" + tdr + "\">" + kr_(l.sum) + "</td></tr>").join("");
  const status = sig
    ? '<div style="border:2px solid #1F8A55;color:#1F8A55;padding:6px;text-align:center;font-weight:bold;font-size:12px">SIGNERT ' + esc_(fmtT(sig.at)) + "</div>"
    : '<div style="border:2px dashed #B4561B;color:#8A3E10;padding:6px;text-align:center;font-weight:bold;font-size:12px">TIL GODKJENNING – IKKE SIGNERT</div>';
  const signBlock = sig
    ? "<p style=\"font-size:11px;margin-top:20px\"><b>Elektronisk signert av selger:</b> " + esc_(sig.name) + ", " + esc_(fmtT(sig.at)) +
      ", via personlig lenke sendt til " + esc_(sig.email) + ".</p>" +
      (sig.guardian ? "<p style=\"font-size:11px\"><b>Godkjent av foresatt:</b> " + esc_(sig.guardian) + ", " + esc_(fmtT(sig.at)) + ".</p>" : "")
    : "<p style=\"font-size:11px;margin-top:20px\">Selgeren godtar og signerer ved å trykke på lenken i e-posten og skrive inn fullt navn.</p>";
  const html =
    '<html><body style="font-family:Arial,sans-serif;color:#111;background:#fff;font-size:12px">' + status +
    '<table style="width:100%;margin-top:14px"><tr><td><div style="font-size:22px;font-weight:bold;color:#1E6FDA">PokéNordic</div><div style="font-size:18px;font-weight:bold">Kjøpsbevis</div></td>' +
    '<td style="text-align:right;font-size:11px">Referanse<br><b style="font-size:14px">#' + esc_(o.ref) + "</b><br>Dato " + esc_(fmt(sig ? sig.at : new Date())) + "</td></tr></table>" +
    '<hr style="border:0;border-top:2px solid #111">' +
    '<table style="width:100%;font-size:12px"><tr><td style="vertical-align:top;width:50%"><b style="font-size:10px;color:#555">KJØPER</b><br>' +
    esc_(BUYER.name) + "<br>Org.nr. " + esc_(BUYER.orgnr) + "<br>" + esc_(BUYER.address) + "</td>" +
    '<td style="vertical-align:top"><b style="font-size:10px;color:#555">SELGER (PRIVATPERSON)</b><br>' + esc_(o.name) + "<br>" + esc_(o.street) + "<br>" + esc_(o.zip + " " + o.city) + "<br>" + esc_(o.contact) +
    (o.minor ? '<br><br><b style="font-size:10px;color:#555">FORESATT</b><br>' + esc_(o.guardian) + "<br>" + esc_(o.guardianContact) : "") + "</td></tr></table>" +
    '<table style="width:100%;border-collapse:collapse;margin-top:14px"><thead><tr style="text-align:left;font-size:10px;color:#555">' +
    "<th style=\"" + td + "\">VARENR.</th><th style=\"" + td + "\">KORT</th><th style=\"" + td + "\">TILSTAND</th><th style=\"" + tdr + "\">ANTALL</th><th style=\"" + tdr + "\">PRIS/ENHET</th><th style=\"" + tdr + "\">SUM</th></tr></thead>" +
    "<tbody>" + rows + "</tbody></table>" +
    '<p style="text-align:right;font-size:14px;margin-top:10px"><b>Kjøpssum ' + kr_(total) + "</b></p>" +
    '<p style="font-size:11px"><b>Oppgjør:</b> ' + esc_(o.mode === "Utbetaling" ? "Utbetaling" : "Innbytte (butikkreditt i nettbutikken)") + ".</p>" +
    '<p style="font-size:11px;color:#333">Kortene er kjøpt fra privatperson og videreselges etter avansemetoden (merverdiavgiftsloven § 4-6). ' +
    "Kjøpsbevis etter bokføringsforskriften § 8-10-3. Ved signering bekrefter selger at kortene er selgers eiendom, og at opplysningene over er riktige.</p>" +
    signBlock + "</body></html>";
  const name = "Kjøpsbevis " + o.ref + (sig ? " – signert" : " – til godkjenning") + ".pdf";
  return HtmlService.createHtmlOutput(html).getBlob().getAs(MimeType.PDF).setName(name);
}

function finalOfferMail_(o, lines, total, acceptUrl, declineUrl) {
  const btn = (url, text, bg) => '<a href="' + esc_(url) + '" style="display:inline-block;padding:12px 20px;margin:4px 6px 4px 0;border-radius:8px;background:' + bg + ';color:#fff;font-weight:bold;text-decoration:none">' + text + "</a>";
  const changed = Math.abs(total - o.estimate) >= 0.01;
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">' +
    "<p>Hei " + esc_(o.name) + "!</p>" +
    "<p>Vi har kontrollert kortene dine. Her er det endelige tilbudet for <b>#" + esc_(o.ref) + "</b>:</p>" +
    summary_(o, lines, total) +
    (changed ? '<p style="color:#555">Estimatet ditt var ' + kr_(o.estimate) + ". Endringen skyldes tilstand, antall eller kort vi ikke kan kjøpe.</p>" : "") +
    "<p>Kjøpsbeviset ligger vedlagt. Godtar du, signerer du ved å trykke på knappen og skrive inn navnet ditt.</p>" +
    "<p>" + btn(acceptUrl, "Godta og signer", "#1E6FDA") + btn(declineUrl, "Avslå", "#8A3E10") + "</p>" +
    '<p style="color:#555;font-size:13px">Avslår du, sender vi kortene tilbake, og du betaler returfrakten. Spørsmål? Svar på denne e-posten.</p>' +
    "<p>Hilsen PokéNordic</p></div>";
}

function summary_(o, lines, total) {
  const td = 'style="padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top;font-size:13px"';
  const tdr = 'style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right;white-space:nowrap;font-size:13px"';
  return '<table style="border-collapse:collapse;width:100%;max-width:640px">' + lines.map((l) =>
    "<tr><td " + td + ">" + esc_(l.name) + '<br><span style="color:#666;font-size:12px">' + esc_([l.set, l.number].filter(String).join(" · ")) + " · " + esc_(l.cond) +
    (l.changed ? (/usikker/i.test(l.givenCond) ? " (vurdert av oss)" : " (du oppga " + esc_(l.givenCond) + ")") : "") +
    "</span></td><td " + tdr + ">" + esc_(l.bulk ? String(l.qty).replace(".", ",") + " kg" : l.qty + " stk") + "</td><td " + tdr + ">" + kr_(l.sum) + "</td></tr>").join("") +
    "</table><p><b>" + (o.mode === "Utbetaling" ? "Utbetaling" : "Butikkreditt") + ": " + kr_(total) + "</b></p>";
}

function page_(title, body) {
  const css = ":root{color-scheme:light}body{font-family:Arial,sans-serif;background:#F2F6FC;color:#0F1A2E;margin:0;padding:24px 16px}" +
    "input{background:#fff;color:#0F1A2E}" +
    ".card{max-width:620px;margin:0 auto;background:#fff;border:1px solid #D6DFEC;border-radius:12px;padding:22px}" +
    "h1{font-size:22px;margin:0 0 12px}.brand{color:#1E6FDA;font-weight:bold;font-size:18px;margin-bottom:10px}" +
    "label{display:block;font-weight:bold;font-size:14px;margin:14px 0 4px}input[type=text],input:not([type]){width:100%;box-sizing:border-box;padding:10px;border:1.5px solid #D6DFEC;border-radius:8px;font-size:15px;font-weight:normal;margin-top:4px}" +
    "label.check{font-weight:normal;display:flex;gap:8px;align-items:flex-start}.btn{margin-top:16px;padding:12px 20px;border:0;border-radius:8px;background:#1E6FDA;color:#fff;font-size:15px;font-weight:bold;cursor:pointer}" +
    ".btn.danger{background:#8A3E10}.err{background:#fff3e0;border:1px solid #f0a35a;padding:10px;border-radius:8px}.small{font-size:13px;color:#555;margin-top:16px}";
  return HtmlService.createHtmlOutput('<div class="card"><div class="brand">PokéNordic</div><h1>' + esc_(title) + "</h1>" + body + "</div>")
    .setTitle(title + " – PokéNordic")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .append("<style>" + css + "</style>");
}

function hidden_(o) {
  return Object.keys(o).map((k) => '<input type="hidden" name="' + esc_(k) + '" value="' + esc_(o[k]) + '">').join("");
}

/* ---------- hjelpefunksjoner ---------- */

// Sender e-post fra FROM_ADDRESS når den er godkjent som «Send e-post som» i Gmail, ellers fra kontoens egen adresse.
function sendMail_(o) {
  let aliases = [];
  try { aliases = GmailApp.getAliases().map((a) => String(a).toLowerCase()); } catch (e) { aliases = []; }
  if (FROM_ADDRESS && aliases.indexOf(FROM_ADDRESS.toLowerCase()) >= 0) {
    const opts = { htmlBody: o.htmlBody, name: o.name || SENDER_NAME, from: FROM_ADDRESS };
    if (o.attachments) opts.attachments = o.attachments;
    if (o.replyTo) opts.replyTo = o.replyTo;
    GmailApp.sendEmail(o.to, o.subject, "Denne e-posten må vises med HTML.", opts);
  } else {
    MailApp.sendEmail(o);
  }
}

function validate_(d) {
  const s = d && d.seller;
  if (!s || !s.name || !s.contact || !s.street || !/^\d{4}$/.test(String(s.zip || "")) || !s.city) throw new Error("Mangler selgeropplysninger");
  if (s.minor && (!s.guardianName || !s.guardianContact)) throw new Error("Mangler foresatt");
  if (!/^[A-Z0-9]{5}$/.test(String(d.ref || ""))) throw new Error("Ugyldig referanse");
  if (!Array.isArray(d.lines) || !d.lines.length || d.lines.length > 300) throw new Error("Ugyldig kortliste");
  ["name", "contact", "street", "city", "guardianName", "guardianContact"].forEach((k) => { if (String(s[k] || "").length > 200) throw new Error("For lang tekst"); });
  if (String(s.note || "").length > 2000) throw new Error("For lang kommentar");
}

function sheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }
  return sh;
}

// Hindrer at tekst fra skjemaet blir tolket som formler i regnearket
function safe_(v) {
  if (typeof v === "string" && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function esc_(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function kr_(n) {
  return Number(n || 0).toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function mailHtml_(d, forOwner) {
  const s = d.seller;
  const td = 'style="padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top"';
  const tdr = 'style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right;white-space:nowrap"';
  // «Usikker»: portalen sender spennet DMG–NM (lo/hi = linjesum), som vises i stedet for arbeidsprisen
  const spenn = (lo, hi) => kr_(hi).replace(/\s*kr$/, "") + " – " + kr_(lo);  // høyeste (NM) først, som i portalen
  const harSpenn = (l) => l.lo != null && l.hi != null && Math.abs(l.hi - l.lo) >= 0.01;
  const rows = d.lines.map((l) =>
    "<tr><td " + td + "><code>" + esc_(l.nr) + "</code></td><td " + td + ">" + esc_(l.name) + "<br><small>" + esc_(l.set) + " · " + esc_(l.number) + " · " + esc_(l.variant) +
    "</small></td><td " + td + ">" + esc_(l.cond) + "</td><td " + tdr + ">" + esc_(l.variant === "per kg" ? String(l.qty).replace(".", ",") + " kg" : l.qty) +
    "</td><td " + tdr + ">" + (harSpenn(l) ? spenn(l.lo / l.qty, l.hi / l.qty) : kr_(l.each) + (l.variant === "per kg" ? "/kg" : "")) +
    "</td><td " + tdr + ">" + (harSpenn(l) ? spenn(l.lo, l.hi) : kr_(l.sum)) + "</td></tr>"
  ).join("");
  const totalSpenn = d.totalLo != null && d.totalHi != null && Math.abs(d.totalHi - d.totalLo) >= 0.01;
  const hold = '<p style="background:#fff3e0;border:1px solid #f0a35a;padding:10px 12px;border-radius:6px">';
  const intro = forOwner
    ? (d.needsApproval ? hold + "<b>Krever godkjenning.</b> Selgeren har fått beskjed om å vente med å sende kortene til du har bekreftet tilbudet. Svar på denne e-posten for å godkjenne eller avslå.</p>" : "") +
      "<p><b>Nytt tilbud #" + esc_(d.ref) + "</b> fra innkjøpsportalen.</p>"
    : "<p>Hei " + esc_(s.name) + "!</p><p>Takk for tilbudet ditt! Vi har mottatt det med referanse <b>#" + esc_(d.ref) + "</b>.</p>" +
      (d.needsApproval ? hold + "<b>Ikke send kortene ennå.</b> Vi går gjennom tilbudet og sender deg en bekreftelse på e-post før du sender.</p>"
        : "<p>Du kan nå sende kortene til oss med Posten. Vi anbefaler sporet sending, for eksempel Liten Norgespakke. Legg gjerne ved en lapp med referansen <b>#" + esc_(d.ref) + "</b>.</p>" +
          '<p style="background:#F2F6FC;border:1px solid #D6DFEC;padding:10px 12px;border-radius:6px"><b>Send til:</b><br>' + esc_(BUYER.name) + "<br>" + esc_(BUYER.address).replace(", ", "<br>") + (BUYER.phone ? "<br>" + esc_(BUYER.phone) : "") + "</p>") +
      "<p>Når kortene kommer, dobbeltsjekker vi tilstanden. Stemmer den med det du har oppgitt, utbetaler vi etter estimatet. Er tilstanden bedre enn oppgitt, justerer vi tilbudet opp. " +
      "Er den dårligere, får du et justert tilbud på e-post som du kan godta eller avslå før noe er avtalt.</p>" +
      "<p><b>Dette har du sendt inn:</b></p>";
  const closing = forOwner ? "" : '<p>Følg innsendingen din her (bruk e-postadressen du sendte inn med): <a href="' + statusLenke_(d.ref) + '">' + statusLenke_(d.ref) + "</a></p>" +
    "<p>Har du spørsmål, er det bare å svare på denne e-posten.</p><p>Med vennlig hilsen<br>PokéNordic</p>";
  const sellerBlock = forOwner
    ? "<p><b>Selger:</b> " + esc_(s.name) + "<br>" + esc_(s.street) + ", " + esc_(s.zip) + " " + esc_(s.city) + "<br>" + esc_(s.contact) +
      (s.minor ? "<br><b>Under 18 år.</b> Foresatt: " + esc_(s.guardianName) + " – " + esc_(s.guardianContact) : "<br>18 år eller eldre") + "</p>"
    : "";
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">' + intro + sellerBlock +
    "<p><b>Oppgjør:</b> " + esc_(d.modeName) + " (" + Math.round(d.rate * 100) + " % av markedspris)</p>" +
    '<table style="border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left"><th ' + td + ">Varenr.</th><th " + td + ">Kort</th><th " + td +
    ">Tilstand</th><th " + tdr + ">Antall</th><th " + tdr + ">Pris/stk</th><th " + tdr + ">Sum</th></tr></thead><tbody>" + rows + "</tbody></table>" +
    "<p><b>" + esc_(d.countText || d.count + " kort") + " · Estimert sum " + (totalSpenn ? spenn(d.totalLo, d.totalHi) : kr_(d.total)) + "</b>" +
      (forOwner ? " (alternativt " + kr_(d.altTotal) + (totalSpenn ? "; i regnearket står LP-pris for «Usikker», " + kr_(d.total) + " totalt" : "") + ")" : "") + "</p>" +
    (totalSpenn ? "<p>Kort merket «Usikker» vurderer " + (forOwner ? "du" : "vi") + " når kortene kommer. Prisen er et spenn fra Near Mint til Damaged, og endelig pris står i tilbudet.</p>" : "") +
    (s.note ? "<p><b>Kommentar:</b> " + esc_(s.note) + "</p>" : "") + closing +
    '<p style="color:#666;font-size:12px">Priser: TCGPlayer Market Price ' + esc_(d.pricesDate) + ", 1 USD = " + esc_(d.usdNok) + " NOK.</p></div>";
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
