import type { CurrencyAmount } from "./cohost-types.ts";

export const APP_SOURCE = "flite";
export const API_VERSION = "2025-04-15";

/** `value` as a plain object; `what` names it in the error ("Cohost data", "Flite data"). */
export function record<T = Record<string, unknown>>(value: unknown, what: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object`);
  return value as T;
}

/** The `meta.flite` block a Cohost record carries from its Flite import, or `{}`. */
export function fliteMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const flite = meta?.flite;
  return flite && typeof flite === "object" && !Array.isArray(flite) ? flite as Record<string, unknown> : {};
}

// ---- Money: Flite uses major units (12.5), Cohost uses "USD,1250".

export function toMinor(major: number, label = "Amount"): number {
  if (typeof major !== "number" || !Number.isFinite(major) || major < 0) {
    throw new Error(`${label} must be a nonnegative number`);
  }
  return Math.round(major * 100);
}

export function amount(currency: string, minor: number): CurrencyAmount {
  return `${currency},${minor}`;
}

export function parseAmount(value: unknown, label = "Amount"): { currency: string; minor: number } {
  const match = typeof value === "string" ? /^([A-Za-z]{3}),(\d+)$/.exec(value) : null;
  if (!match) throw new Error(`${label} must look like USD,1234`);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(minor)) throw new Error(`${label} exceeds the safe integer range`);
  return { currency: match[1].toUpperCase(), minor };
}

export const toMajor = (minor: number) => minor / 100;

/** Flite returns lower-case currency codes ("usd"); Cohost uses upper case. */
export function cohostCurrency(value?: string | null, fallback = "USD"): string {
  const currency = (value || fallback).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Invalid currency code: ${value}`);
  return currency;
}

// ---- Time: Flite stores local date + time + IANA zone; Cohost stores UTC instants + zone.

