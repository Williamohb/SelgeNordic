/**
 * PokéNordic innkjøp – mottak av tilbud fra portalen.
 *
 * Lagrer hvert tilbud i dette regnearket (fanene «Tilbud» og «Kort») og
 * sender tilbudet på e-post til OWNER_EMAIL.
 *
 * Oppsett: se README.md i prosjektet, avsnittet «Automatisk innsending».
 */

// ======== INNSTILLINGER ========
const OWNER_EMAIL = "kundeservice@pokenordic.no";  // her kommer tilbudene
const SEND_SELLER_COPY = false;  // true = selgeren får en kopi på e-post (sendes fra Google-kontoen din)
const SENDER_NAME = "PokéNordic innkjøp";
// ===============================

const OFFER_HEADERS = [
  "Mottatt", "Referanse", "Status", "Selger", "Kontakt", "Adresse", "Postnr", "Poststed",
  "Under 18", "Foresatt", "Foresatt kontakt", "Oppgjør", "Sats", "Antall kort",
  "Estimert sum (kr)", "Alternativ sum (kr)", "USD/NOK", "Prisdato", "Kommentar"
];
const CARD_HEADERS = [
  "Mottatt", "Referanse", "Varenr", "Kort", "Sett", "Nummer", "Variant", "Tilstand",
  "Antall", "Markedspris (USD)", "Pris/stk (kr)", "Sum (kr)", "TCGPlayer-ID", "Status"
];

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
        now, d.ref, "Ny", s.name, s.contact, s.street, s.zip, s.city,
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

    MailApp.sendEmail({
      to: OWNER_EMAIL,
      subject: "Nytt tilbud #" + d.ref + " – " + d.seller.name + " – " + kr_(d.total) + " (" + d.modeName.toLowerCase() + ")",
      htmlBody: mailHtml_(d, true),
      replyTo: isEmail_(d.seller.contact) ? d.seller.contact : OWNER_EMAIL,
      name: SENDER_NAME
    });
    if (SEND_SELLER_COPY && isEmail_(d.seller.contact)) {
      MailApp.sendEmail({
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

function doGet() {
  return json_({ ok: true, service: "PokéNordic innkjøp" });
}

/* ---------- hjelpefunksjoner ---------- */

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

function mailHtml_(d, forOwner) {
  const s = d.seller;
  const td = 'style="padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top"';
  const tdr = 'style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right;white-space:nowrap"';
  const rows = d.lines.map((l) =>
    "<tr><td " + td + "><code>" + esc_(l.nr) + "</code></td><td " + td + ">" + esc_(l.name) + "<br><small>" + esc_(l.set) + " · " + esc_(l.number) + " · " + esc_(l.variant) +
    "</small></td><td " + td + ">" + esc_(l.cond) + "</td><td " + tdr + ">" + esc_(l.qty) + "</td><td " + tdr + ">" + kr_(l.each) + "</td><td " + tdr + ">" + kr_(l.sum) + "</td></tr>"
  ).join("");
  const intro = forOwner
    ? "<p><b>Nytt tilbud #" + esc_(d.ref) + "</b> fra innkjøpsportalen.</p>"
    : "<p>Hei " + esc_(s.name) + "!</p><p>Takk for tilbudet. Vi har mottatt det med referanse <b>#" + esc_(d.ref) + "</b> og tar kontakt med deg. Prisene under er foreløpige til vi har kontrollert kortene.</p>";
  const sellerBlock = forOwner
    ? "<p><b>Selger:</b> " + esc_(s.name) + "<br>" + esc_(s.street) + ", " + esc_(s.zip) + " " + esc_(s.city) + "<br>" + esc_(s.contact) +
      (s.minor ? "<br><b>Under 18 år.</b> Foresatt: " + esc_(s.guardianName) + " – " + esc_(s.guardianContact) : "<br>18 år eller eldre") + "</p>"
    : "";
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">' + intro + sellerBlock +
    "<p><b>Oppgjør:</b> " + esc_(d.modeName) + " (" + Math.round(d.rate * 100) + " % av markedspris)</p>" +
    '<table style="border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left"><th ' + td + ">Varenr.</th><th " + td + ">Kort</th><th " + td +
    ">Tilstand</th><th " + tdr + ">Antall</th><th " + tdr + ">Pris/stk</th><th " + tdr + ">Sum</th></tr></thead><tbody>" + rows + "</tbody></table>" +
    "<p><b>" + esc_(d.countText || d.count + " kort") + " · Estimert sum " + kr_(d.total) + "</b>" + (forOwner ? " (alternativt " + kr_(d.altTotal) + ")" : "") + "</p>" +
    (s.note ? "<p><b>Kommentar:</b> " + esc_(s.note) + "</p>" : "") +
    '<p style="color:#666;font-size:12px">Priser: TCGPlayer Market Price ' + esc_(d.pricesDate) + ", 1 USD = " + esc_(d.usdNok) + " NOK.</p></div>";
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
