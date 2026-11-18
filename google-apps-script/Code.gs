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
const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbztuYAxSOWskMnvYkX-8nxBDgYKS9k_q9ymVKbKdJkCxIKKzZs1XnOs-JTFVZUYgoG34g/exec";
const TZ = "Europe/Oslo";
// ===============================

const OFFER_HEADERS = [
  "Mottatt", "Referanse", "Status", "Selger", "Kontakt", "Adresse", "Postnr", "Poststed",
  "Under 18", "Foresatt", "Foresatt kontakt", "Oppgjør", "Sats", "Antall kort",
  "Estimert sum (kr)", "Alternativ sum (kr)", "USD/NOK", "Prisdato", "Kommentar"
];
// Kolonner som legges til automatisk når de trengs (også i regneark laget med eldre versjon)
const OFFER_EXTRA = ["Endelig sum (kr)", "Endelig tilbud sendt", "Token", "Signert av", "Signert tidspunkt", "Utbetaling til", "Kjøpsbevis"];
const CARD_HEADERS = [
  "Mottatt", "Referanse", "Varenr", "Kort", "Sett", "Nummer", "Variant", "Tilstand",
  "Antall", "Markedspris (USD)", "Pris/stk (kr)", "Sum (kr)", "TCGPlayer-ID", "Status"
];

/* ======================================================================
   1. Mottak av tilbud fra portalen
   ====================================================================== */

function doPost(e) {
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || "{}");
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
      const rows = d.lines.map((l) => [
        now, d.ref, l.nr, l.name, l.set, l.number, l.variant, l.cond,
        l.qty, l.usd, l.each, l.sum, l.tcgId, "Ny"
      ].map(safe_));
      if (rows.length) cards.getRange(cards.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
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

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("PokéNordic")
    .addItem("Send endelig tilbud for valgt tilbud", "sendFinalOffer")
    .addItem("Merk valgt tilbud som betalt", "markPaid")
    .addSeparator()
    .addItem("Slik fungerer det", "showHelp")
    .addToUi();
}

function showHelp() {
  SpreadsheetApp.getUi().alert(
    "Slik sender du endelig tilbud",
    "1. Kontroller kortene.\n" +
    "2. I fanen «Kort»: rett Tilstand, Antall og Pris/stk (kr) for referansen der det trengs. " +
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

  const answer = ui.alert(
    "Send endelig tilbud #" + offer.ref + "?",
    offer.name + " (" + offer.contact + ")\n" +
    lines.length + " linjer · " + offer.mode + "\n" +
    "Estimert: " + kr_(offer.estimate) + "\nEndelig: " + kr_(total) + "\n\n" +
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
  ui.alert("Tilbud #" + offer.ref + " er merket som betalt.");
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
    token: String(g("Token") || ""), received: g("Mottatt")
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
    out.push({
      nr: String(g("Varenr")), name: String(g("Kort")), set: String(g("Sett")), number: String(g("Nummer")),
      variant: String(g("Variant")), cond: String(g("Tilstand")), qty: qty, each: each, sum: sum,
      bulk: String(g("Variant")) === "per kg"
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
  const rows = d.lines.map((l) =>
    "<tr><td " + td + "><code>" + esc_(l.nr) + "</code></td><td " + td + ">" + esc_(l.name) + "<br><small>" + esc_(l.set) + " · " + esc_(l.number) + " · " + esc_(l.variant) +
    "</small></td><td " + td + ">" + esc_(l.cond) + "</td><td " + tdr + ">" + esc_(l.variant === "per kg" ? String(l.qty).replace(".", ",") + " kg" : l.qty) +
    "</td><td " + tdr + ">" + kr_(l.each) + (l.variant === "per kg" ? "/kg" : "") + "</td><td " + tdr + ">" + kr_(l.sum) + "</td></tr>"
  ).join("");
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
  const closing = forOwner ? "" : "<p>Har du spørsmål, er det bare å svare på denne e-posten.</p><p>Med vennlig hilsen<br>PokéNordic</p>";
  const sellerBlock = forOwner
    ? "<p><b>Selger:</b> " + esc_(s.name) + "<br>" + esc_(s.street) + ", " + esc_(s.zip) + " " + esc_(s.city) + "<br>" + esc_(s.contact) +
      (s.minor ? "<br><b>Under 18 år.</b> Foresatt: " + esc_(s.guardianName) + " – " + esc_(s.guardianContact) : "<br>18 år eller eldre") + "</p>"
    : "";
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">' + intro + sellerBlock +
    "<p><b>Oppgjør:</b> " + esc_(d.modeName) + " (" + Math.round(d.rate * 100) + " % av markedspris)</p>" +
    '<table style="border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left"><th ' + td + ">Varenr.</th><th " + td + ">Kort</th><th " + td +
    ">Tilstand</th><th " + tdr + ">Antall</th><th " + tdr + ">Pris/stk</th><th " + tdr + ">Sum</th></tr></thead><tbody>" + rows + "</tbody></table>" +
    "<p><b>" + esc_(d.countText || d.count + " kort") + " · Estimert sum " + kr_(d.total) + "</b>" + (forOwner ? " (alternativt " + kr_(d.altTotal) + ")" : "") + "</p>" +
    (s.note ? "<p><b>Kommentar:</b> " + esc_(s.note) + "</p>" : "") + closing +
    '<p style="color:#666;font-size:12px">Priser: TCGPlayer Market Price ' + esc_(d.pricesDate) + ", 1 USD = " + esc_(d.usdNok) + " NOK.</p></div>";
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