function zoneParts(tz: string, utcMs: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function offsetMs(tz: string, utcMs: number): number {
  const p = zoneParts(tz, utcMs);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** `2027-04-09` + `22:00` in `America/New_York` → `2027-04-10T02:00:00.000Z`. */
export function zonedToUtc(date: string, time: string, tz: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d) throw new Error(`Date must be YYYY-MM-DD: ${date}`);
  if (!t) throw new Error(`Time must be HH:mm: ${time}`);
  const naive = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  // Two passes settle the offset across DST transitions.
  const first = naive - offsetMs(tz, naive);
  const second = naive - offsetMs(tz, first);
  const local = utcToZoned(new Date(second).toISOString(), tz);
  // A time skipped by spring-forward (02:30 on that day) has no instant: move it forward by the
  // gap, as Temporal's "compatible" disambiguation does. 02:30 EST-skipped → 03:30 EDT.
  const utc = local.date === date && local.time === time ? second : Math.max(first, second);
  return new Date(utc).toISOString();
}

export function utcToZoned(iso: string, tz: string): { date: string; time: string } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO date: ${iso}`);
  const p = zoneParts(tz, ms);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// ---- Text. Flite renders an event description as HTML, but a ticket description as plain text
// (HTML appears as literal tags): events get cleaned HTML, tickets plain text.

/** HTML 4 named entities (the set rich-text editors such as TinyMCE write): name → hex code point. */
const NAMED_ENTITIES: Record<string, string> = Object.fromEntries(
  (
    "AElig:c6 Aacute:c1 Acirc:c2 Agrave:c0 Alpha:391 Aring:c5 Atilde:c3 Auml:c4 Beta:392 " +
    "Ccedil:c7 Chi:3a7 Dagger:2021 Delta:394 ETH:d0 Eacute:c9 Ecirc:ca Egrave:c8 Epsilon:395 " +
    "Eta:397 Euml:cb Gamma:393 Iacute:cd Icirc:ce Igrave:cc Iota:399 Iuml:cf Kappa:39a Lambda:39b " +
    "Mu:39c Ntilde:d1 Nu:39d OElig:152 Oacute:d3 Ocirc:d4 Ograve:d2 Omega:3a9 Omicron:39f " +
    "Oslash:d8 Otilde:d5 Ouml:d6 Phi:3a6 Pi:3a0 Prime:2033 Psi:3a8 Rho:3a1 Scaron:160 Sigma:3a3 " +
    "THORN:de Tau:3a4 Theta:398 Uacute:da Ucirc:db Ugrave:d9 Upsilon:3a5 Uuml:dc Xi:39e Yacute:dd " +
    "Yuml:178 Zeta:396 aacute:e1 acirc:e2 acute:b4 aelig:e6 agrave:e0 alefsym:2135 alpha:3b1 " +
    "amp:26 and:2227 ang:2220 aring:e5 asymp:2248 atilde:e3 auml:e4 bdquo:201e beta:3b2 brvbar:a6 " +
    "bull:2022 cap:2229 ccedil:e7 cedil:b8 cent:a2 chi:3c7 circ:2c6 clubs:2663 cong:2245 copy:a9 " +
    "crarr:21b5 cup:222a curren:a4 dArr:21d3 dagger:2020 darr:2193 deg:b0 delta:3b4 diams:2666 " +
    "divide:f7 eacute:e9 ecirc:ea egrave:e8 empty:2205 emsp:2003 ensp:2002 epsilon:3b5 equiv:2261 " +
    "eta:3b7 eth:f0 euml:eb euro:20ac exist:2203 fnof:192 forall:2200 frac12:bd frac14:bc " +
    "frac34:be frasl:2044 gamma:3b3 ge:2265 gt:3e hArr:21d4 harr:2194 hearts:2665 hellip:2026 " +
    "iacute:ed icirc:ee iexcl:a1 igrave:ec image:2111 infin:221e int:222b iota:3b9 iquest:bf " +
    "isin:2208 iuml:ef kappa:3ba lArr:21d0 lambda:3bb lang:2329 laquo:ab larr:2190 lceil:2308 " +
    "ldquo:201c le:2264 lfloor:230a lowast:2217 loz:25ca lrm:200e lsaquo:2039 lsquo:2018 lt:3c " +
    "macr:af mdash:2014 micro:b5 middot:b7 minus:2212 mu:3bc nabla:2207 nbsp:a0 ndash:2013 " +
    "ne:2260 ni:220b not:ac notin:2209 nsub:2284 ntilde:f1 nu:3bd oacute:f3 ocirc:f4 oelig:153 " +
    "ograve:f2 oline:203e omega:3c9 omicron:3bf oplus:2295 or:2228 ordf:aa ordm:ba oslash:f8 " +
    "otilde:f5 otimes:2297 ouml:f6 para:b6 part:2202 permil:2030 perp:22a5 phi:3c6 pi:3c0 piv:3d6 " +
    "plusmn:b1 pound:a3 prime:2032 prod:220f prop:221d psi:3c8 quot:22 rArr:21d2 radic:221a " +
    "rang:232a raquo:bb rarr:2192 rceil:2309 rdquo:201d real:211c reg:ae rfloor:230b rho:3c1 " +
    "rlm:200f rsaquo:203a rsquo:2019 sbquo:201a scaron:161 sdot:22c5 sect:a7 shy:ad sigma:3c3 " +
    "sigmaf:3c2 sim:223c spades:2660 sub:2282 sube:2286 sum:2211 sup:2283 sup1:b9 sup2:b2 sup3:b3 " +
    "supe:2287 szlig:df tau:3c4 there4:2234 theta:3b8 thetasym:3d1 thinsp:2009 thorn:fe tilde:2dc " +
    "times:d7 trade:2122 uArr:21d1 uacute:fa uarr:2191 ucirc:fb ugrave:f9 uml:a8 upsih:3d2 " +
    "upsilon:3c5 uuml:fc weierp:2118 xi:3be yacute:fd yen:a5 yuml:ff zeta:3b6 zwj:200d zwnj:200c"
  ).split(" ").map((pair) => {
    const [name, hex] = pair.split(":");
    return [name, String.fromCodePoint(parseInt(hex, 16))];
  }),
);
NAMED_ENTITIES.apos = "'";

/** Decodes named (exact case, then lower case) and numeric entities; an unknown one stays as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      const valid = point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff);
      return valid ? String.fromCodePoint(point) : entity;
    }
    return NAMED_ENTITIES[code] ?? NAMED_ENTITIES[code.toLowerCase()] ?? entity;
  });
}

/** Non-breaking spaces become spaces, runs of spaces collapse, lines are trimmed, at most one blank line in a row. */
function tidy(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n").map((line) => line.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BLOCK_TAGS = new Set([
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "article", "header", "footer",
    "aside", "nav", "main", "table", "thead", "tbody", "tfoot", "tr", "pre", "hr", "address", "figure",
    "figcaption", "dl", "dt", "dd",
]);

/**
 * HTML → plain text: block elements become paragraphs, `<br>` a line break, list items `• ` lines
 * (`1. ` in an ordered list; a block inside an item stays on the item's line), all entities decoded.
 * Source whitespace is collapsed as a browser would.
 */
export function htmlToText(html: string): string {
  const source = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\s+/g, " ");
  const lists: Array<{ ordered: boolean; count: number }> = [];
  let out = "";
  let last = 0;
  for (const match of source.matchAll(/<\s*(\/?)\s*([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    out += source.slice(last, match.index);
    last = match.index + match[0].length;
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (name === "br") {
      out += "\n";
    } else if (name === "li") {
      const list = lists.at(-1);
      if (!closing) out += `\n${list?.ordered ? `${++list.count}.` : "•"} `;
    } else if (name === "ul" || name === "ol") {
      if (closing) lists.pop();
      else lists.push({ ordered: name === "ol", count: 0 });
      // Only the outermost list is set off as its own paragraph; nested items are plain lines.
      if (closing ? lists.length === 0 : lists.length === 1) out += "\n\n";
    } else if (BLOCK_TAGS.has(name)) {
      out += lists.length ? " " : "\n\n";
    } else if ((name === "td" || name === "th") && closing) {
      out += " ";
    }
  }
  out += source.slice(last);
  return tidy(decodeEntities(out.replace(/<\/?[a-z][^>]*>/gi, "")));
}

/** A real HTML tag (not text like `<ID>` or `<3`): only these mark a value as HTML. */
const HAS_TAG = new RegExp(
  "<\\/?(?:p|br|div|span|ul|ol|li|h[1-6]|strong|b|em|i|u|s|a|blockquote|table|thead|tbody|tr|td|th|img|hr|" +
    "section|article|pre|code|sub|sup|del|ins|mark|small|font|figure|figcaption|dl|dt|dd)\\b[^>]*>",
  "i",
);

/** Any Cohost or Flite text field → plain text: HTML is parsed; plain text keeps its line breaks. */
export function toPlainText(value: string): string {
  if (HAS_TAG.test(value)) return htmlToText(value);
  return tidy(decodeEntities(value.replace(/\r\n?/g, "\n")));
}

export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text → HTML: blank lines separate paragraphs, a single line break becomes `<br>`. */
export function textToHtml(text: string): string {
  return text.trim().split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
}

/** Tags kept (without attributes) in an event description; any other tag is unwrapped. */
const KEEP_TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "sub", "sup", "ul", "ol",
  "li", "blockquote", "div", "section", "article", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "hr",
  "pre", "code",
]);
const BLOCK_EDGE = /[ \t\r\n\f]*(<\/?(?:p|br|h[1-6]|ul|ol|li|blockquote|div|section|article|table|thead|tbody|tfoot|tr|td|th|hr|pre)>)[ \t\r\n\f]*/g;
const EMPTY_ELEMENT = /<(p|h[1-6]|li|ul|ol|blockquote|div|section|article|strong|b|em|i|u|s)>(?:\s|&nbsp;|&#160;|&#xa0;|<br>)*<\/\1>/gi;

/**
 * Rich-text editor HTML → the HTML sent to Flite: attributes are removed (a link keeps an http(s),
 * mailto or tel `href`), other tags such as `span` are unwrapped, scripts, styles and comments
 * dropped, empty paragraphs removed, and whitespace between block tags removed (Flite shows the
 * description with `white-space: pre-wrap`, so source line breaks would show). Entities stay as written.
 */
export function cleanHtml(html: string): string {
  const links: string[] = [];
  let out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|template|iframe|object|embed|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string) => {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = href ? decodeEntities(href[1] ?? href[2] ?? href[3]).trim() : "";
      if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) return inner;
      links.push(url);
      return `\u0001${links.length - 1}\u0002${inner}\u0001/\u0002`;
    })
    .replace(/<\s*(\/?)\s*([a-z][a-z0-9]*)\b[^>]*>/gi, (_, close: string, raw: string) => {
      const name = raw.toLowerCase();
      if (!KEEP_TAGS.has(name)) return "";
      if (name === "br" || name === "hr") return close ? "" : `<${name}>`;
      return `<${close}${name}>`;
    })
    .replace(/\u0001(\d+)\u0002/g, (_, i: string) => `<a href="${escapeHtml(links[Number(i)])}">`)
    .replace(/\u0001\/\u0002/g, "</a>")
    .replace(/[ \t\r\n\f]+/g, " ")
    .replace(BLOCK_EDGE, "$1");
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(EMPTY_ELEMENT, "");
  }
  return out.replace(/^(?:<br>)+|(?:<br>)+$/g, "").trim();
}

/** Any Cohost or Flite text field → event-description HTML: HTML is cleaned, plain text becomes paragraphs. */
export function toHtml(value: string): string {
  return HAS_TAG.test(value) ? cleanHtml(value) : textToHtml(toPlainText(value));
}

/** The longest description the Flite app accepts on create and update (`text()` in packages/flite/lib/fields.ts). */
export const FLITE_TEXT_MAX = 5000;

/** At most `max` characters: cut at the last paragraph or word break that keeps most of the text, then "…". */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const floor = Math.floor(max * 0.6);
  const paragraph = head.lastIndexOf("\n\n");
  const space = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  const cut = paragraph >= floor ? paragraph : space >= floor ? space : head.length;
  return `${head.slice(0, cut).trimEnd()}…`;
}

/**
 * HTML parts (blocks) joined in order, leaving out any that would pass `max`. When the first part
 * alone is too long it becomes plain-text paragraphs, clipped at a word break to fit.
 */
export function fitHtml(parts: string[], max: number): string {
  let html = "";
  for (const part of parts) {
    if (html.length + part.length <= max) html += part;
    else if (!html) html = clipHtml(part, max);
  }
  return html;
}

function clipHtml(html: string, max: number): string {
  const text = toPlainText(html);
  for (let budget = max; budget > 20; budget = Math.floor(budget * 0.9)) {
    const out = textToHtml(clipText(text, budget));
    if (out.length <= max) return out;
  }
  return "";
}

export function summarize(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ---- US states: Flite uses full names ("New York"); Cohost addresses use codes ("NY").

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};
const CODES = Object.fromEntries(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]));

/** "New York" → "NY"; unknown regions are upper-cased as Cohost's schema does. */
export const stateCode = (name: string) => CODES[name.trim().toLowerCase()] ?? name.trim().toUpperCase();
/** "NY" → "New York"; anything else is returned as given. */
export const stateName = (code: string) => STATES[code.trim().toUpperCase()] ?? code.trim();

// ---- IDs: accept a bare Flite ID or a source URN ending in /<resource>/<id>.

export function idFrom(value: unknown, resource: "events" | "tickets" | "orders"): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (!value.startsWith("urn:")) return value.trim();
  return new RegExp(`/${resource}/([^/?#]+)`).exec(value)?.[1];
}
