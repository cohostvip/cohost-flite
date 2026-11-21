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

// ---- Text: Flite descriptions are HTML; Cohost keeps a plain-text version.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#") && lower !== "#39") return String.fromCodePoint(Number(lower.slice(1)));
      return ENTITIES[lower] ?? entity;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function textToHtml(text: string): string {
  return text.trim().split(/\n{2,}/).filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
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
